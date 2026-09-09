// A seeded generator costs zero bytes and produces byte-identical output every run — which also
// means the eviction batch (US-006) always targets users that actually exist. See US-005.md.
//
// mulberry32 for a stream of floats; a separate integer avalanche hash for per-index decisions
// (variant count, plan, seats) so those do not depend on iteration order.

/** mulberry32 — a tiny, well-distributed 32-bit PRNG. Returns a function yielding floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Deterministic unsigned 32-bit hash of an integer, salted by the seed value. Order-independent:
 * `hashInt(i, seed)` is the same however many users came before `i`.
 */
export function hashInt(n: number, salt: number): number {
  let h = (Math.trunc(n) ^ Math.trunc(salt)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}
