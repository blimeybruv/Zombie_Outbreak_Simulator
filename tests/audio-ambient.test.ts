import { describe, expect, it } from 'vitest';
import { cityLevels, cordonDistance, cordonLevel, crowdMix, EXIT_STRIDE, groanedUnderMoan, outbreakLevel, outdoorLifeNear } from '../src/audio/audio';
import { SIM_LIVING, SIM_PROMOTED } from '../src/worker/protocol';

describe('city day and night levels', () => {
  it('holds a quiet day drone and distant engines while people are alive', () => {
    expect(cityLevels(1, 1)).toEqual({ drone: 0.032, traffic: 1 });
  });

  it('lowers the drone at night and still allows distant engines', () => {
    expect(cityLevels(0, 1).drone).toBeCloseTo(0.0128);
    expect(cityLevels(0, 1).traffic).toBe(1);
  });

  it('goes quiet as the city empties, with no night wind', () => {
    expect(cityLevels(1, 0)).toEqual({ drone: 0, traffic: 0 });
    expect(cityLevels(0, 0)).toEqual({ drone: 0, traffic: 0 });
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

describe('crowd near the camera', () => {
  it('counts outdoor living and promoted people, and ignores anyone hidden', () => {
    const xy = new Float32Array([0, 0, 10, 0, 500, 0]);
    const kind = new Uint8Array([SIM_LIVING, SIM_PROMOTED, 0]);
    expect(outdoorLifeNear(0, 0, xy, kind)).toBeCloseTo((1 + (1 - 10 / 140)) / 6);
    expect(outdoorLifeNear(0, 0, xy, new Uint8Array([0, 0, 0]))).toBe(0);
    expect(outdoorLifeNear(0, 0, new Float32Array([500, 500]), new Uint8Array([SIM_LIVING]))).toBe(0);
  });

  it('is full once six people are on top of the camera', () => {
    const xy = new Float32Array(12);
    const kind = new Uint8Array(6).fill(SIM_LIVING);
    expect(outdoorLifeNear(0, 0, xy, kind)).toBe(1);
  });

  it('is busy by day, a few late voices at night, and birds only by day', () => {
    const day = crowdMix(1, 1, 0, 0);
    const night = crowdMix(1, 0, 0, 0);
    expect(day.murmur).toBeCloseTo(0.045);
    expect(night.murmur).toBeCloseTo(0.045 * 0.22);
    expect(night.murmur).toBeGreaterThan(0);
    expect(day.birds).toBeCloseTo(1);
    expect(night.birds).toBe(0);
    expect(night.life).toBeCloseTo(0.35);
    expect(day.steps).toBeCloseTo(1);
    expect(night.steps).toBe(0);
    expect(night.night).toBeCloseTo(1);
    expect(day.phones).toBeCloseTo(1);
    expect(night.phones).toBe(0);
    expect(crowdMix(0, 1, 0, 0)).toEqual({ murmur: 0, life: 0, birds: 0, steps: 0, phones: 0, night: 0 });
  });

  it('ducks under the outbreak groan and the cordon', () => {
    const open = crowdMix(1, 1, 0, 0).murmur;
    expect(crowdMix(1, 1, 0.12, 0).murmur).toBeCloseTo(open * 0.4);
    expect(crowdMix(1, 1, 0, 0.16).murmur).toBeCloseTo(open * 0.45);
  });
});
