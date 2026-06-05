import { MetricsSnapshot } from './types';

/**
 * MetricsEngine — TTFT and rolling-window TPS.
 *
 * Design notes:
 *
 *  • TTFT is captured ONCE, at the first chunk delivered to the consumer (i.e.
 *    the first chunk the orchestrator commits to the logical stream). It is
 *    *not* reset on failover — that would defeat its purpose as a user-visible
 *    latency metric. If the first attempt drops before yielding any token,
 *    TTFT is taken from the first chunk of the *successful* attempt; the user
 *    waited from `t0` regardless.
 *
 *  • TPS is a true sliding 1000ms window, not a moving average. We keep a
 *    deque of `(timestamp, tokens)` events. On every read we evict events
 *    older than `now - 1000ms` and sum the remaining `tokens` field, divided
 *    by `min(windowMs, now - startedAt)`. Using `startedAt` as the divisor
 *    floor means the early-stream rate (e.g. 10 tokens in 500ms = 20 tps) is
 *    accurate immediately, and converges to the true 1-second rate once we
 *    have ≥1s of history. This is O(1) amortized per emit and O(k) per
 *    read where k is the number of events in the last second.
 *
 *  • The engine takes a `now()` injection so tests can drive virtual time.
 *    In production we pass `performance.now`.
 *
 *  • The engine is *pure* — it owns no React or Zustand state and emits no
 *    events. The store reads snapshots from it on its rAF tick.
 */

type NowFn = () => number;

interface TpsEvent {
  t: number;
  tokens: number;
}

export class MetricsEngine {
  private readonly now: NowFn;
  private readonly windowMs: number;

  private startedAt: number | null = null;
  private ttftMs: number | null = null;
  private totalTokens = 0;
  /** Deque, oldest at head, newest at tail. */
  private events: TpsEvent[] = [];

  constructor(opts: { now?: NowFn; windowMs?: number } = {}) {
    this.now = opts.now ?? performance.now.bind(performance);
    this.windowMs = opts.windowMs ?? 1000;
  }

  /** Mark the user-visible start of the logical stream (before any node opens). */
  markStart(): void {
    this.startedAt = this.now();
    this.ttftMs = null;
    this.totalTokens = 0;
    this.events = [];
  }

  /**
   * Record `tokenCount` tokens committed at the given timestamp.
   * Pass the chunk's `emittedAt` (or `now()` if you don't have one) — using
   * the emit time keeps TPS honest under back-pressure.
   */
  recordTokens(tokenCount: number, at: number = this.now()): void {
    if (this.startedAt === null) {
      // Recording before markStart is a programmer error in this codebase.
      // Throwing makes the contract visible; in tests, we'd see it immediately.
      throw new Error('MetricsEngine.recordTokens before markStart');
    }
    if (this.ttftMs === null) {
      this.ttftMs = at - this.startedAt;
    }
    this.totalTokens += tokenCount;
    this.events.push({ t: at, tokens: tokenCount });
  }

  /** Snapshot the metrics. Cheap; safe to call on every rAF tick. */
  snapshot(): MetricsSnapshot {
    const now = this.now();
    this.evict(now);

    let tps = 0;
    if (this.events.length > 0 && this.startedAt !== null) {
      const tokensInWindow = this.events.reduce((s, e) => s + e.tokens, 0);
      // Divide by min(windowMs, time-since-start). Using `startedAt` (rather
      // than the oldest event still in the deque) is what makes the early-
      // stream value match the user-perceived rate: 10 tokens emitted in the
      // first 500ms should report as 20 tps, not 22.2 tps from the gap
      // between first and last event.
      const span = Math.min(this.windowMs, Math.max(1, now - this.startedAt));
      tps = (tokensInWindow * 1000) / span;
    }

    return {
      ttftMs: this.ttftMs,
      tpsRolling: tps,
      totalTokens: this.totalTokens,
      elapsedMs: this.startedAt === null ? null : now - this.startedAt,
    };
  }

  /** Drop events older than `now - windowMs`. */
  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    // Cheap O(k) eviction; deque rarely grows past a few hundred entries
    // for realistic streams (≤ a few thousand TPS * 1s).
    let i = 0;
    while (i < this.events.length && this.events[i]!.t < cutoff) i++;
    if (i > 0) this.events.splice(0, i);
  }

  /** Reset to idle (used between runs). */
  reset(): void {
    this.startedAt = null;
    this.ttftMs = null;
    this.totalTokens = 0;
    this.events = [];
  }
}
