import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { breachChance } from '../src/sim/breach';
import { footprintArea } from '../src/sim/mapgen/generate';
import { createWorld } from '../src/sim/setup';
import { confidence, timeOfDay } from '../src/sim/derived';
import { defaultScenario } from '../src/sim/scenario';
import {
  ARCHETYPES,
  DISTRICT_KINDS,
  FLAVOUR_TAGS,
  FUNCTIONAL_TAGS,
  GAITS,
  PROFESSIONS,
  TERRAINS,
  WEAPONS,
} from '../src/sim/state';

const sorted = (xs: readonly string[]) => [...xs].sort();
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('config keys match the state enums', () => {
  it.each([
    ['archetypes', config.archetypes, ARCHETYPES],
    ['startingKit.meleeShare', config.startingKit.meleeShare, ARCHETYPES],
    ['tags', config.tags, FUNCTIONAL_TAGS],
    ['tagProfessions', config.tagProfessions, FUNCTIONAL_TAGS],
    ['flavourProfiles', config.flavourProfiles, FLAVOUR_TAGS],
    ['professionArchetype', config.professionArchetype, PROFESSIONS],
    ['movement.gait', config.movement.gait, GAITS],
    ['districtKinds', config.districtKinds, DISTRICT_KINDS],
    ['perception.dayRadius', config.perception.dayRadius, TERRAINS],
  ])('%s', (_name, record, values) => {
    expect(sorted(Object.keys(record))).toEqual(sorted(values));
  });

  it('every weapon has exactly one combat profile', () => {
    const profiled = [...Object.keys(config.combat.ranged), ...Object.keys(config.combat.melee)].filter((k) => k !== 'unarmed');
    expect(sorted(profiled)).toEqual(sorted(WEAPONS));
  });

  it('enum-valued entries name real enum members', () => {
    const functional: readonly string[] = FUNCTIONAL_TAGS;
    const archetypes: readonly string[] = ARCHETYPES;
    const professions: readonly string[] = PROFESSIONS;
    const kinds: readonly string[] = DISTRICT_KINDS;
    expect(Object.values(config.flavourProfiles).filter((t) => !functional.includes(t))).toEqual([]);
    expect(Object.values(config.professionArchetype).filter((a) => !archetypes.includes(a))).toEqual([]);
    expect(Object.values(config.tagProfessions).flat().filter((p) => !professions.includes(p))).toEqual([]);
    expect(config.map.districtLayout.filter((k) => !kinds.includes(k))).toEqual([]);
  });

  it('every profession can be spawned from some tag', () => {
    const spawnable = new Set(Object.values(config.tagProfessions).flat());
    expect(PROFESSIONS.filter((p) => !spawnable.has(p))).toEqual([]);
  });

  it('loot names only weapons, ammo or materials', () => {
    const allowed = new Set<string>([...WEAPONS, 'ammo', 'materials']);
    const loot = Object.values(config.tags).flatMap((t) => Object.keys(t.loot));
    expect(loot.filter((k) => !allowed.has(k))).toEqual([]);
  });
});

describe('config is internally consistent', () => {
  it('lays out a full district grid with downtown in the centre', () => {
    const n = config.map.districtGrid;
    expect(config.map.districtLayout).toHaveLength(n * n);
    expect(config.map.districtLayout[(n * n - 1) / 2]).toBe('downtown');
  });

  it('breach split and archetype mix are distributions', () => {
    expect(sum(Object.values(config.buildings.breach.split))).toBeCloseTo(1, 10);
    expect(sum(Object.values(defaultScenario.archetypeMix))).toBeCloseTo(1, 10);
  });

  it('has one occupancy multiplier per band and one outdoor share per band', () => {
    const bands = config.time.bandStartHours.length;
    expect(config.spawn.outdoorShareByBand).toHaveLength(bands);
    for (const tag of Object.values(config.tags)) expect(tag.bandMultiplier).toHaveLength(bands);
  });

  it('keeps every chance and scalar inside 0–1', () => {
    const scalars = [
      ...config.combat.releasedChanceByContact,
      ...Object.values(config.combat.ranged).map((w) => w.baseKill),
      ...Object.values(config.combat.melee).flatMap((w) => [w.baseKill, w.infectionOnMiss]),
      ...Object.values(config.tags).map((t) => t.integrity),
      ...Object.values(config.archetypes).flatMap((a) => [a.engageThreshold, a.shelterSeekThreshold]),
      config.combat.zombieAttack.baseInfection,
      config.panic.routingCutoff,
      config.panic.memoryCutoff,
      config.panic.expelThreshold,
    ];
    expect(scalars.filter((x) => x < 0 || x > 1)).toEqual([]);
  });

  it('orders the panic cutoffs: memory, then routing, then expulsion', () => {
    expect(config.panic.memoryCutoff).toBeLessThan(config.panic.routingCutoff);
    expect(config.panic.routingCutoff).toBeLessThan(config.panic.expelThreshold);
  });

  it('keeps zombies slower than a walking sim but runners between run and sprint', () => {
    const g = config.movement.gait;
    expect(config.zombie.speed.shambler).toBeLessThan(g.walk.speed);
    expect(config.zombie.speed.runner).toBeGreaterThan(g.run.speed);
    expect(config.zombie.speed.runner).toBeLessThan(g.sprint.speed);
  });

  it('starting police ammo spans the capable-to-ordinary arc in one engagement', () => {
    const pistol = config.combat.ranged.pistol;
    const capacity = (ammo: number) => Math.floor(ammo * pistol.baseKill);
    const typicalOccupation = 5;
    const roundsToClear = Math.ceil(typicalOccupation / pistol.baseKill);
    expect(capacity(config.startingKit.policeAmmo)).toBeGreaterThanOrEqual(typicalOccupation);
    expect(capacity(config.startingKit.policeAmmo - roundsToClear)).toBeLessThan(typicalOccupation);
  });
});

describe('derived quantities', () => {
  it('memory confidence halves at halfLife', () => {
    expect(confidence(0, config.memory.halfLife, config)).toBeCloseTo(0.5, 10);
    expect(confidence(100, 100, config)).toBe(1);
  });

  it('time of day starts at the scenario hour and cycles every dayLength', () => {
    const s = { ...defaultScenario, startHour: 12 };
    expect(timeOfDay(0, s, config)).toBeCloseTo(0.5, 10);
    expect(timeOfDay(config.time.dayLength, s, config)).toBeCloseTo(0.5, 10);
    expect(timeOfDay(config.time.dayLength / 2, s, config)).toBeCloseTo(0, 10);
    expect(config.time.runLength / config.time.dayLength).toBe(3);
  });
});

describe('breach chance', () => {
  const tags = Object.values(config.tags);

  it('is never zero, even for the strongest building fully fortified', () => {
    for (const t of tags) expect(breachChance(t.integrity, 1, config)).toBeGreaterThan(0);
  });

  it('falls as fortification rises', () => {
    for (const t of tags) expect(breachChance(t.integrity, 0.5, config)).toBeLessThan(breachChance(t.integrity, 0, config));
  });

  it('lets a fortified weak building outlast a bare strong one', () => {
    const weakest = Math.min(...tags.map((t) => t.integrity));
    const strongestRoutine = config.tags.residential.integrity;
    expect(breachChance(weakest, 1, config)).toBeLessThan(breachChance(strongestRoutine, 0, config));
  });
});

describe('starting occupancy on the generated map', () => {
  it.each([3, 9, 13, 19])('a building eligible for the enclosed origin holds originMinResidents when starting at %i:00', (startHour) => {
    const { world } = createWorld({ ...defaultScenario, startHour }, config);
    const fullest = Math.max(...world.buildings.filter((b) => ['hospital', 'office', 'school'].includes(b.tag)).map((b) => b.residents + (b.zombiesInside > 0 ? 1 : 0)));
    expect(fullest).toBeGreaterThanOrEqual(config.spawn.originMinResidents);
  });

  it('puts more people in bigger buildings', () => {
    const { world } = createWorld({ ...defaultScenario, startHour: 3 }, config);
    const homes = world.buildings.filter((b) => b.tag === 'residential').map((b) => [footprintArea(b.outline), b.residents] as const);
    const small = homes.filter(([a]) => a < 200).map(([, r]) => r);
    const large = homes.filter(([a]) => a >= 400).map(([, r]) => r);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(large)).toBeGreaterThan(mean(small));
  });
});
