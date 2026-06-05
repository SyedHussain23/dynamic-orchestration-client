import {
  NodeClient,
  NodeError,
  NodeId,
  StreamChunk,
} from '@/core/types';
import { Rng, chance, randInt } from '@/core/rng';

/**
 * A simulated streaming node.
 *
 * The simulator is intentionally a pure async-iterator implementation behind
 * the `NodeClient` interface — same shape the orchestrator would see from a
 * real SSE endpoint. This means:
 *
 *  - The orchestration code has *no* knowledge of simulation; swapping in a
 *    real client requires no orchestration changes.
 *  - Tests can drive the orchestrator with deterministic, seeded simulators
 *    and reproduce exact failure sequences.
 *
 * ── Failure-rate budget ────────────────────────────────────────────────────
 * The spec asks for ≈30% failure. We interpret that per-attempt, not per-token:
 * each open stream has ~30% probability of a fault occurring at some point
 * during its lifetime, and the fault kind is uniformly chosen among
 * {drop, rate-limit, latency-spike}. This keeps the failure rate meaningful
 * even on long streams (where per-token rates would compound to ~100%).
 *
 * The fault is rolled at open-time. Because the RNG is stateful, successive
 * calls to `stream()` on the same instance produce different fault plans —
 * behavior is deterministic only across *separate* node instances seeded
 * identically. In tests, create a fresh node per test case.
 */

export interface SimulatedNodeConfig {
  id: NodeId;
  /** Token corpus the node streams. */
  corpus: string[];
  /** Mean ms between chunks (baseline latency). */
  meanChunkMs: number;
  /** Jitter applied to meanChunkMs, ± this value. */
  jitterMs: number;
  /** Per-attempt probability of a fault occurring. */
  faultProbability: number;
  /** RNG to use (inject for determinism in tests). */
  rng: Rng;
}

const FAULT_KINDS = ['drop', 'rate-limit', 'latency-spike'] as const;

export class SimulatedStreamNode implements NodeClient {
  readonly id: NodeId;
  private readonly cfg: SimulatedNodeConfig;

  constructor(cfg: SimulatedNodeConfig) {
    this.id = cfg.id;
    this.cfg = cfg;
  }

  async *stream(args: {
    resumeFrom: number;
    signal: AbortSignal;
  }): AsyncIterable<StreamChunk> {
    const { resumeFrom, signal } = args;
    const { corpus, meanChunkMs, jitterMs, faultProbability, rng } = this.cfg;

    if (resumeFrom < 0 || resumeFrom > corpus.length) {
      throw new RangeError(
        `[${this.id}] invalid resumeFrom=${resumeFrom}, corpus length=${corpus.length}`,
      );
    }

    // Pre-roll fault plan so behavior is deterministic for the seed.
    const willFault = chance(rng, faultProbability);
    const faultKind = willFault
      ? FAULT_KINDS[randInt(rng, 0, FAULT_KINDS.length - 1)]
      : null;
    // Fault triggers at some index between resumeFrom and end-of-stream.
    const remaining = corpus.length - resumeFrom;
    const faultAt =
      willFault && remaining > 0
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
        text: corpus[i]!,
        emittedAt: performance.now(),
      };
    }
  }
}

/** Promise-based sleep that rejects (well, resolves early) on abort. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
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
