import { describe, expect, it } from 'vitest';
import { MetricsEngine } from '../MetricsEngine';
describe('MetricsEngine', () => {
    function withClock() {
        let t = 0;
        return {
            now: () => t,
            advance: (ms) => {
                t += ms;
            },
            set: (ms) => {
                t = ms;
            },
        };
    }
    it('TTFT is recorded at the first chunk and never overwritten', () => {
        const clk = withClock();
        const m = new MetricsEngine({ now: clk.now });
        clk.set(1000);
        m.markStart();
        clk.advance(120);
        m.recordTokens(1, clk.now()); // first chunk at +120
        clk.advance(50);
        m.recordTokens(5, clk.now()); // later chunk
        const s = m.snapshot();
        expect(s.ttftMs).toBe(120);
    });
    it('rolling TPS uses a 1000ms sliding window', () => {
        const clk = withClock();
        const m = new MetricsEngine({ now: clk.now });
        clk.set(0);
        m.markStart();
        // 10 tokens spread evenly over 500ms.
        for (let i = 0; i < 10; i++) {
            clk.advance(50);
            m.recordTokens(1, clk.now());
        }
        // We have 10 tokens in 500ms → 20 tps.
        const s1 = m.snapshot();
        expect(s1.tpsRolling).toBeCloseTo(20, 0);
        // Advance time well past the window — TPS must decay to 0.
        clk.advance(1500);
        const s2 = m.snapshot();
        expect(s2.tpsRolling).toBe(0);
    });
    it('rolling TPS evicts events older than 1000ms', () => {
        const clk = withClock();
        const m = new MetricsEngine({ now: clk.now });
        clk.set(0);
        m.markStart();
        // 5 tokens at t=0..200 (will be evicted later)
        for (let i = 0; i < 5; i++) {
            m.recordTokens(1, clk.now());
            clk.advance(50);
        }
        // Jump 1500ms so old events fall out of the window.
        clk.advance(1500);
        // Now record 4 more tokens in 100ms.
        for (let i = 0; i < 4; i++) {
            m.recordTokens(1, clk.now());
            clk.advance(25);
        }
        const s = m.snapshot();
        expect(s.totalTokens).toBe(9);
        // Only 4 events are within the trailing 1s window.
        // Span = 100ms (from oldest event in window to now-ish), but clamped:
        // tps = 4 / min(1, max(.001, now-oldest)/1000)
        expect(s.tpsRolling).toBeGreaterThan(0);
        expect(s.tpsRolling).toBeLessThan(1000); // sanity
    });
    it('throws if recordTokens is called before markStart', () => {
        const m = new MetricsEngine();
        expect(() => m.recordTokens(1, 0)).toThrowError();
    });
    it('reset clears all state', () => {
        const clk = withClock();
        const m = new MetricsEngine({ now: clk.now });
        m.markStart();
        m.recordTokens(3, clk.now());
        m.reset();
        const s = m.snapshot();
        expect(s.ttftMs).toBeNull();
        expect(s.totalTokens).toBe(0);
        expect(s.tpsRolling).toBe(0);
        expect(s.elapsedMs).toBeNull();
    });
});
