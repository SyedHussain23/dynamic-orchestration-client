import { FailoverManager } from './FailoverManager';
import { MetricsEngine } from './MetricsEngine';
import { NodeError, } from './types';
const DEFAULTS = {
    maxAttempts: 6,
    minChunkTimeoutMs: 600,
    timeoutMultiplier: 3,
    maxChunkTimeoutMs: 2500,
};
export class Orchestrator {
    state = 'idle';
    nodesById;
    cfg;
    failover;
    metrics;
    /** Highest `index` we have already committed; -1 means none yet. */
    lastCommittedIndex = -1;
    /** Cancellation handle for the in-flight attempt. */
    currentAbort = null;
    /** Run-scoped flag flipped by `stop()` to short-circuit retries. */
    cancelled = false;
    constructor(cfg) {
        this.cfg = { ...DEFAULTS, ...cfg };
        this.nodesById = new Map(cfg.nodes.map((n) => [n.id, n]));
        this.failover =
            cfg.failover ??
                new FailoverManager(cfg.nodes.map((n) => n.id));
        this.metrics = cfg.metrics ?? new MetricsEngine();
    }
    getState() {
        return this.state;
    }
    /** Begin streaming. Resolves when the logical stream terminates (done or failed). */
    async run(prompt) {
        if (this.state !== 'idle' && this.state !== 'done' && this.state !== 'failed') {
            throw new Error(`Orchestrator.run called in state=${this.state}`);
        }
        this.reset();
        this.emit({ type: 'start', prompt });
        this.transition('connecting');
        this.metrics.markStart();
        let attempt = 0;
        let excludeRecent = null;
        let lastError = 'no attempts made';
        while (attempt < this.cfg.maxAttempts && !this.cancelled) {
            const nodeId = this.failover.pick(excludeRecent);
            if (nodeId === null) {
                // No eligible node — wait for the soonest circuit cooldown.
                // Do NOT burn an attempt here; sleeping is not a real attempt.
                await this.sleepUntilNextCooldown();
                continue;
            }
            const node = this.nodesById.get(nodeId);
            attempt++;
            try {
                await this.runAttempt(node);
                // Successful completion — `runAttempt` will transition to `done`.
                return;
            }
            catch (err) {
                if (this.cancelled) {
                    // External stop — terminate the state machine cleanly.
                    this.transition('failed');
                    this.emit({ type: 'failed', reason: 'cancelled by stop()' });
                    return;
                }
                const nerr = toNodeError(err, nodeId);
                const { cooldownMs } = this.failover.reportFailure(nerr);
                this.emit({
                    type: 'node-error',
                    nodeId,
                    kind: nerr.kind,
                    retryAfterMs: nerr.retryAfterMs,
                });
                this.emit({ type: 'health', nodeId, health: this.failover.getHealth(nodeId) });
                lastError = `${nodeId} ${nerr.kind}`;
                excludeRecent = nodeId;
                const nextNodeId = this.failover.pick(excludeRecent);
                if (nextNodeId !== null && attempt < this.cfg.maxAttempts) {
                    this.transition('failing-over');
                    this.emit({
                        type: 'failover',
                        from: nodeId,
                        to: nextNodeId,
                        resumeFrom: this.lastCommittedIndex + 1,
                        reason: nerr.kind,
                    });
                    // Honor cooldown only if it's the *only* node available — otherwise
                    // we'd rather try a different node immediately.
                    if (this.allOthersOpen(nextNodeId)) {
                        await sleep(cooldownMs);
                    }
                }
            }
        }
        this.transition('failed');
        this.emit({ type: 'failed', reason: lastError });
    }
    /** Cancel an in-flight run. Idempotent. */
    stop() {
        this.cancelled = true;
        this.currentAbort?.abort();
    }
    // ── Internals ──────────────────────────────────────────────────────────────
    async runAttempt(node) {
        const abort = new AbortController();
        this.currentAbort = abort;
        const resumeFrom = this.lastCommittedIndex + 1;
        this.transition('streaming');
        const t0 = performance.now();
        let firstChunkOfAttempt = true;
        let lastChunkAt = t0;
        // Adaptive chunk-stall timeout watchdog. We `Promise.race` the iterator
        // with a timeout; if the timeout fires we abort and treat it as a node
        // error. This is what catches "latency-spike" faults.
        const iter = node.stream({ resumeFrom, signal: abort.signal })[Symbol.asyncIterator]();
        try {
            while (true) {
                const timeoutMs = this.chunkTimeoutForNode(node.id);
                const next = await raceWithTimeout(iter.next(), timeoutMs, abort, node.id);
                if (next.done)
                    break;
                const chunk = next.value;
                // Strict ordering: reject anything that isn't the next expected index.
                const expected = this.lastCommittedIndex + 1;
                if (chunk.index !== expected) {
                    // Compliant nodes never hit this. Treat as a hard error: abort and
                    // fail this attempt with a synthetic drop so failover kicks in.
                    throw new NodeError(node.id, 'drop');
                }
                const interChunkMs = firstChunkOfAttempt ? null : chunk.emittedAt - lastChunkAt;
                lastChunkAt = chunk.emittedAt;
                this.lastCommittedIndex = chunk.index;
                this.failover.reportChunk(node.id, interChunkMs);
                this.metrics.recordTokens(1, chunk.emittedAt);
                if (firstChunkOfAttempt) {
                    firstChunkOfAttempt = false;
                    this.emit({ type: 'connected', nodeId: node.id, nodeLatencyMs: chunk.emittedAt - t0 });
                }
                this.emit({ type: 'chunk', chunk, nodeId: node.id });
            }
            this.transition('done');
            this.emit({ type: 'done', nodeId: node.id });
        }
        finally {
            this.currentAbort = null;
            // Ensure the underlying generator is closed (releases timers, etc.).
            abort.abort();
            // Best-effort: drain to allow `finally` blocks in the generator to run.
            try {
                await iter.return?.(undefined);
            }
            catch {
                /* ignore */
            }
        }
    }
    chunkTimeoutForNode(nodeId) {
        const h = this.failover.getHealth(nodeId);
        const adaptive = h.latencyP95Ms * this.cfg.timeoutMultiplier;
        return Math.min(this.cfg.maxChunkTimeoutMs, Math.max(this.cfg.minChunkTimeoutMs, adaptive || this.cfg.minChunkTimeoutMs));
    }
    allOthersOpen(except) {
        const now = performance.now();
        for (const h of this.failover.getAllHealth()) {
            if (h.nodeId === except)
                continue;
            if (h.circuit !== 'open' || now >= h.cooldownUntil)
                return false;
        }
        return true;
    }
    async sleepUntilNextCooldown() {
        const now = performance.now();
        const next = Math.min(...this.failover.getAllHealth().map((h) => h.cooldownUntil || Infinity));
        const wait = Math.max(50, Math.min(2000, next - now));
        await sleep(Number.isFinite(wait) ? wait : 200);
    }
    reset() {
        this.lastCommittedIndex = -1;
        this.currentAbort = null;
        this.cancelled = false;
        this.metrics.reset();
        this.failover.reset();
    }
    transition(to) {
        if (to === this.state)
            return;
        const from = this.state;
        this.state = to;
        this.emit({ type: 'state', from, to });
    }
    emit(e) {
        this.cfg.onEvent?.(e);
    }
}
// ── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/**
 * Race an iterator advance against a timeout. On timeout, abort the controller
 * (which the simulator listens to) and throw a `NodeError({kind:'timeout'})`.
 * The nodeId is passed explicitly so the error carries the correct node from
 * the start — no patching needed in the catch clause.
 */
async function raceWithTimeout(p, ms, abort, nodeId) {
    let timer = null;
    try {
        return await Promise.race([
            p,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    abort.abort();
                    reject(new NodeError(nodeId, 'timeout'));
                }, ms);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function toNodeError(err, nodeId) {
    if (err instanceof NodeError)
        return err;
    const message = err instanceof Error ? err.message : String(err);
    const e = new NodeError(nodeId, 'drop');
    e.message = `[${nodeId}] drop (unknown): ${message}`;
    return e;
}
/** Exposed for tests: the kinds the failover engine recognises. */
export const _allErrorKinds = ['drop', 'rate-limit', 'timeout', 'abort'];
