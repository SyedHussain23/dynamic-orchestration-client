import { NodeError, } from '@/core/types';
import { chance, randInt } from '@/core/rng';
const FAULT_KINDS = ['drop', 'rate-limit', 'latency-spike'];
export class SimulatedStreamNode {
    id;
    cfg;
    constructor(cfg) {
        this.id = cfg.id;
        this.cfg = cfg;
    }
    async *stream(args) {
        const { resumeFrom, signal } = args;
        const { corpus, meanChunkMs, jitterMs, faultProbability, rng } = this.cfg;
        if (resumeFrom < 0 || resumeFrom > corpus.length) {
            throw new RangeError(`[${this.id}] invalid resumeFrom=${resumeFrom}, corpus length=${corpus.length}`);
        }
        // Pre-roll fault plan so behavior is deterministic for the seed.
        const willFault = chance(rng, faultProbability);
        const faultKind = willFault
            ? FAULT_KINDS[randInt(rng, 0, FAULT_KINDS.length - 1)]
            : null;
        // Fault triggers at some index between resumeFrom and end-of-stream.
        const remaining = corpus.length - resumeFrom;
        const faultAt = willFault && remaining > 0
            ? resumeFrom + randInt(rng, 0, Math.max(0, remaining - 1))
            : -1;
        for (let i = resumeFrom; i < corpus.length; i++) {
            if (signal.aborted) {
                throw new NodeError(this.id, 'abort');
            }
            // Per-chunk wait.
            const baseDelay = meanChunkMs + randInt(rng, -jitterMs, jitterMs);
            let delay = Math.max(1, baseDelay);
            // Latency spike: stall *before* yielding the fault-index chunk.
            if (i === faultAt && faultKind === 'latency-spike') {
                delay += 1500 + randInt(rng, 0, 1500); // 1.5s–3s stall
            }
            await sleep(delay, signal);
            // After waiting, check abort again — covers signal that fired mid-sleep.
            if (signal.aborted) {
                throw new NodeError(this.id, 'abort');
            }
            // Hard faults: throw at the trigger index, BEFORE emitting that chunk.
            // This is the "node dies mid-stream" case the spec asks us to handle.
            if (i === faultAt) {
                if (faultKind === 'drop') {
                    throw new NodeError(this.id, 'drop');
                }
                if (faultKind === 'rate-limit') {
                    throw new NodeError(this.id, 'rate-limit', 250 + randInt(rng, 0, 750));
                }
                // 'latency-spike' already applied above — fall through and emit.
            }
            yield {
                index: i,
                text: corpus[i],
                emittedAt: performance.now(),
            };
        }
    }
}
/** Promise-based sleep that rejects (well, resolves early) on abort. */
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal.aborted)
            return resolve();
        const t = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
