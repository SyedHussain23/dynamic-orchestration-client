import { describe, expect, it } from 'vitest';
import { chance, mulberry32, randInt } from '../rng';
describe('mulberry32', () => {
    it('is deterministic for a given seed', () => {
        const a = mulberry32(42);
        const b = mulberry32(42);
        for (let i = 0; i < 100; i++)
            expect(a()).toBe(b());
    });
    it('produces values in [0, 1)', () => {
        const r = mulberry32(1);
        for (let i = 0; i < 1000; i++) {
            const v = r();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });
    it('randInt respects bounds', () => {
        const r = mulberry32(7);
        for (let i = 0; i < 1000; i++) {
            const v = randInt(r, -3, 3);
            expect(v).toBeGreaterThanOrEqual(-3);
            expect(v).toBeLessThanOrEqual(3);
            expect(Number.isInteger(v)).toBe(true);
        }
    });
    it('chance is roughly calibrated', () => {
        const r = mulberry32(9);
        let hits = 0;
        const n = 10_000;
        for (let i = 0; i < n; i++)
            if (chance(r, 0.3))
                hits++;
        expect(hits / n).toBeCloseTo(0.3, 1);
    });
});
