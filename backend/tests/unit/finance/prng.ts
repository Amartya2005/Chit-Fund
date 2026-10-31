/** Deterministic PRNG (mulberry32) for property tests — no new dependency (D-31 not approved). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
  /** amount in rupees with paise, as a string */
  const amount = (loPaise: number, hiPaise: number) => (int(loPaise, hiPaise) / 100).toFixed(2);
  return { next, int, pick, amount };
}
export const SEEDS = [1, 7, 42, 1337, 20261031];
