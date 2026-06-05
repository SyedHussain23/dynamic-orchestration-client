export function mulberry32(seed) {
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
export const randInt = (rng, min, max) => Math.floor(rng() * (max - min + 1)) + min;
/** True with probability p ∈ [0,1]. */
export const chance = (rng, p) => rng() < p;
