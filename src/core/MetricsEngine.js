export class MetricsEngine {
    now;
    windowMs;
    startedAt = null;
    ttftMs = null;
    totalTokens = 0;
    /** Deque, oldest at head, newest at tail. */
    events = [];
    constructor(opts = {}) {
        this.now = opts.now ?? performance.now.bind(performance);
        this.windowMs = opts.windowMs ?? 1000;
    }
    /** Mark the user-visible start of the logical stream (before any node opens). */
    markStart() {
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
    recordTokens(tokenCount, at = this.now()) {
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
    snapshot() {
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
    evict(now) {
        const cutoff = now - this.windowMs;
        // Cheap O(k) eviction; deque rarely grows past a few hundred entries
        // for realistic streams (≤ a few thousand TPS * 1s).
        let i = 0;
        while (i < this.events.length && this.events[i].t < cutoff)
            i++;
        if (i > 0)
            this.events.splice(0, i);
    }
    /** Reset to idle (used between runs). */
    reset() {
        this.startedAt = null;
        this.ttftMs = null;
        this.totalTokens = 0;
        this.events = [];
    }
}
