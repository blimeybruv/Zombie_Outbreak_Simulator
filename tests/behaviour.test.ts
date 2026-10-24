import { describe, expect, it } from 'vitest';
import { config as baseConfig, type Config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { spawnSim, spawnZombie } from '../src/sim/spawn';
import type { Sim, World } from '../src/sim/state';
import { merge, resolveEncounters } from '../src/sim/systems/people/encounters';
import { computePerception, rebuildHashes } from '../src/sim/systems/shared/perception';
import { simDecisions, talkSpacing } from '../src/sim/systems/people/sims';
import { openDoor, setDestination, stageOf } from '../src/sim/systems/shared/common';
import { buildingProcesses } from '../src/sim/systems/buildings/buildings';
import { dispatchCalls, placeCall } from '../src/sim/systems/services/dispatch';
import { chooseShelter } from '../src/sim/systems/buildings/shelter';
import { zombieDecisions } from '../src/sim/systems/dead/zombies';
import { bite, resolveCombat } from '../src/sim/systems/fighting/combat';
import { breaks, updatePanic } from '../src/sim/systems/people/panic';
import { reconsider } from '../src/sim/systems/people/awareness';
import { believedDanger } from '../src/sim/navigation/pathfinding';
import { convertDue } from '../src/sim/systems/dead/infection';
import { carProcesses } from '../src/sim/systems/services/cars';
import { decideCars, moveCars } from '../src/sim/systems/services/driving';
import { integrateMovement } from '../src/sim/systems/shared/movement';
import { step } from '../src/sim/tick';

// Pinned to one zombie in one building, with no SWAT, EMTs, yards or exits: these tests set
// their own scenes on that map, and were written against it (those have their own tests).
function fresh(cfg: Config = baseConfig) {
  return createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, { ...cfg, features: { ...cfg.features, swat: false, emt: false, yards: false, exits: false } });
}

/** A point in the middle of a long street well inside the city, and the street's direction. */
function streetPoint(world: World): { x: number; y: number; ux: number; uy: number } {
  const size = world.config.map.size;
  const inner = (v: number) => v > size / 4 && v < (size * 3) / 4;
  const s = world.streets.find((st) => {
    const a = world.nodes[st.a]!, b = world.nodes[st.b]!;
    return st.terrain === 'standard' && Math.hypot(b.x - a.x, b.y - a.y) > 60 && inner((a.x + b.x) / 2) && inner((a.y + b.y) / 2);
  })!;
  const a = world.nodes[s.a]!, b = world.nodes[s.b]!;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ux: (b.x - a.x) / len, uy: (b.y - a.y) / len };
}

function walker(world: World, x: number, y: number): Sim {
  const s = spawnSim(world, { x, y, insideBuilding: null, sourceTag: 'office', initialPanic: 0, destinationKind: 'routine' });
  s.archetype = 'civilian';
  s.weapon = null;
  return s;
}

function decide(world: World, ctx: ReturnType<typeof fresh>['ctx']): void {
  sizeContext(ctx, world);
  rebuildHashes(world, ctx);
  computePerception(world, ctx);
  simDecisions(world, ctx);
}

describe('awareness', () => {
  it('spreads by word of mouth, and the aware drop their errands for home', () => {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    const a = walker(world, p.x, p.y);
    const b = walker(world, p.x + 1, p.y);
    a.awareAt = 0;
    b.trust = 1; // believes the first telling
    expect(b.awareAt).toBeNull();
    merge(world, a, b);
    expect(b.awareAt).not.toBeNull();

    b.archetype = 'prepper'; // goes home from anywhere in the city
    b.church = null; // the faithful go to church instead
    expect(b.home).not.toBeNull();
    decide(world, ctx);
    expect(b.destinationKind).toBe('shelter');
    expect(b.destinationBuilding).toBe(b.home);
  });

  it('leaves the unaware to their routine', () => {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    const s = walker(world, p.x, p.y);
    decide(world, ctx);
    expect(s.awareAt).toBeNull();
    expect(s.destinationKind).toBe('routine');
  });
});

describe('fight, flight or freeze', () => {
  /** A sim on a street with zombies close on both sides of it, and no door in reach. */
  function cornered(armed: boolean, at = 5, nerve = 1, panic = 0) {
    const cfg = structuredClone(baseConfig);
    cfg.behaviour.doorSearchRadius = 0;
    const { world, ctx } = fresh(cfg);
    const p = streetPoint(world);
    const s = walker(world, p.x, p.y);
    s.heading = Math.atan2(p.uy, p.ux); // facing one of them
    s.nerve = nerve;
    s.panic = panic;
    if (armed) s.weapon = 'club';
    for (const side of [1, -1]) spawnZombie(world, p.x + p.ux * at * side, p.y + p.uy * at * side, 'active', null, null);
    decide(world, ctx);
    return s;
  }

  it('an unarmed sim with danger on both sides and nowhere to go freezes', () => {
    const s = cornered(false);
    expect(s.awareAt).not.toBeNull();
    expect(s.stand).toBe('freeze');
    expect(s.gait).toBe('still');
  });

  it('an armed one stands and fights', () => {
    expect(cornered(true).stand).toBe('fight');
  });

  it('an armed one whose nerve has gone freezes in shock instead', () => {
    expect(cornered(true, 5, 0.2, 0.5).stand).toBe('freeze');
  });

  it('is not cornered by danger further off than cornered.near, whatever side it is on', () => {
    const s = cornered(true, baseConfig.cornered.near * 3);
    expect(s.awareAt).not.toBeNull();
    expect(s.stand).toBeNull();
  });
});

describe('the bitten', () => {
  function bitten(isolates: number) {
    const cfg = structuredClone(baseConfig);
    cfg.archetypes.civilian.isolates = isolates;
    const { world, ctx } = fresh(cfg);
    const p = streetPoint(world);
    const s = walker(world, p.x, p.y);
    s.condition = 'infected';
    s.turnsAt = world.tick + 30;
    decide(world, ctx);
    return { world, ctx, s };
  }

  it('one that isolates goes off alone to an empty building, and the viewer is told', () => {
    const { world, ctx, s } = bitten(1);
    expect(s.infectedChoice).toBe('isolate');
    expect(s.destinationKind).toBe('isolate');
    const b = world.buildings[s.destinationBuilding!]!;
    expect(b.residents + b.sheltered.length + b.zombiesInside).toBe(0);
    expect(ctx.events.some((e) => e.type === 'simIsolating' && e.sim === s.id)).toBe(true);
  });

  it('one that conceals carries on as if nothing happened', () => {
    const { s } = bitten(0);
    expect(s.infectedChoice).toBe('conceal');
    expect(s.destinationKind).not.toBe('isolate');
  });
});

describe('sociality', () => {
  /** Two aware walkers side by side: `a` bound for a far shelter, `b` for a near one. Returns where `a` ends up going. */
  function meet(archetype: Sim['archetype'], sociality: number, cfg: Config = baseConfig): { goes: boolean } {
    const { world, ctx } = fresh(cfg);
    const p = streetPoint(world);
    const a = walker(world, p.x, p.y);
    const b = walker(world, p.x + 1, p.y);
    a.archetype = archetype;
    a.sociality = sociality;
    a.awareAt = b.awareAt = 0;
    const byDistance = [...world.buildings].sort(
      (m, n) => Math.hypot(m.entrances[0]!.x - p.x, m.entrances[0]!.y - p.y) - Math.hypot(n.entrances[0]!.x - p.x, n.entrances[0]!.y - p.y),
    );
    setDestination(a, byDistance[200]!, 'shelter');
    setDestination(b, byDistance[1]!, 'shelter');
    a.lastMergeAt = b.lastMergeAt = -1000;
    sizeContext(ctx, world);
    resolveEncounters(world, ctx);
    expect(b.destinationBuilding).toBe(byDistance[1]!.id);
    return { goes: a.destinationBuilding === byDistance[1]!.id };
  }

  it('a sociable sim bound for a far shelter goes along with someone bound for a nearer one', () => {
    expect(meet('civilian', 1).goes).toBe(true); // 2 × 1 × 0.8, up to 1
  });

  it('a solitary sim does not, whatever its archetype', () => {
    expect(meet('civilian', 0).goes).toBe(false);
  });

  it('a loner never goes along, however sociable', () => {
    expect(meet('loner', 1).goes).toBe(false);
  });

  it('draws the trait independently of archetype, nudged by profession', () => {
    const { world } = fresh();
    const rest = world.sims.filter((s) => !(s.profession in baseConfig.spawn.professionSociality));
    const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);
    // A uniform draw's mean, within three standard errors (sd of a uniform is 0.29).
    const uniform = (xs: number[]) => expect(Math.abs(mean(xs) - 0.5)).toBeLessThan((3 * 0.29) / Math.sqrt(xs.length));
    uniform(rest.map((s) => s.sociality));
    for (const arch of ['civilian', 'prepper', 'reckless'] as const) uniform(rest.filter((s) => s.archetype === arch).map((s) => s.sociality));
    const bartenders = world.sims.filter((s) => s.profession === 'bartender');
    const drivers = world.sims.filter((s) => s.profession === 'longHaulDriver');
    expect(mean(bartenders.map((s) => s.sociality))).toBeGreaterThan(mean(drivers.map((s) => s.sociality)));
  });
});

describe('conversations', () => {
  /** Two walkers side by side, cooldowns spent, `a` knowing one street's danger. */
  function pair(sa: number, sb: number, trustB = 1, apart = 1) {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    // Nobody else close enough to join or be met.
    for (const o of world.sims) if (o.insideBuilding === null && Math.hypot(o.x - p.x, o.y - p.y) < 60) o.insideBuilding = 0 as never;
    const a = walker(world, p.x, p.y);
    const b = walker(world, p.x + apart, p.y);
    a.sociality = sa;
    b.sociality = sb;
    b.trust = trustB;
    a.awareAt = 0;
    a.lastMergeAt = b.lastMergeAt = -1000;
    a.streetMemory.set(0 as never, { danger: 0.9, observedAt: 0, visited: true });
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    resolveEncounters(world, ctx);
    return { world, ctx, a, b, p };
  }

  it('the sociable stop, trade what they know, and stand facing each other', () => {
    const { world, ctx, a, b } = pair(1, 1);
    expect(a.gathering).toBe(a.id);
    expect(b.gathering).toBe(a.id);
    expect(b.streetMemory.get(0 as never)?.danger).toBe(0.9);
    // At the conversation's own distance, both stand.
    b.x = a.x + talkSpacing(world.config, a.id);
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    decide(world, ctx);
    expect([a.gait, b.gait]).toEqual(['still', 'still']);
    expect(Math.cos(b.heading)).toBeLessThan(-0.99); // b, east of a, faces west
  });

  it('too close to talk, the higher id steps back and the lower holds', () => {
    const { world, ctx, a, b } = pair(1, 1, 1, 0.3);
    expect(b.gathering).toBe(a.id);
    decide(world, ctx);
    expect(a.gait).toBe('still');
    expect(b.gait).toBe('sneak');
    expect(Math.cos(b.heading)).toBeGreaterThan(0.99); // b, east of a, steps east
  });

  it('the solitary pass by: neither the outbreak nor the details pass on', () => {
    const { a, b } = pair(0, 0);
    expect(a.gathering).toBeNull();
    expect(b.awareAt).toBeNull();
    expect(b.streetMemory.has(0 as never)).toBe(false);
  });

  it('talking passes on the outbreak to the trusting', () => {
    const { b } = pair(1, 1, 1);
    expect(b.awareAt).not.toBeNull();
  });

  it('a sceptic needs telling by more than one, and hears news as older than it is', () => {
    const { world, a, b } = pair(1, 1, 0);
    expect(b.awareAt).toBeNull(); // one telling of three
    expect(b.toldBy.has(a.id)).toBe(true);
    expect(b.streetMemory.get(0 as never)!.observedAt).toBe(-world.config.trust.ageShift);
    const c = walker(world, b.x, b.y);
    const d = walker(world, b.x, b.y);
    c.awareAt = d.awareAt = 0;
    merge(world, c, b);
    expect(b.awareAt).toBeNull();
    merge(world, d, b);
    expect(b.awareAt).not.toBeNull();
    expect(b.toldBy.size).toBe(0);
  });

  it('breaks up when anyone in it sees danger', () => {
    const { world, ctx, a, b, p } = pair(1, 1);
    spawnZombie(world, p.x - p.ux * 12, p.y - p.uy * 12, 'active', null, null); // up the street, in sight
    decide(world, ctx);
    expect(a.gathering).toBeNull();
    expect(b.gathering).toBeNull();
  });

  it('draws in a sociable passer, and each leaves when its time is up', () => {
    const { world, ctx, a, b, p } = pair(1, 0.4); // 1.5 × 0.7: sure to stop
    expect(a.talkUntil! - world.tick).toBeGreaterThan(b.talkUntil! - world.tick); // the least sociable leaves first
    const c = walker(world, p.x, p.y + 8); // beyond meeting range, within joinRadius
    c.sociality = 1;
    c.lastMergeAt = -1000;
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    resolveEncounters(world, ctx);
    expect(c.gathering).toBe(a.id);
    world.tick = b.talkUntil!;
    resolveEncounters(world, ctx);
    expect(b.gathering).toBeNull();
    expect(a.gathering).toBe(a.id);
  });
});

describe('unease', () => {
  /** A shouter and a hearer 20 m apart on a street, nobody else near. */
  function shout(hearerSees: boolean) {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    for (const o of world.sims) if (o.insideBuilding === null && Math.hypot(o.x - p.x, o.y - p.y) < 80) o.insideBuilding = 0 as never;
    const shouter = walker(world, p.x, p.y);
    const hearer = walker(world, p.x + p.ux * 20, p.y + p.uy * 20);
    shouter.awareAt = 0;
    hearer.trust = 0;
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    if (!hearerSees) ctx.radius[hearer.id] = 10; // as at night: the shout carries further than sight
    const street = 0 as never;
    ctx.warnings.push({ from: shouter.id, x: shouter.x, y: shouter.y, street, danger: 0.8 });
    resolveEncounters(world, ctx);
    return { hearer, street };
  }

  it('a shout heard but not seen marks the street and unsettles, without telling what it was', () => {
    const { hearer, street } = shout(false);
    expect(hearer.awareAt).toBeNull();
    expect(hearer.unease).toBeCloseTo(baseConfig.unease.tellingGain[0]!); // a sceptic's first telling
    expect(hearer.streetMemory.get(street)?.danger).toBe(0.8);
  });

  it('seeing the one who shouted is a sighting', () => {
    expect(shout(true).hearer.awareAt).not.toBeNull();
  });

  it('being swept along by a running crowd unsettles but never tells', () => {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    const s = walker(world, p.x, p.y);
    sizeContext(ctx, world);
    for (let t = 0; t < 300; t++) {
      world.tick++;
      ctx.radius[s.id] = 45;
      ctx.fleeingSeen[s.id] = 10; // a crowd running this way
      updatePanic(world, ctx);
    }
    expect(s.awareAt).toBeNull();
    expect(s.unease).toBeGreaterThan(0.4);
    expect(s.unease).toBeLessThan(baseConfig.unease.believeAt);
  });
});

describe('objectives', () => {
  /** An aware civilian on a street, knowing only what it is given (nothing in sight). */
  function setUp() {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    const s = walker(world, p.x, p.y);
    s.awareAt = 0;
    s.caution = 0;
    world.tick = 1000;
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    ctx.radius[s.id] = 0; // choices from memory alone
    const near = world.buildings
      .filter((b) => b.tag === 'residential' && b.id !== s.home)
      .sort((m, n) => Math.hypot(m.entrances[0]!.x - p.x, m.entrances[0]!.y - p.y) - Math.hypot(n.entrances[0]!.x - p.x, n.entrances[0]!.y - p.y));
    const believe = (b: World['buildings'][number], occupants: number, fortification: number) =>
      s.buildingMemory.set(b.id, { believedOccupants: occupants, supplies: 0, fortification, observedAt: world.tick, visited: false });
    return { world, ctx, s, x: near[0]!, y: near[1]! , believe };
  }

  it('turns back from home on hearing its street is dangerous', () => {
    const { world, ctx, s, x, believe } = setUp();
    const home = world.buildings[s.home!]!;
    believe(x, 2, 0);
    setDestination(s, home, 'shelter');
    s.streetMemory.set(home.street, { danger: 1, observedAt: world.tick, visited: false });
    s.reconsider = true;
    reconsider(world, ctx, s);
    expect(s.destinationBuilding).not.toBe(home.id);
  });

  it('keeps its shelter for one only slightly better, takes one much better, and not twice running', () => {
    const { world, ctx, s, x, y, believe } = setUp();
    believe(x, 0, 0);
    believe(y, 1, 0); // a little company: slightly better
    setDestination(s, x, 'shelter');
    s.reconsider = true;
    reconsider(world, ctx, s);
    expect(s.destinationBuilding).toBe(x.id);
    believe(y, 8, 1); // a fortified, peopled house
    s.reconsider = true;
    reconsider(world, ctx, s);
    expect(s.destinationBuilding).toBe(y.id);
    believe(x, 8, 1);
    believe(y, 0, 0);
    s.reconsider = true;
    world.tick += 10; // within migration's cooldown
    reconsider(world, ctx, s);
    expect(s.destinationBuilding).toBe(y.id);
  });
});

describe('the intact dead', () => {
  it('one bite leaves nothing to see; more than one does', () => {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    const once = walker(world, p.x, p.y);
    const twice = walker(world, p.x + 2, p.y);
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    bite(world, ctx, once);
    bite(world, ctx, twice);
    bite(world, ctx, twice);
    once.turnsAt = twice.turnsAt = world.tick;
    convertDue(world, ctx);
    const z = (s: Sim) => world.zombies.find((x) => x.wasSim === s.id)!;
    expect(z(once).intact).toBe(true);
    expect(z(twice).intact).toBe(false);
  });

  /** A survivor on a street with one zombie `d` m up it. */
  function lookAt(d: number, intact: boolean, behind = false) {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    for (const z of world.zombies) if (z.state !== 'occupying') z.state = 'destroyed';
    for (const o of world.sims) o.weapon = null; // nobody to shoot it from a door first
    const s = walker(world, p.x, p.y);
    s.heading = Math.atan2(p.uy, p.ux) + (behind ? Math.PI : 0); // facing it, or away
    const z = spawnZombie(world, p.x + p.ux * d, p.y + p.uy * d, 'active', null, null);
    z.intact = intact;
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    return { world, ctx, s, z, seen: ctx.nearestZombie[s.id] === z.id };
  }

  it('one behind registers only much nearer: survivors see in a cone ahead of them', () => {
    expect(lookAt(25, false, true).seen).toBe(false);
    expect(lookAt(baseConfig.perception.dayRadius.standard * baseConfig.perception.rear - 2, false, true).seen).toBe(true);
  });

  it('is recognised only nearer, but never closer than its gait gives it away', () => {
    expect(lookAt(25, false).seen).toBe(true);
    expect(lookAt(25, true).seen).toBe(false);
    expect(lookAt(baseConfig.zombie.intactGiveaway - 1, true).seen).toBe(true);
  });

  it('loses it on its first grab, bite or miss', () => {
    const { world, ctx, s, z } = lookAt(0.5, true);
    z.nextAttackAt = world.tick;
    s.nextAttackAt = world.tick + 100; // the walker does not strike first (bare hands kill at 0.1)
    resolveCombat(world, ctx);
    expect(z.intact).toBe(false);
  });
});

describe('cars', () => {
  it('parks cars at the kerb and in the mall lot, none in a building or the river, and nobody walks through one', () => {
    const { world, ctx } = fresh();
    expect(world.cars.length).toBeGreaterThan(500);
    expect(world.cars.every((c) => c.state === 'parked' && ctx.map.walkable(c.x, c.y))).toBe(true);
    const lot = world.lots[0]!;
    const xs = lot.outline.map((p) => p.x), ys = lot.outline.map((p) => p.y);
    expect(world.cars.some((c) => c.x > Math.min(...xs) && c.x < Math.max(...xs) && c.y > Math.min(...ys) && c.y < Math.max(...ys))).toBe(true);
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    const c = world.cars[0]!;
    expect(ctx.cars.blocks(c.x, c.y)).toBe(true);
    expect(ctx.cars.blocks(c.x + Math.cos(c.heading) * 3, c.y + Math.sin(c.heading) * 3)).toBe(false);
  });

  /** An aware survivor beside a parked kerb car, bound for a house far off; the dead gone. */
  function driver() {
    const { world, ctx } = fresh();
    for (const z of world.zombies) z.state = 'destroyed';
    const car = world.cars.find((c) => world.lots.every((l) => Math.hypot(l.outline[0]!.x - c.x, l.outline[0]!.y - c.y) > 300))!;
    const s = walker(world, car.x + 3 * -Math.sin(car.heading), car.y + 3 * Math.cos(car.heading));
    s.awareAt = 0;
    s.trust = 1;
    s.archetype = 'civilian';
    const far = world.buildings.find((b) => b.tag === 'residential' && Math.hypot(b.entrances[0]!.x - car.x, b.entrances[0]!.y - car.y) > 900 && Math.hypot(b.entrances[0]!.x - car.x, b.entrances[0]!.y - car.y) < 1100)!;
    s.home = far.id;
    setDestination(s, far, 'shelter');
    return { world, ctx, s, car, far };
  }

  it('someone bound far off takes a car, drives, and gets out by the door', () => {
    const { world, ctx, s, car, far } = driver();
    let drove = false;
    for (let t = 0; t < 1200 && !(drove && s.car === null); t++) {
      step(world, ctx, { checkInvariant: false }); // the dead were cleared by hand, so the counters are off
      if (s.car !== null) drove = true;
    }
    expect(drove).toBe(true);
    expect(s.car).toBeNull();
    expect(car.state).toBe('parked');
    const e = far.entrances[0]!;
    expect(Math.hypot(e.x - s.x, e.y - s.y)).toBeLessThan(60);
  });

  it('a car stopped behind something for jamTicks is abandoned where it stands', () => {
    const { world, ctx, s, car } = driver();
    for (let t = 0; t < 200 && s.car === null; t++) step(world, ctx, { checkInvariant: false });
    expect(s.car).toBe(car.id);
    world.tick++;
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    decideCars(world, ctx); // facing the way it will go
    // Someone standing in the road in front of it, who will not move.
    const blocker = walker(world, car.x + Math.cos(car.heading) * 4, car.y + Math.sin(car.heading) * 4);
    blocker.stand = 'freeze';
    blocker.standUntil = 1e9;
    car.reroutes = baseConfig.cars.maxReroutes; // turned back as often as it may: no other way
    for (let t = 0; t <= baseConfig.cars.jamTicks + 1; t++) {
      world.tick++;
      sizeContext(ctx, world);
      rebuildHashes(world, ctx);
      decideCars(world, ctx);
      carProcesses(world, ctx);
    }
    expect(car.state).toBe('abandoned');
    expect(s.car).toBeNull();
  });

  it('a car drives round an abandoned car in its lane, without touching it, rather than stopping behind it', () => {
    const { world, ctx, s, car } = inCar();
    // Up to speed on its first street.
    for (let t = 0; t < 8; t++) step(world, ctx, { checkInvariant: false });
    expect(car.state).toBe('driving');
    // A wreck in its lane a little way ahead, pointing the same way.
    const wreck = world.cars.find((c) => c.state === 'parked' && c !== car && Math.hypot(c.x - car.x, c.y - car.y) > 200)!;
    wreck.state = 'abandoned';
    wreck.x = car.x + Math.cos(car.heading) * 18;
    wreck.y = car.y + Math.sin(car.heading) * 18;
    wreck.heading = car.heading;
    (ctx.cars as unknown as { signature: string }).signature = ''; // standing cars do not move: the index is rebuilt only when the moving set changes
    let passed = false, closest = Infinity;
    for (let t = 0; t < 60 && car.state === 'driving' && !passed; t++) {
      step(world, ctx, { checkInvariant: false });
      closest = Math.min(closest, Math.hypot(wreck.x - car.x, wreck.y - car.y));
      if ((wreck.x - car.x) * Math.cos(wreck.heading) + (wreck.y - car.y) * Math.sin(wreck.heading) < -baseConfig.cars.length) passed = true;
    }
    expect(passed).toBe(true);
    expect(car.state).toBe('driving');
    expect(s.car).toBe(car.id);
    expect(closest).toBeGreaterThanOrEqual(baseConfig.cars.width);
  });

  /** The driver() set-up, once it is in the car and facing the way it will go. */
  function inCar() {
    const d = driver();
    const { world, ctx, s } = d;
    for (let t = 0; t < 200 && s.car === null; t++) step(world, ctx, { checkInvariant: false });
    world.tick++;
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    decideCars(world, ctx);
    return d;
  }

  it('a car turns no faster than its turning circle allows, and slows to turn', () => {
    const { world, ctx, car } = inCar();
    const cc = baseConfig.cars;
    car.heading += Math.PI; // facing the wrong way at full speed
    car.speed = cc.maxSpeed;
    const before = car.heading;
    world.tick++;
    rebuildHashes(world, ctx);
    decideCars(world, ctx);
    const turned = Math.abs(Math.atan2(Math.sin(car.heading - before), Math.cos(car.heading - before)));
    expect(car.speed).toBeLessThan(cc.maxSpeed);
    expect(turned).toBeLessThanOrEqual(Math.max(cc.turnMin, car.speed / cc.turnRadius) + 1e-9);
  });

  it('a calm driver stops short of the dead in its path; one in flight rams them', () => {
    const { world, ctx, s, car } = inCar();
    const cc = baseConfig.cars;
    const z = spawnZombie(world, car.x + Math.cos(car.heading) * 6, car.y + Math.sin(car.heading) * 6, 'active', null, null);
    car.speed = 5;
    world.tick++;
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    decideCars(world, ctx);
    expect(car.speed).toBeLessThanOrEqual(6 - cc.length / 2 - cc.personGap + 1e-9);
    // In flight: no braking for it, and struck — destroyed at ramKill a blow.
    s.panic = 1;
    for (let t = 0; t < 30 && z.state !== 'destroyed'; t++) {
      // A miss throws the zombie clear of the bonnet, so put it back in front. The
      // kill itself is a roll (ramKill); thirty blows is enough that the seed's
      // position in the stream does not decide the test.
      z.x = car.x + Math.cos(car.heading) * 2;
      z.y = car.y + Math.sin(car.heading) * 2;
      car.speed = 5;
      rebuildHashes(world, ctx);
      carProcesses(world, ctx);
    }
    expect(z.state).toBe('destroyed');
  });

  it('driven into a building at speed, a car is wrecked where it hit, and the crash reported', () => {
    const { world, ctx, car } = inCar();
    const cc = baseConfig.cars;
    // Heading straight at the nearest building's middle, a little short of its wall.
    const b = world.buildings.reduce((best, x) => (Math.hypot(x.outline[0]!.x - car.x, x.outline[0]!.y - car.y) < Math.hypot(best.outline[0]!.x - car.x, best.outline[0]!.y - car.y) ? x : best));
    const cx = b.outline.reduce((a, p) => a + p.x / 4, 0), cy = b.outline.reduce((a, p) => a + p.y / 4, 0);
    const h = Math.atan2(cy - car.y, cx - car.x);
    let d = 0;
    while (ctx.map.buildingAt(cx - Math.cos(h) * d, cy - Math.sin(h) * d) !== null) d += 0.5; // to its wall
    car.x = cx - Math.cos(h) * (d + cc.length / 2 + 2);
    car.y = cy - Math.sin(h) * (d + cc.length / 2 + 2);
    car.heading = h;
    car.speed = cc.maxSpeed;
    moveCars(world, ctx);
    expect(car.impact).toBe(cc.maxSpeed); // stopped where it was
    world.events = [];
    ctx.events = [];
    carProcesses(world, ctx);
    expect(car.state).toBe('abandoned');
    expect(car.occupants).toHaveLength(0);
    expect(ctx.events.some((e) => e.type === 'carCrashed' && e.car === car.id)).toBe(true);
  });

  /** How many of a grid of points over the car's body lie inside buildings. */
  function bodyInWalls(ctx: ReturnType<typeof driver>['ctx'], car: { x: number; y: number; heading: number }): number {
    const l = baseConfig.cars.length / 2, w = baseConfig.cars.width / 2, c = Math.cos(car.heading), sn = Math.sin(car.heading);
    let k = 0;
    for (const u of [-l, -l / 2, 0, l / 2, l]) for (const v of [-w, 0, w]) if (ctx.map.buildingAt(car.x + c * u - sn * v, car.y + sn * u + c * v) !== null) k++;
    return k;
  }

  it('a car never drives its body into a building below crash speed, whole trip long', () => {
    const { world, ctx, s, car } = driver();
    let drove = false, worst = 0;
    for (let t = 0; t < 1200 && !(drove && s.car === null); t++) {
      step(world, ctx, { checkInvariant: false });
      if (car.state !== 'driving') continue;
      drove = true;
      worst = Math.max(worst, bodyInWalls(ctx, car));
    }
    expect(drove).toBe(true);
    expect(worst).toBe(0);
  });

  /** In a car facing the nearest building's wall from just short of it, slowly, wanting to go on through. */
  function nosed() {
    const got = inCar();
    const { world, ctx, car } = got;
    const b = world.buildings.reduce((best, x) => (Math.hypot(x.outline[0]!.x - car.x, x.outline[0]!.y - car.y) < Math.hypot(best.outline[0]!.x - car.x, best.outline[0]!.y - car.y) ? x : best));
    const cx = b.outline.reduce((a, p) => a + p.x / 4, 0), cy = b.outline.reduce((a, p) => a + p.y / 4, 0);
    const h = Math.atan2(cy - car.y, cx - car.x);
    let d = 0;
    while (ctx.map.buildingAt(cx - Math.cos(h) * d, cy - Math.sin(h) * d) !== null) d += 0.5;
    car.x = cx - Math.cos(h) * (d + baseConfig.cars.length / 2 + 0.3);
    car.y = cy - Math.sin(h) * (d + baseConfig.cars.length / 2 + 0.3);
    car.heading = h;
    car.destination = { x: cx, y: cy };
    car.route = [];
    car.routeIndex = 0;
    car.speed = 2;
    return got;
  }

  it('nosed up to a wall, a car steers or backs away from it rather than through it', () => {
    const { world, ctx, car } = nosed();
    expect(bodyInWalls(ctx, car)).toBe(0);
    for (let t = 0; t < 20; t++) {
      world.tick++;
      rebuildHashes(world, ctx);
      decideCars(world, ctx);
      moveCars(world, ctx);
      expect(bodyInWalls(ctx, car)).toBe(0);
    }
  });

  it('shuffling against a wall, a car is stopped all along: its clock is not reset by a metre each way', () => {
    const { world, ctx, car } = nosed();
    let since: number | null = null;
    for (let t = 0; t < 100; t++) {
      world.tick++;
      rebuildHashes(world, ctx);
      decideCars(world, ctx);
      moveCars(world, ctx);
      if (since === null) since = car.blockedSince;
      else expect(car.blockedSince).toBe(since);
    }
    expect(since).not.toBeNull();
    expect(Math.hypot(car.x - car.stuckAt!.x, car.y - car.stuckAt!.y)).toBeLessThanOrEqual(baseConfig.cars.unstuck);
  });

  it('a car stuck against a wall honks, and the horn grows with how long it has been stuck', () => {
    const { world, ctx, car } = nosed();
    const horn = baseConfig.cars.horn;
    car.blockedSince = null;
    car.stuckAt = null;
    ctx.events = [];
    const heard: number[] = [];
    let since: number | null = null;
    for (let t = 0; t < horn.full + horn.every + 5 && car.state === 'driving'; t++) {
      world.tick++;
      rebuildHashes(world, ctx);
      decideCars(world, ctx);
      if (since === null && car.blockedSince !== null) since = car.blockedSince;
      for (const e of ctx.events) {
        if (e.type !== 'carHorn') continue;
        const blockedFor = world.tick - car.blockedSince!;
        expect(e.car).toBe(car.id);
        expect(e.radius).toBe(horn.radius);
        expect(e.sim).toBeNull();
        expect(blockedFor).toBeGreaterThanOrEqual(horn.after);
        expect((car.id + blockedFor) % horn.every).toBe(0);
        expect(e.severity).toBe(Math.min(1, blockedFor / horn.full));
        expect(car.speed).toBeLessThanOrEqual(horn.creep);
        heard.push(e.severity);
      }
      ctx.events = [];
      moveCars(world, ctx);
    }
    expect(since).not.toBeNull();
    expect(heard.length).toBeGreaterThan(2);
    expect(heard[0]!).toBeLessThan(0.5);
    expect(heard.at(-1)).toBe(1);
    for (let i = 1; i < heard.length; i++) expect(heard[i]!).toBeGreaterThanOrEqual(heard[i - 1]!);
  });

  it('stuck rerouteAfter within parkStuck of where it is going, a car parks there and its people walk on', () => {
    const { world, ctx, car, s } = nosed();
    expect(Math.hypot(car.destination!.x - car.x, car.destination!.y - car.y)).toBeLessThan(baseConfig.cars.parkStuck);
    for (let t = 0; t < baseConfig.cars.rerouteAfter + 30 && car.state === 'driving'; t++) {
      world.tick++;
      rebuildHashes(world, ctx);
      decideCars(world, ctx);
      moveCars(world, ctx);
      carProcesses(world, ctx);
    }
    expect(car.state).toBe('parked');
    expect(s.car).toBeNull();
  });

  it('standing on a car with a wall straight ahead, someone gets off it another way', () => {
    const { world, ctx } = fresh();
    for (const z of world.zombies) z.state = 'destroyed';
    // A parked car moved alongside a building, its side against the wall, and someone on it facing the wall.
    const h = 0.3, off = baseConfig.cars.width / 2;
    const centre = (x: (typeof world.buildings)[number]) => ({ x: x.outline.reduce((a, p) => a + p.x / x.outline.length, 0), y: x.outline.reduce((a, p) => a + p.y / x.outline.length, 0) });
    const edge = (x: (typeof world.buildings)[number]) => {
      const c = centre(x);
      let d = 0;
      while (ctx.map.buildingAt(c.x + Math.cos(h) * d, c.y + Math.sin(h) * d) !== null) d += 0.1;
      return { x: c.x + Math.cos(h) * (d + off), y: c.y + Math.sin(h) * (d + off), c };
    };
    // One whose wall has open ground beside it, room for the car and to step off it.
    const b = world.buildings.find((x) => {
      const c = centre(x);
      if (x.tag !== 'residential' || ctx.map.buildingAt(c.x, c.y) !== x.id) return false;
      const e = edge(x);
      return [0, 1, 2, 3, 4].every((k) => ctx.map.walkable(e.x + Math.cos(h) * k, e.y + Math.sin(h) * k));
    })!;
    const { x: ex, y: ey, c: { x: cx, y: cy } } = edge(b);
    const car = world.cars[0]!;
    car.x = ex;
    car.y = ey;
    car.heading = h + Math.PI / 2;
    const s = walker(world, car.x, car.y);
    const wall = h + Math.PI;
    sizeContext(ctx, world);
    (ctx.cars as unknown as { signature: string }).signature = ''; // a standing car moved by hand
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    expect(ctx.cars.standing(s.x, s.y)).toBe(true);
    for (let t = 0; t < 60 && ctx.cars.standing(s.x, s.y); t++) {
      s.heading = wall; // still wanting the wall
      s.destination = { x: cx, y: cy };
      integrateMovement(world, ctx);
    }
    expect(ctx.cars.standing(s.x, s.y)).toBe(false);
  });

  it('an armed alarm goes off once, as the car is taken, and frightens nobody', () => {
    const d = driver();
    const { world, ctx, s, car } = d;
    car.alarm = true;
    let alarms = 0, events = 0;
    for (let t = 0; t < 260 && !(s.car !== null && world.tick > 60 + (car.alarmUntil ?? 0)); t++) {
      const before = world.sims.map((x) => x.panic);
      step(world, ctx, { checkInvariant: false });
      alarms += world.stimuli.filter((n) => n.kind === 'alarm' && n.createdAt === world.tick).length;
      events += world.events.filter((e) => e.type === 'carAlarm' && e.car === car.id).length;
      // Nobody's panic rises from it: only alarms were new near the car (the dead are cleared).
      expect(world.sims.every((x, i) => x.panic <= (before[i] ?? 0) + 1e-9 || Math.hypot(x.x - car.x, x.y - car.y) > baseConfig.cars.alarm.noise)).toBe(true);
    }
    expect(s.car).toBe(car.id);
    expect(events).toBe(1);
    expect(alarms).toBe(Math.ceil(baseConfig.cars.alarm.ticks / baseConfig.cars.alarm.every));
    expect(car.alarm).toBe(false);
    expect(car.alarmUntil).toBeNull();
  });

  it('a police car on the move sounds its siren only with features.sirens', () => {
    for (const on of [false, true]) {
      const { world, ctx, car } = inCar();
      world.config = { ...world.config, features: { ...world.config.features, sirens: on } };
      car.home = 0 as typeof car.home; // a service vehicle: one with a home
      let sirens = 0;
      for (let t = 0; t < baseConfig.cars.siren.every; t++) {
        world.tick++;
        sizeContext(ctx, world);
        rebuildHashes(world, ctx);
        decideCars(world, ctx);
        sirens += world.stimuli.filter((n) => n.kind === 'siren' && n.createdAt === world.tick).length;
      }
      expect(sirens).toBe(on ? 1 : 0);
    }
  }, 30_000); // two worlds set up and driven: slow on a busy host

  it('a car being driven makes engine noise, which frightens nobody', () => {
    const { world, ctx, car } = inCar();
    let engines = 0;
    for (let t = 0; t < baseConfig.cars.engineInterval; t++) {
      world.tick++;
      sizeContext(ctx, world);
      rebuildHashes(world, ctx);
      decideCars(world, ctx);
      engines += world.stimuli.filter((n) => n.kind === 'engine' && n.createdAt === world.tick && n.x === car.x && n.y === car.y).length;
    }
    expect(engines).toBe(1);
    world.tick++;
    computePerception(world, ctx);
    // The same panic step with and without the engine's noise: the engine alone changes nothing.
    const start = world.sims.map((x) => ({ panic: x.panic, unease: x.unease, awareAt: x.awareAt }));
    updatePanic(world, ctx);
    const withEngine = world.sims.map((x) => x.panic);
    world.sims.forEach((x, i) => Object.assign(x, start[i]));
    const stimuli = world.stimuli;
    world.stimuli = stimuli.filter((n) => n.kind !== 'engine');
    updatePanic(world, ctx);
    world.stimuli = stimuli;
    expect(world.sims.every((x, i) => Math.abs(x.panic - withEngine[i]!) < 1e-12)).toBe(true);
  });

  it('the dead at an occupied car break in, and everyone inside is out among them', () => {
    const { world, ctx, s, car } = inCar();
    for (let k = 0; k < 6; k++) spawnZombie(world, car.x + Math.cos((k * Math.PI) / 3) * 2.5, car.y + Math.sin((k * Math.PI) / 3) * 2.5, 'active', null, null);
    for (let t = 0; t < 200 && car.state === 'driving'; t++) {
      world.tick++;
      sizeContext(ctx, world);
      rebuildHashes(world, ctx);
      carProcesses(world, ctx);
    }
    expect(car.state).toBe('abandoned');
    expect(s.car).toBeNull();
  });

  it('someone turning inside leaves the car stopped, and the others out', () => {
    const { world, ctx, s, car } = inCar();
    const passenger = walker(world, car.x, car.y);
    passenger.car = car.id;
    car.occupants.push(passenger.id);
    bite(world, ctx, s);
    s.turnsAt = world.tick;
    convertDue(world, ctx);
    expect(car.state).toBe('abandoned');
    expect(car.occupants).toHaveLength(0);
    expect(passenger.car).toBeNull();
  });
});

describe('the especially cautious', () => {
  it('do not take an unknown street, or an old quiet report, for safe; everyone else does', () => {
    const { world } = fresh();
    const p = streetPoint(world);
    const bold = walker(world, p.x, p.y);
    const wary = walker(world, p.x, p.y);
    bold.caution = 0.5;
    wary.caution = 1;
    const m = baseConfig.memory;
    const unknown = 1 as never, quietNow = 2 as never, quietLongAgo = 3 as never;
    world.tick = 10_000;
    for (const s of [bold, wary]) {
      s.streetMemory.set(quietNow, { danger: 0, observedAt: world.tick, visited: true });
      s.streetMemory.set(quietLongAgo, { danger: 0, observedAt: world.tick - m.halfLife, visited: true });
    }
    const d = (s: Sim, st: never) => believedDanger(s, st, world.tick, baseConfig);
    expect([d(bold, unknown), d(bold, quietNow), d(bold, quietLongAgo)]).toEqual([0, 0, 0]);
    expect(d(wary, unknown)).toBeCloseTo(m.unknownStreetDanger);
    expect(d(wary, quietNow)).toBe(0);
    expect(d(wary, quietLongAgo)).toBeCloseTo(m.unknownStreetDanger / 2); // a half-life old: halfway back
  });
});

describe('strangers at the door', () => {
  /** A house that knows of the outbreak with one survivor inside of the given caution, and someone arriving at its door. */
  function arrive(insiderCaution: number, comingHome: boolean) {
    const cfg = structuredClone(baseConfig);
    cfg.shelter.strangerVeto = 1; // a certain veto, to test who it applies to
    const { world, ctx } = fresh(cfg);
    const b = world.buildings.find((x) => x.tag === 'residential' && x.zombiesInside === 0 && x.sheltered.length === 0)!;
    const e = b.entrances[0]!;
    const inside = walker(world, e.x, e.y);
    inside.caution = insiderCaution;
    inside.insideBuilding = b.id;
    b.sheltered.push(inside.id);
    b.alertedAt = 0;
    const s = walker(world, e.x, e.y);
    s.awareAt = 0;
    if (comingHome) s.home = b.id;
    setDestination(s, b, 'shelter');
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    buildingProcesses(world, ctx);
    return { s, b, world };
  }

  it('the especially cautious inside keep a stranger out', () => {
    const { s, b } = arrive(1, false);
    expect(s.insideBuilding).toBeNull();
    expect(s.refusedBy).toBe(b.id);
  });

  it('but let someone come home', () => {
    const { s, b } = arrive(1, true);
    expect(s.insideBuilding).toBe(b.id);
  });

  it('and nobody below the threshold refuses anyone', () => {
    const { s, b } = arrive(baseConfig.shelter.strangerVetoFrom - 0.01, false);
    expect(s.insideBuilding).toBe(b.id);
  });
});

describe('release', () => {
  it('from a building that knows: households stay home, workers leave knowing', () => {
    const { world, ctx } = fresh();
    const quiet = (b: World['buildings'][number]) => b.zombiesInside === 0 && b.sheltered.length === 0 && b.alertedAt === null;
    const office = world.buildings.find((b) => b.tag === 'office' && quiet(b) && b.residents >= 2)!;
    // At 09:00 a house holds one at most. Doors well apart, so whoever comes out of one is not counted for another.
    const apart = (a: World['buildings'][number], b: World['buildings'][number]) => Math.hypot(a.entrances[0]!.x - b.entrances[0]!.x, a.entrances[0]!.y - b.entrances[0]!.y) > 20;
    const house = world.buildings.find((b) => b.tag === 'residential' && quiet(b) && apart(b, office))!;
    const other = world.buildings.find((b) => b.tag === 'residential' && quiet(b) && apart(b, office) && apart(b, house))!;
    house!.residents = other!.residents = 3;
    house!.supplies = other!.supplies = 20; // stocked: nobody steps out to scavenge
    office.alertedAt = house!.alertedAt = 0;
    for (const b of [office, house!, other!]) b.pendingRelease = 2;
    const before = world.sims.length;
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    buildingProcesses(world, ctx);
    const out = world.sims.slice(before);
    const from = (b: typeof office) => out.filter((s) => b.entrances.some((e) => Math.hypot(e.x - s.x, e.y - s.y) < 3));
    expect(from(house!)).toHaveLength(0);
    expect(house!.pendingRelease).toBe(0);
    expect(from(office).length).toBe(2);
    expect(from(office).every((s) => s.awareAt !== null)).toBe(true);
    expect(from(other!).length).toBe(2);
    expect(from(other!).every((s) => s.awareAt === null)).toBe(true);
  });
});

describe('the dead', () => {
  it('a zombie that sights someone wakes the dormant dead near it', () => {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    const s = walker(world, p.x, p.y);
    const z = spawnZombie(world, p.x + p.ux * 5, p.y + p.uy * 5, 'active', null, null);
    const sleeper = spawnZombie(world, p.x + p.ux * 20, p.y + p.uy * 20, 'dormant', null, null);
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    world.tick = sleeper.id; // a tick on which the sleeper would not check for waking itself
    zombieDecisions(world, ctx);
    expect(z.target).toBe(s.id);
    expect(sleeper.state).toBe('active');
    expect(sleeper.heardPoint).not.toBeNull();
  });

  it('one whose quarry goes indoors besieges that door', () => {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    const s = walker(world, p.x, p.y);
    const b = world.buildings.find((x) => Math.hypot(x.entrances[0]!.x - p.x, x.entrances[0]!.y - p.y) < 60)!;
    const z = spawnZombie(world, p.x + p.ux * 5, p.y + p.uy * 5, 'active', null, null);
    s.insideBuilding = b.id;
    b.sheltered.push(s.id);
    // Nobody else in sight to chase instead.
    for (const o of world.sims) if (o !== s && o.insideBuilding === null && Math.hypot(o.x - p.x, o.y - p.y) < 100) o.insideBuilding = b.id;
    z.target = s.id;
    z.targetSeenAt = world.tick;
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    zombieDecisions(world, ctx);
    expect(z.target).toBeNull();
    expect(z.besieging).toBe(b.id);
    // At the door, it batters it: backs off a step, then comes on into it again, over and over.
    const door = z.heardPoint!;
    const zc = baseConfig.zombie;
    const dist: number[] = [];
    for (let t = 0; t < 100 + 6 * zc.ram.cycle; t++) { // up to the door (some way off), then six cycles
      world.tick++;
      rebuildHashes(world, ctx);
      computePerception(world, ctx);
      zombieDecisions(world, ctx);
      integrateMovement(world, ctx);
      dist.push(Math.hypot(z.x - door.x, z.y - door.y));
    }
    expect(z.besieging).toBe(b.id);
    const at = dist.findIndex((d) => d <= zc.arriveRadius);
    expect(at).toBeGreaterThanOrEqual(0);
    const after = dist.slice(at);
    let lunges = 0;
    for (let i = 1; i < after.length; i++) if (after[i]! < after[i - 1]! - 0.3) lunges++;
    expect(lunges).toBeGreaterThanOrEqual(3);
    expect(Math.max(...after)).toBeLessThan(zc.arriveRadius + 2); // never far from it
  });
});

describe('911', () => {
  it('garrisons first responders at stations, and sends them to a call', () => {
    const { world, ctx } = fresh();
    const responders = world.sims.filter((s) => s.station !== null);
    expect(responders.length).toBeGreaterThan(0);
    expect(responders.every((s) => s.archetype === 'police' && s.insideBuilding === s.station)).toBe(true);

    const station = world.buildings[responders[0]!.station!]!;
    const b = world.buildings.find((x) => x.tag !== 'policeStation' && Math.hypot(x.entrances[0]!.x - station.entrances[0]!.x, x.entrances[0]!.y - station.entrances[0]!.y) < 300)!;
    const caller = walker(world, b.entrances[0]!.x, b.entrances[0]!.y);
    caller.sightedAt = world.tick - 5;
    placeCall(world, caller, b);
    expect(b.callAt).toBe(world.tick);
    world.tick = Math.ceil((world.tick + 1) / world.config.dispatch.interval) * world.config.dispatch.interval;
    dispatchCalls(world, ctx);
    expect(b.dispatchedAt).toBe(world.tick);
    expect(world.sims.filter((s) => s.answering === b.id).length).toBeGreaterThan(0);
    expect(ctx.events.some((e) => e.type === 'policeDispatched' && e.building === b.id)).toBe(true);
  });

  it('nobody calls without having just seen a zombie', () => {
    const { world } = fresh();
    const b = world.buildings[0]!;
    placeCall(world, walker(world, b.entrances[0]!.x, b.entrances[0]!.y), b);
    expect(b.callAt).toBeNull();
  });
});

describe('the faithful', () => {
  it('know a church from the start and shelter only in churches', () => {
    const cfg = structuredClone(baseConfig);
    cfg.faithful.share = 1;
    const { world, ctx } = fresh(cfg);
    const p = streetPoint(world);
    const s = walker(world, p.x, p.y);
    expect(s.church).not.toBeNull();
    expect(world.buildings[s.church!]!.tag).toBe('church');
    expect(s.buildingMemory.has(s.church!)).toBe(true);
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    expect(chooseShelter(world, ctx, s, null)!.tag).toBe('church');
    // Turned away by its church, and knowing no other, it shelters anywhere.
    s.refusedBy = s.church;
    expect(chooseShelter(world, ctx, s, s.church)!.tag).not.toBe('church');
  });
});

describe('police', () => {
  it('are cops of working age, wherever they came from', () => {
    const { world } = fresh();
    const police = world.sims.filter((s) => s.archetype === 'police');
    expect(police.length).toBeGreaterThan(0);
    for (const s of police) {
      expect(world.config.spawn.policeProfessions).toContain(s.profession);
      expect(s.age).toBeGreaterThanOrEqual(22);
      expect(s.age).toBeLessThanOrEqual(60);
      if (s.squadLeader === null) expect(s.weapon).toBe('pistol'); // SWAT carry their own
    }
    // ...and every cop is police.
    expect(world.sims.filter((s) => (world.config.spawn.policeProfessions as readonly string[]).includes(s.profession)).every((s) => s.archetype === 'police')).toBe(true);
  });
});

describe('shots fired', () => {
  it('police drop what they are doing and run for gunfire they hear', () => {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    const cop = walker(world, p.x, p.y);
    cop.archetype = 'police';
    cop.weapon = 'pistol';
    cop.ammo = 12;
    cop.awareAt = 0;
    const sx = p.x + p.ux * 50, sy = p.y + p.uy * 50;
    world.tick += 1;
    world.stimuli.push({ x: sx, y: sy, kind: 'pistol', radius: 120, intensity: 1, createdAt: world.tick - 1, expiresAt: world.tick + 30, from: null });
    decide(world, ctx);
    expect(cop.destinationKind).toBe('respond');
    expect(cop.destination).toEqual({ x: sx, y: sy });
    expect(cop.gait).toBe('run');
  });
});

describe('firing from inside', () => {
  it('an armed sim sheltering in an alerted building fires on the dead at its door', () => {
    const { world, ctx } = fresh();
    const b = world.buildings.find((x) => x.residents > 0 && x.zombiesInside === 0)!;
    const e = b.entrances[0]!;
    const s = spawnSim(world, { x: e.x, y: e.y, insideBuilding: b.id, sourceTag: b.tag, initialPanic: 0, destinationKind: 'shelter' });
    b.sheltered.push(s.id);
    s.shelter = b.id;
    s.weapon = 'shotgun';
    s.ammo = 6;
    b.alertedAt = 0;
    spawnZombie(world, e.x + 4, e.y + 4, 'active', null, null);
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    world.tick = Math.ceil(world.tick / 5) * 5 + (s.id % 5) + 5; // its turn on the armed stagger
    resolveCombat(world, ctx);
    expect(s.ammo).toBe(5);
    expect(world.stimuli.some((x) => x.from === b.id && x.kind === 'shotgun')).toBe(true);
  });
});

describe('fortification stages', () => {
  it('a building that knows, with someone inside and the door shut a minute, is barricaded; reinforcement and fortification follow fortification', () => {
    const { world } = fresh();
    const b = world.buildings.find((x) => x.residents > 0 && x.tag === 'residential')!; // a house can be fortified
    expect(stageOf(world, b)).toBe('open'); // unaware
    b.alertedAt = world.tick;
    expect(stageOf(world, b)).toBe('open'); // not yet
    world.tick += world.config.buildings.stages.barricadeTicks;
    expect(stageOf(world, b)).toBe('barricaded');
    b.fortification = 0.5;
    expect(stageOf(world, b)).toBe('reinforced');
    b.fortification = 0.9;
    expect(stageOf(world, b)).toBe('fortified');
    openDoor(world, b);
    expect(stageOf(world, b)).toBe('open'); // someone came or went
  });

  it('integrity caps the stage: a supermarket stays barricaded however much work goes in', () => {
    const { world } = fresh();
    const b = world.buildings.find((x) => x.residents > 0 && x.tag === 'supermarket')!;
    b.alertedAt = world.tick;
    b.fortification = 1;
    world.tick += world.config.buildings.stages.barricadeTicks;
    expect(stageOf(world, b)).toBe('barricaded');
  });

  it('the dead break in only once they have worn the door to nothing', () => {
    const { world, ctx } = fresh();
    const b = world.buildings.find((x) => x.residents > 0 && x.zombiesInside === 0 && x.tag === 'residential')!;
    const iv = baseConfig.buildings.breach.interval;
    b.fortification = 0.002;
    b.supplies = 0; // nothing to repair it with
    b.barricadedAt = world.tick; // and the furniture already against it
    const e = b.entrances[0]!;
    spawnZombie(world, e.x + 1, e.y + 1, 'active', null, null);
    sizeContext(ctx, world);
    const breached = () => ctx.events.some((x) => x.type === 'buildingBreached' && x.building === b.id);
    let was = b.fortification;
    for (let k = 0; k < 100 && !breached(); k++) {
      world.tick = (Math.floor(world.tick / iv) + 1) * iv + (b.id % iv);
      rebuildHashes(world, ctx);
      buildingProcesses(world, ctx, () => {});
      if (!breached()) {
        expect(b.fortification).toBeGreaterThan(0);
        expect(b.fortification).toBeLessThan(was);
      }
      was = b.fortification;
    }
    expect(breached()).toBe(true);
    expect(b.fortification).toBe(0);
  });
});

describe('bites add up', () => {
  it('each bite after the first halves the time left to turning', () => {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    const s = walker(world, p.x, p.y);
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    bite(world, ctx, s);
    expect(s.condition).toBe('infected');
    expect(s.bites).toBe(1);
    const left = s.turnsAt! - world.tick;
    bite(world, ctx, s);
    expect(s.bites).toBe(2);
    expect(s.turnsAt! - world.tick).toBe(Math.ceil(left * world.config.infection.rebiteFactor));
  });
});

describe('company', () => {
  /** An aware survivor at a street point with `n` calm others close round it; everyone else outdoors gone. */
  function scene(n: number, sociality: number, panic: number, cfg: Config = baseConfig) {
    const { world, ctx } = fresh(cfg);
    for (const z of world.zombies) z.state = 'destroyed';
    for (const s of world.sims) if (s.insideBuilding === null) s.condition = 'dead';
    const p = streetPoint(world);
    const s = walker(world, p.x, p.y);
    s.awareAt = 0;
    s.sociality = sociality;
    s.panic = panic;
    for (let i = 0; i < n; i++) {
      const o = walker(world, p.x + p.ux * (i + 1) * 1.5, p.y + p.uy * (i + 1) * 1.5);
      o.awareAt = 0;
      o.gait = 'walk';
    }
    const run = (ticks: number) => {
      for (let t = 0; t < ticks; t++) {
        world.tick++;
        sizeContext(ctx, world);
        rebuildHashes(world, ctx);
        computePerception(world, ctx);
        updatePanic(world, ctx);
      }
    };
    return { world, ctx, s, run };
  }

  it('counts the calm close by, not those running', () => {
    const calm = scene(4, 1, 0);
    calm.run(1);
    expect(calm.ctx.company[calm.s.id]).toBe(4);
    const running = scene(4, 1, 0);
    for (const o of running.world.sims) if (o !== running.s && o.condition !== 'dead' && o.insideBuilding === null) o.gait = 'run';
    running.run(1);
    expect(running.ctx.company[running.s.id]).toBe(0);
  });

  it('calm company holds the nerve of the sociable when it is tested, not the solitary', () => {
    const s = scene(0, 1, 0).s;
    s.nerve = 0.4;
    s.panic = 0.6;
    expect(breaks(s, baseConfig, 0)).toBe(true);
    expect(breaks(s, baseConfig, 4)).toBe(false); // 0.4 + 0.3 × 1 × 1
    expect(breaks(s, baseConfig, 1)).toBe(true); // a quarter of it
    s.sociality = 0;
    expect(breaks(s, baseConfig, 4)).toBe(true);
    s.sociality = 1;
    expect(breaks(s, { ...baseConfig, features: { ...baseConfig.features, company: false } }, 4)).toBe(true);
  });
});
