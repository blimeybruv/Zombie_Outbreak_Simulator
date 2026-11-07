import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { settingsFrom } from '../src/ui/setup';

describe('setup settings from the address', () => {
  it('takes the defaults when the address says nothing', () => {
    const s = settingsFrom(new URLSearchParams(''));
    expect(s).toEqual({
      population: defaultScenario.population,
      initialZombies: defaultScenario.initialZombies,
      origin: defaultScenario.origin,
      start: defaultScenario.start,
      survivors: defaultScenario.survivors,
      archetypeMix: defaultScenario.archetypeMix,
      homeFirearms: defaultScenario.homeFirearms,
      startHour: defaultScenario.startHour,
      zombieGait: defaultScenario.zombieGait,
      power: defaultScenario.power,
      mapSeed: defaultScenario.mapSeed,
      runSeed: defaultScenario.runSeed,
    });
  });

  it('reads every setting, clamped to its range, and ignores nonsense', () => {
    const s = settingsFrom(new URLSearchParams('population=99999&initial=0&origin=street&hour=30&zombies=runner&power=0&map=7&run=42'));
    expect(s.population).toBe(config.setup.population[1]);
    expect(s.initialZombies).toBe(config.setup.initialZombies[0]);
    expect([s.origin, s.startHour, s.zombieGait, s.power, s.mapSeed, s.runSeed]).toEqual(['street', 23, 'runner', false, 7, 42]);
    const t = settingsFrom(new URLSearchParams('origin=moon&zombies=flying&population=abc'));
    expect([t.origin, t.zombieGait, t.population]).toEqual([defaultScenario.origin, defaultScenario.zombieGait, defaultScenario.population]);
  });

  it('reads a fallen city and how many are left, clamped', () => {
    const s = settingsFrom(new URLSearchParams('opening=fallen&left=5'));
    expect([s.start, s.survivors]).toEqual(['fallen', config.setup.survivors[0]]);
    expect(settingsFrom(new URLSearchParams('opening=ruins&left=150'))).toMatchObject({ start: 'outbreak', survivors: 150 });
  });

  it('reads preparedness and guns at home as separate dials, the mix still summing to one', () => {
    const s = settingsFrom(new URLSearchParams('preppers=40&guns=20'));
    expect(s.archetypeMix.prepper).toBeCloseTo(0.4, 10);
    expect(Object.values(s.archetypeMix).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(s.homeFirearms).toBeCloseTo(0.2, 10);
    expect(settingsFrom(new URLSearchParams('preppers=26')).archetypeMix).toBe(defaultScenario.archetypeMix); // unchanged: the very same mix
    expect(settingsFrom(new URLSearchParams('guns=99')).homeFirearms).toBe(config.setup.homeFirearms[1]);
  });
});
