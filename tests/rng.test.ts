import { describe, expect, it } from 'vitest';
import { cloneRng, createRng, nextFloat, nextInt, nextUint32 } from '../src/sim/rng';

const draw = (seed: number, n: number) => {
  const s = createRng(seed);
  return Array.from({ length: n }, () => nextUint32(s));
};

describe('rng', () => {
  it('reproduces the same sequence from the same seed', () => {
    expect(draw(42, 100)).toEqual(draw(42, 100));
  });

  it('gives different sequences for adjacent seeds, including 0', () => {
    expect(draw(0, 10)).not.toEqual(draw(1, 10));
    expect(draw(1, 10)).not.toEqual(draw(2, 10));
  });

  it('pins the sequence, so an accidental algorithm change breaks every seed loudly', () => {
    expect(draw(1, 4)).toMatchInlineSnapshot(`
      [
        1828152527,
        3394835397,
        2967886022,
        2251045104,
      ]
    `);
  });

  it('resumes exactly from a serialised state', () => {
    const s = createRng(7);
    for (let i = 0; i < 50; i++) nextUint32(s);
    const restored = JSON.parse(JSON.stringify(s));
    const copy = cloneRng(s);
    const expected = Array.from({ length: 20 }, () => nextUint32(s));
    expect(Array.from({ length: 20 }, () => nextUint32(restored))).toEqual(expected);
    expect(Array.from({ length: 20 }, () => nextUint32(copy))).toEqual(expected);
  });

  it('keeps floats in [0, 1) with a sane mean', () => {
    const s = createRng(3);
    let sum = 0;
    for (let i = 0; i < 100_000; i++) {
      const x = nextFloat(s);
      expect(x >= 0 && x < 1).toBe(true);
      sum += x;
    }
    expect(sum / 100_000).toBeCloseTo(0.5, 2);
  });

  it('covers both ends of an inclusive integer range', () => {
    const s = createRng(5);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(nextInt(s, 20, 40));
    expect(Math.min(...seen)).toBe(20);
    expect(Math.max(...seen)).toBe(40);
    expect(seen.size).toBe(21);
  });

  it('rejects non-integer seeds', () => {
    expect(() => createRng(1.5)).toThrow(RangeError);
  });
});
