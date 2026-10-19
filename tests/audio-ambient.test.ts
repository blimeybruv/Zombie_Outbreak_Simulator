import { describe, expect, it } from 'vitest';
import { cityLevels, cordonDistance, cordonLevel, EXIT_STRIDE, groanedUnderMoan, outbreakLevel } from '../src/audio/audio';

describe('city day and night levels', () => {
  it('keeps the living day hum and a low wind', () => {
    expect(cityLevels(1, 1)).toEqual({ hum: 0.07, wind: 0.05, traffic: 1 });
  });

  it('drops the hum at night and puts that wind back', () => {
    expect(cityLevels(0, 1)).toEqual({ hum: 0, wind: 0.07, traffic: 0 });
  });

  it('lets the wind rise as the city empties, and further after dark', () => {
    expect(cityLevels(1, 0)).toEqual({ hum: 0, wind: 0.09, traffic: 0 });
    expect(cityLevels(0, 0)).toEqual({ hum: 0, wind: 0.11, traffic: 0 });
  });

  it('clamps daylight and the living share', () => {
    expect(cityLevels(2, -1)).toEqual(cityLevels(1, 0));
  });
});

describe('outbreak groan', () => {
  it('is silent with nobody dead and peaks when only the dead remain', () => {
    expect(outbreakLevel(0, 100)).toBe(0);
    expect(outbreakLevel(100, 0)).toBeCloseTo(0.12);
    expect(outbreakLevel(0, 0)).toBe(0);
  });

  it('squares the dead share, so a city half gone is still quiet', () => {
    expect(outbreakLevel(50, 50)).toBeCloseTo(0.03);
    expect(outbreakLevel(10, 90)).toBeLessThan(outbreakLevel(50, 50));
    expect(outbreakLevel(50, 50)).toBeLessThan(outbreakLevel(90, 10));
  });

  it('ducks under the moan already playing in view', () => {
    expect(groanedUnderMoan(100, 0, 0)).toBeCloseTo(0.12);
    expect(groanedUnderMoan(100, 0, 0.4)).toBeCloseTo(0.12 * 0.35);
    expect(groanedUnderMoan(100, 0, 0.8)).toBeCloseTo(0.12 * 0.35);
    expect(groanedUnderMoan(0, 10, 0)).toBe(0);
  });
});

describe('cordon presence', () => {
  it('is silent until an exit is closed, then louder beside it', () => {
    expect(cordonLevel(0, false)).toBe(0);
    expect(cordonLevel(Infinity, true)).toBe(0);
    expect(cordonLevel(Number.NaN, true)).toBe(0);
    expect(cordonLevel(0, true)).toBeCloseTo(0.16);
    expect(cordonLevel(250, true)).toBeCloseTo(0.16);
    expect(cordonLevel(1800, true)).toBeCloseTo(0.02);
    expect(cordonLevel(1025, true)).toBeCloseTo(0.09);
    expect(cordonLevel(400, true)).toBeGreaterThan(cordonLevel(1200, true));
  });

  it('measures the nearest closed mouth or barrier and ignores an open exit', () => {
    expect(EXIT_STRIDE).toBe(7);
    const exits = new Float32Array([
      0, 0, 1, 0, 100, 0, 12,
      500, 0, 1, 0, 500, 40, 12,
    ]);
    expect(cordonDistance(0, 0, exits, 0)).toBe(Infinity);
    expect(cordonDistance(0, 0, exits, 0b10)).toBeCloseTo(500);
    expect(cordonDistance(500, 40, exits, 0b10)).toBeCloseTo(0);
    expect(cordonDistance(0, 0, exits, 0b01)).toBeCloseTo(0);
  });
});
