import { FailoverManager } from './FailoverManager';
import { MetricsEngine } from './MetricsEngine';
import {
  NodeClient,
  NodeError,
  NodeErrorKind,
  NodeId,
  OrchestratorEvent,
  OrchestratorState,
  StreamChunk,
} from './types';

/**
 * Orchestrator — the core state machine that drives the logical stream.
 *
 * Responsibilities:
 *   1. Open a stream against the best-ranked node.
 *   2. Forward chunks to the consumer, but only ever in strictly increasing
 *      `index` order, never duplicate, never skip.
 *   3. On node error or stall, abort the failed stream and switch to the
 *      next-best node, resuming at `lastCommittedIndex + 1`.
 *   4. Record TTFT and per-chunk timing into the MetricsEngine.
 *   5. Emit structured events for the log/UI layer.
 *
 * Why this design:
 *
 *   • Offset-based resume (not text-level dedup) makes correctness a property
 *     of the protocol, not of heuristics. The orchestrator only commits a
 *     chunk if `chunk.index === expectedNext`; anything else is rejected. A
 *     compliant node CANNOT cause a duplicate or gap; a non-compliant node
 *     surfaces a hard error rather than corrupting the stream silently.
 *
 *   • Adaptive timeout via FailoverManager's latency p95 means we don't kill
 *     slow-but-alive nodes too aggressively, and we don't wait forever on
 *     ones that have actually stalled.
 *
 *   • AbortController per attempt: failover always aborts the in-flight
 *     stream before opening the next. This is what prevents a "zombie"
 *     generator from delivering a late chunk after we've already moved on.
 *
 *   • The orchestrator never touches React/Zustand directly. It exposes an
 *     `onEvent` callback; the store subscribes to it.
 */

export interface OrchestratorConfig {
  nodes: readonly NodeClient[];
  maxAttempts: number;
  /** Floor for adaptive timeout in ms. */
  minChunkTimeoutMs: number;
  /** Multiplier on rolling p95 latency for chunk-stall timeout. */
  timeoutMultiplier: number;
  /** Absolute ceiling for chunk-stall timeout in ms. */
  maxChunkTimeoutMs: number;
  failover?: FailoverManager;
  metrics?: MetricsEngine;
  onEvent?: (e: OrchestratorEvent) => void;
}

const DEFAULTS = {
  maxAttempts: 6,
  minChunkTimeoutMs: 600,
  timeoutMultiplier: 3,
  maxChunkTimeoutMs: 2500,
} as const;

export class Orchestrator {
  private state: OrchestratorState = 'idle';
  private readonly nodesById: Map<NodeId, NodeClient>;
  private readonly cfg: OrchestratorConfig;
  readonly failover: FailoverManager;
  readonly metrics: MetricsEngine;

  /** Highest `index` we have already committed; -1 means none yet. */
  private lastCommittedIndex = -1;
  /** Cancellation handle for the in-flight attempt. */
  private currentAbort: AbortController | null = null;
  /** Run-scoped flag flipped by `stop()` to short-circuit retries. */
  private cancelled = false;

  constructor(cfg: Partial<OrchestratorConfig> & { nodes: readonly NodeClient[] }) {
    this.cfg = { ...DEFAULTS, ...cfg } as OrchestratorConfig;
    this.nodesById = new Map(cfg.nodes.map((n) => [n.id, n] as const));
    this.failover =
      cfg.failover ??
      new FailoverManager(cfg.nodes.map((n) => n.id) as NodeId[]);
    this.metrics = cfg.metrics ?? new MetricsEngine();
  }

  getState(): OrchestratorState {
    return this.state;
  }

  /** Begin streaming. Resolves when the logical stream terminates (done or failed). */
  async run(prompt: string): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'done' && this.state !== 'failed') {
      throw new Error(`Orchestrator.run called in state=${this.state}`);
    }
    this.reset();
    this.emit({ type: 'start', prompt });
    this.transition('connecting');
    this.metrics.markStart();

    let attempt = 0;
    let excludeRecent: NodeId | null = null;
    let lastError: string = 'no attempts made';

    while (attempt < this.cfg.maxAttempts && !this.cancelled) {
      const nodeId = this.failover.pick(excludeRecent);
      if (nodeId === null) {
        // No eligible node — wait for the soonest circuit cooldown.
        // Do NOT burn an attempt here; sleeping is not a real attempt.
        await this.sleepUntilNextCooldown();
        continue;
      }

      const node = this.nodesById.get(nodeId)!;
      attempt++;

      try {
        await this.runAttempt(node);
        // Successful completion — `runAttempt` will transition to `done`.
        return;
      } catch (err) {
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
  stop(): void {
    this.cancelled = true;
    this.currentAbort?.abort();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async runAttempt(node: NodeClient): Promise<void> {
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
        if (next.done) break;
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
    } finally {
      this.currentAbort = null;
      // Ensure the underlying generator is closed (releases timers, etc.).
      abort.abort();
      // Best-effort: drain to allow `finally` blocks in the generator to run.
      try {
        await iter.return?.(undefined);
      } catch {
        /* ignore */
      }
    }
  }

  private chunkTimeoutForNode(nodeId: NodeId): number {
    const h = this.failover.getHealth(nodeId);
    const adaptive = h.latencyP95Ms * this.cfg.timeoutMultiplier;
    return Math.min(
      this.cfg.maxChunkTimeoutMs,
      Math.max(this.cfg.minChunkTimeoutMs, adaptive || this.cfg.minChunkTimeoutMs),
    );
  }

  private allOthersOpen(except: NodeId): boolean {
    const now = performance.now();
    for (const h of this.failover.getAllHealth()) {
      if (h.nodeId === except) continue;
      if (h.circuit !== 'open' || now >= h.cooldownUntil) return false;
    }
    return true;
  }

  private async sleepUntilNextCooldown(): Promise<void> {
    const now = performance.now();
    const next = Math.min(
      ...this.failover.getAllHealth().map((h) => h.cooldownUntil || Infinity),
    );
    const wait = Math.max(50, Math.min(2000, next - now));
    await sleep(Number.isFinite(wait) ? wait : 200);
  }

  private reset(): void {
    this.lastCommittedIndex = -1;
    this.currentAbort = null;
    this.cancelled = false;
    this.metrics.reset();
    this.failover.reset();
  }

  private transition(to: OrchestratorState): void {
    if (to === this.state) return;
    const from = this.state;
    this.state = to;
    this.emit({ type: 'state', from, to });
  }

  private emit(e: OrchestratorEvent): void {
    this.cfg.onEvent?.(e);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Race an iterator advance against a timeout. On timeout, abort the controller
 * (which the simulator listens to) and throw a `NodeError({kind:'timeout'})`.
 * The nodeId is passed explicitly so the error carries the correct node from
 * the start — no patching needed in the catch clause.
 */
async function raceWithTimeout<T>(
  p: Promise<T>,
  ms: number,
  abort: AbortController,
  nodeId: NodeId,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new NodeError(nodeId, 'timeout'));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toNodeError(err: unknown, nodeId: NodeId): NodeError {
  if (err instanceof NodeError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const e = new NodeError(nodeId, 'drop');
  (e as { message: string }).message = `[${nodeId}] drop (unknown): ${message}`;
  return e;
}

/** Exposed for tests: the kinds the failover engine recognises. */
export const _allErrorKinds: NodeErrorKind[] = ['drop', 'rate-limit', 'timeout', 'abort'];
