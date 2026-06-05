/**
 * Mulberry32 — small, fast, statistically-decent seeded PRNG.
 *
 * Used by the simulator so tests are deterministic. The orchestrator itself
 * uses no randomness; all jitter (backoff, etc.) takes an RNG injection so
 * the entire pipeline is reproducible from a single seed.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inclusive integer in [min, max]. */
export const randInt = (rng: Rng, min: number, max: number): number =>
  Math.floor(rng() * (max - min + 1)) + min;

/** True with probability p ∈ [0,1]. */
export const chance = (rng: Rng, p: number): boolean => rng() < p;
