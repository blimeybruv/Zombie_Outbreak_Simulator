// Seeded PRNG: sfc32, seeded from a 32-bit integer through splitmix32.
//
// The state is four uint32s in a plain object, so it serialises as data and a
// snapshot resumes the exact sequence. Every draw mutates the state passed in;
// there is no hidden instance. Runs use two independent generators — one for the
// map (mapSeed) and one for the simulation (runSeed) — so editing generator code
// never shifts the simulation's draws.

export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** Seeds a generator from any integer; only the low 32 bits are used. */
export function createRng(seed: number): RngState {
  if (!Number.isInteger(seed)) throw new RangeError(`seed must be an integer, got ${seed}`);
  let s = seed >>> 0;
  const splitmix = (): number => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  const state = { a: splitmix(), b: splitmix(), c: splitmix(), d: splitmix() };
  // Discard early output so nearby seeds decorrelate.
  for (let i = 0; i < 12; i++) nextUint32(state);
  return state;
}

export function cloneRng(state: RngState): RngState {
  return { a: state.a, b: state.b, c: state.c, d: state.d };
}

/** Uniform integer in [0, 2^32). */
export function nextUint32(s: RngState): number {
  const t = (((s.a + s.b) >>> 0) + s.d) >>> 0;
  s.d = (s.d + 1) >>> 0;
  s.a = (s.b ^ (s.b >>> 9)) >>> 0;
  s.b = (s.c + (s.c << 3)) >>> 0;
  s.c = ((s.c << 21) | (s.c >>> 11)) >>> 0;
  s.c = (s.c + t) >>> 0;
  return t;
}

/** Uniform float in [0, 1). */
export function nextFloat(s: RngState): number {
  return nextUint32(s) / 4294967296;
}

/** Uniform float in [min, max). */
export function nextRange(s: RngState, min: number, max: number): number {
  return min + (max - min) * nextFloat(s);
}

/** Uniform integer in [min, max], inclusive. */
export function nextInt(s: RngState, min: number, max: number): number {
  return min + Math.floor(nextFloat(s) * (max - min + 1));
}

/** True with probability p. */
export function chance(s: RngState, p: number): boolean {
  return nextFloat(s) < p;
}
