import { describe, expect, it } from 'vitest';
import { FailoverManager } from '../FailoverManager';
import { NodeError } from '../types';
const IDS = ['node-a', 'node-b', 'node-c'];
function fm() {
    let t = 1000;
    const f = new FailoverManager(IDS, {
        failureThreshold: 2,
        baseCooldownMs: 100,
        maxCooldownMs: 1000,
        now: () => t,
    });
    return { f, set: (v) => (t = v), advance: (v) => (t += v) };
}
describe('FailoverManager', () => {
    it('picks node-a first when all healthy and equal', () => {
        const { f } = fm();
        expect(f.pick(null)).toBe('node-a');
    });
    it('excludes the recently-failed node', () => {
        const { f } = fm();
        expect(f.pick('node-a')).not.toBe('node-a');
    });
    it('opens the circuit after threshold failures', () => {
        const { f } = fm();
        f.reportFailure(new NodeError('node-a', 'drop'));
        expect(f.getHealth('node-a').circuit).toBe('closed'); // 1 < threshold
        f.reportFailure(new NodeError('node-a', 'drop'));
        expect(f.getHealth('node-a').circuit).toBe('open');
    });
    it('honors retryAfterMs from a 429', () => {
        const { f, set } = fm();
        set(5000);
        f.reportFailure(new NodeError('node-a', 'rate-limit', 750));
        const h = f.getHealth('node-a');
        expect(h.cooldownUntil).toBe(5750);
    });
    it('reportChunk closes a half-open circuit and resets failures', () => {
        const { f, advance } = fm();
        f.reportFailure(new NodeError('node-a', 'drop'));
        f.reportFailure(new NodeError('node-a', 'drop'));
        expect(f.getHealth('node-a').circuit).toBe('open');
        advance(200); // past cooldown
        // Successful chunk closes the circuit and resets counters.
        f.reportChunk('node-a', 30);
        expect(f.getHealth('node-a').circuit).toBe('closed');
        expect(f.getHealth('node-a').consecutiveFailures).toBe(0);
    });
    it('pick returns null when all circuits open and cooldowns active', () => {
        const { f } = fm();
        for (const id of IDS) {
            f.reportFailure(new NodeError(id, 'drop'));
            f.reportFailure(new NodeError(id, 'drop'));
        }
        expect(f.pick(null)).toBeNull();
    });
    it('selection prefers closed over half-open over open', () => {
        const { f } = fm();
        // Trip node-a open.
        f.reportFailure(new NodeError('node-a', 'drop'));
        f.reportFailure(new NodeError('node-a', 'drop'));
        expect(f.pick(null)).toBe('node-b');
    });
});
