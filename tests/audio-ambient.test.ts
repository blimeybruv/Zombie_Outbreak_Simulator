import { describe, expect, it } from 'vitest';
import { armyEngagement, armyMix, cityLevels, cordonDistance, cordonLevel, crowdMix, EVENT_NOISE, eventNoises, EXIT_STRIDE, groanedUnderMoan, HORN_BLAST_AT, hornSpan, hornVoice, nearestInfected, nearestRanger, NOISE_CATEGORY, ONE_SHOT_KINDS, oneShotPeaks, outbreakBreathDrive, outbreakLevel, outbreakStages, outdoorLifeNear, rangerPan, screamCoversShout } from '../src/audio/audio';
import { SIM_FLEEING, SIM_INFECTED, SIM_LIVING, SIM_PROMOTED, ZOMBIE_AWAKE } from '../src/worker/protocol';

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

describe('outbreak stages', () => {
  const sum = (s: ReturnType<typeof outbreakStages>) => s.calm + s.first + s.spreading + s.panic + s.overrun;

  it('is calm before anyone has died, including the ten seed zombies indoors', () => {
    const empty = outbreakStages(6000, 0, 0);
    const seeded = outbreakStages(5990, 0, 10);
    expect(empty.dominant).toBe('calm');
    expect(seeded.dominant).toBe('calm');
    expect(seeded.calm).toBeGreaterThan(0.9);
    expect(empty.groan).toBe(0);
    expect(seeded.voices).toBe(0);
    expect(sum(empty)).toBeCloseTo(1);
    expect(sum(seeded)).toBeCloseTo(1);
  });

  it('follows the seed-1 bench from first signs through overrun', () => {
    const first = outbreakStages(5623, 227, 121);
    const spreading = outbreakStages(4386, 1275, 285);
    const panic = outbreakStages(3676, 1787, 483);
    const overrun = outbreakStages(2791, 2447, 706);
    expect(first.dominant).toBe('first');
    expect(first.first).toBeGreaterThan(0.6);
    expect(spreading.dominant).toBe('spreading');
    expect(spreading.spreading).toBeGreaterThan(0.8);
    expect(panic.dominant).toBe('panic');
    expect(panic.panic).toBeGreaterThan(0.8);
    expect(overrun.dominant).toBe('overrun');
    expect(overrun.overrun).toBeGreaterThan(0.8);
    expect(first.groan).toBeGreaterThan(0);
    expect(spreading.groan).toBeGreaterThan(first.groan);
    expect(panic.groan).toBeGreaterThan(spreading.groan);
    expect(overrun.groan).toBeGreaterThan(panic.groan);
    expect(overrun.groan).toBeLessThanOrEqual(0.12);
    expect(overrun.voices).toBeLessThan(panic.voices);
    expect(panic.voices).toBeGreaterThan(spreading.voices * 0.9);
  });

  it('crossfades neighbouring stages and leaves the others quiet', () => {
    const mid = outbreakStages(5550, 250, 135);
    expect(mid.first).toBeGreaterThan(0.3);
    expect(mid.spreading).toBeGreaterThan(0.3);
    expect(mid.calm).toBe(0);
    expect(mid.panic).toBe(0);
    expect(mid.overrun).toBe(0);
    expect(mid.first + mid.spreading).toBeGreaterThan(0.95);
    expect(sum(mid)).toBeCloseTo(1);
  });

  it('is groan only when nobody is left alive', () => {
    const fallen = outbreakStages(0, 4000, 800);
    expect(fallen.dominant).toBe('overrun');
    expect(fallen.overrun).toBe(1);
    expect(fallen.voices).toBe(0);
    expect(fallen.groan).toBeCloseTo(0.12);
    expect(outbreakStages(0, 0, 0).dominant).toBe('calm');
  });
});

describe('outbreak breath near the camera', () => {
  it('rises when someone fleeing is close or a zombie is close, and stays quiet otherwise', () => {
    const xy = new Float32Array([0, 0, 80, 0, 400, 0]);
    const kind = new Uint8Array([SIM_LIVING, SIM_PROMOTED, SIM_LIVING]);
    const fleeing = new Uint8Array([SIM_FLEEING, 0, SIM_FLEEING]);
    const quiet = outbreakBreathDrive(0, 0, xy, kind, new Uint8Array(3), new Float32Array(), new Uint8Array());
    expect(quiet).toBe(0);
    const chase = outbreakBreathDrive(0, 0, xy, kind, fleeing, new Float32Array(), new Uint8Array());
    expect(chase).toBeGreaterThan(0.4);
    expect(chase).toBeLessThanOrEqual(1);
    const zombie = outbreakBreathDrive(0, 0, xy, kind, new Uint8Array(3), new Float32Array([20, 0]), new Uint8Array([ZOMBIE_AWAKE]));
    expect(zombie).toBeCloseTo(1 - 20 / 46);
    const hidden = outbreakBreathDrive(0, 0, xy, kind, new Uint8Array(3), new Float32Array([0, 0]), new Uint8Array([0]));
    expect(hidden).toBe(0);
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

describe('army radio', () => {
  it('maps ranger count, distance and engagement into gain, and ducks the cordon', () => {
    expect(armyMix(0, 0, 1)).toEqual({ gain: 0, busy: 0, cordonDuck: 1 });
    expect(armyMix(0, 40, 0)).toEqual({ gain: 0, busy: 0, cordonDuck: 1 });
    const count = 1 - Math.exp(-16 / 8);
    const close = armyMix(16, 40, 0);
    const far = armyMix(16, 400, 0);
    const mid = armyMix(16, 200, 1);
    expect(close.gain).toBeCloseTo(0.18 * count);
    expect(close.busy).toBeCloseTo(0.28);
    expect(close.cordonDuck).toBeCloseTo(1 - 0.72 * count);
    expect(far.gain).toBeCloseTo(0.18 * count * 0.35);
    expect(far.gain).toBeLessThan(close.gain);
    expect(mid.gain).toBeCloseTo(0.18 * count * (1 + (0.35 - 1) * 0.5));
    expect(mid.busy).toBe(1);
    expect(close.cordonDuck).toBeLessThan(mid.cordonDuck);
    expect(mid.cordonDuck).toBeLessThan(far.cordonDuck);
    expect(close.cordonDuck).toBeLessThan(1);
    expect(armyMix(80, 0, 0).gain).toBeLessThanOrEqual(0.18);
    expect(armyMix(80, 0, 0).gain).toBeGreaterThan(0.17);
    expect(nearestRanger(0, 0, new Float32Array())).toBe(Infinity);
    expect(nearestRanger(0, 0, new Float32Array([10, 0, 100, 0]))).toBeCloseTo(10);
    expect(rangerPan(0, 0, new Float32Array())).toBe(0);
    expect(rangerPan(0, 0, new Float32Array([10, 0, -200, 0]))).toBeCloseTo(10 / 80);
  });

  it('counts zombies and rifle shots near Rangers, and ignores pistols, hidden zombies and an empty company', () => {
    const rangers = new Float32Array([0, 0, 30, 0]);
    const zombies = new Float32Array([50, 0, 400, 0, 5, 0]);
    const kinds = new Uint8Array([ZOMBIE_AWAKE, ZOMBIE_AWAKE, 0]);
    const quiet = armyEngagement(rangers, zombies, kinds, []);
    expect(quiet).toBeCloseTo(1 / 4);
    const engaged = armyEngagement(rangers, zombies, kinds, [
      { x: 20, y: 0, kind: 'rifle' },
      { x: 900, y: 0, kind: 'rifle' },
      { x: 0, y: 0, kind: 'pistol' },
    ]);
    expect(engaged).toBeCloseTo(1 / 4 + 1 / 2);
    expect(armyEngagement(new Float32Array(), zombies, kinds, [{ x: 0, y: 0, kind: 'rifle' }])).toBe(0);
  });
});

describe('obstruction horns', () => {
  it('uses short beeps below half severity and one longer blast from there up', () => {
    const mild = hornVoice(0);
    const rising = hornVoice(0.4);
    const blast = hornVoice(HORN_BLAST_AT);
    const full = hornVoice(1);
    expect(mild.style).toBe('beep');
    expect(rising.style).toBe('beep');
    expect(blast.style).toBe('blast');
    expect(full.style).toBe('blast');
    expect(mild.count).toBe(2);
    expect(rising.count).toBeGreaterThan(mild.count);
    expect(rising.gap).toBeLessThan(mild.gap);
    expect(blast.count).toBe(1);
    expect(blast.gap).toBe(0);
    expect(full.seconds).toBeGreaterThan(blast.seconds);
    expect(full.gain).toBeGreaterThan(blast.gain);
    expect(blast.gain).toBeGreaterThan(mild.gain);
    expect(hornVoice(-2)).toEqual(mild);
    expect(hornVoice(3).seconds).toBe(full.seconds);
    expect(hornSpan(mild)).toBe((mild.count - 1) * mild.gap + mild.seconds);
    expect(hornSpan(full)).toBe(full.seconds);
  });
});

describe('noise kinds', () => {
  it('plays a shout, and gives every mapped kind except the horn a buffer', () => {
    expect(NOISE_CATEGORY.shout).toBe('voice');
    expect(ONE_SHOT_KINDS).toContain('shout');
    expect(NOISE_CATEGORY.scream).toBe('voice');
    expect(NOISE_CATEGORY.cough).toBe('voice');
    expect(NOISE_CATEGORY.engine).toBe('engine');
    expect(NOISE_CATEGORY.siren).toBe('siren');
    expect(NOISE_CATEGORY.door).toBe('impact');
    expect(NOISE_CATEGORY.glass).toBe('impact');
    expect(NOISE_CATEGORY.knife).toBeUndefined();
    const buffered = new Set<string>(ONE_SHOT_KINDS);
    for (const kind of Object.keys(NOISE_CATEGORY)) {
      if (kind === 'carHorn') expect(buffered.has(kind)).toBe(false);
      else expect(buffered.has(kind)).toBe(true);
    }
    for (const kind of ONE_SHOT_KINDS) expect(NOISE_CATEGORY[kind]).toBeDefined();
    const peaks = oneShotPeaks();
    for (const kind of ONE_SHOT_KINDS) expect(peaks[kind], kind).toBeCloseTo(0.9);
  });

  it('folds deaths, breaches and crashes into the one-shot path, and leaves a shot as a shot', () => {
    const notes = [null, { x: 10, y: 20 }, null, null];
    const heard = eventNoises(
      [
        { type: 'carHorn', x: 1, y: 2, radius: 80, severity: 0.25 },
        { type: 'buildingBreached' },
        { type: 'simDied', cause: 'fedOn', x: 4, y: 5 },
        { type: 'simDied', cause: 'shot', x: 6, y: 7 },
        { type: 'carCrashed', x: 8, y: 9 },
        { type: 'turnedInside' },
      ],
      notes,
    );
    expect(heard).toEqual([
      { x: 1, y: 2, kind: 'carHorn', radius: 80, severity: 0.25 },
      { x: 10, y: 20, kind: 'door', radius: EVENT_NOISE.door },
      { x: 4, y: 5, kind: 'scream', radius: EVENT_NOISE.scream },
      { x: 8, y: 9, kind: 'glass', radius: EVENT_NOISE.glass },
    ]);
    expect(eventNoises([{ type: 'buildingBreached' }], [null])).toEqual([]);
  });

  it('lets a death scream stand in for the shout from the same spot', () => {
    expect(screamCoversShout(0, 0, [{ x: 1, y: 1 }])).toBe(true);
    expect(screamCoversShout(0, 0, [{ x: 10, y: 0 }])).toBe(false);
    expect(screamCoversShout(0, 0, [])).toBe(false);
  });

  it('coughs from the nearest outdoor bitten person and ignores anyone else', () => {
    const xy = new Float32Array([0, 0, 30, 0, 10, 0]);
    const kind = new Uint8Array([SIM_LIVING, SIM_PROMOTED, SIM_LIVING]);
    const flags = new Uint8Array([0, SIM_INFECTED, SIM_INFECTED]);
    expect(nearestInfected(0, 0, xy, kind, flags)).toEqual({ x: 10, y: 0 });
    expect(nearestInfected(0, 0, xy, kind, new Uint8Array(3))).toBeNull();
    expect(nearestInfected(0, 0, xy, new Uint8Array(3), flags)).toBeNull();
    expect(nearestInfected(0, 0, xy, kind, flags, 5)).toBeNull();
  });
});
