import { describe, expect, it } from 'vitest';
import { config as baseConfig, type Config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { spawnSim, spawnZombie } from '../src/sim/spawn';
import type { Sim, World } from '../src/sim/state';
import { merge, resolveEncounters } from '../src/sim/systems/encounters';
import { computePerception, rebuildHashes } from '../src/sim/systems/perception';
import { simDecisions } from '../src/sim/systems/sims';
import { openDoor, setDestination, stageOf } from '../src/sim/systems/common';
import { buildingProcesses } from '../src/sim/systems/buildings';
import { dispatchCalls, placeCall } from '../src/sim/systems/dispatch';
import { chooseShelter } from '../src/sim/systems/shelter';
import { zombieDecisions } from '../src/sim/systems/zombies';
import { bite, resolveCombat } from '../src/sim/systems/combat';

function fresh(cfg: Config = baseConfig) {
  return createWorld({ ...defaultScenario, runSeed: 7 }, cfg);
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
  function cornered(armed: boolean) {
    const cfg = structuredClone(baseConfig);
    cfg.behaviour.doorSearchRadius = 0;
    const { world, ctx } = fresh(cfg);
    const p = streetPoint(world);
    const s = walker(world, p.x, p.y);
    if (armed) s.weapon = 'club';
    for (const side of [1, -1]) spawnZombie(world, p.x + p.ux * 5 * side, p.y + p.uy * 5 * side, 'active', null, null);
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
      expect(s.weapon).toBe('pistol');
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

  it('one zombie cannot break a barricade; at an open door it can', () => {
    const cfg = structuredClone(baseConfig);
    cfg.buildings.breach.base = 100; // every roll would succeed
    const { world, ctx } = fresh(cfg);
    const b = world.buildings.find((x) => x.residents > 0 && x.zombiesInside === 0)!;
    b.alertedAt = 0;
    world.tick = Math.ceil((world.config.buildings.stages.barricadeTicks + 1) / cfg.buildings.breach.interval) * cfg.buildings.breach.interval + (b.id % cfg.buildings.breach.interval);
    const e = b.entrances[0]!;
    spawnZombie(world, e.x + 1, e.y + 1, 'active', null, null);
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    const breached = () => ctx.events.some((x) => x.type === 'buildingBreached' && x.building === b.id);
    buildingProcesses(world, ctx, () => {});
    expect(breached()).toBe(false);
    openDoor(world, b);
    world.tick += cfg.buildings.breach.interval;
    rebuildHashes(world, ctx);
    buildingProcesses(world, ctx, () => {});
    expect(breached()).toBe(true);
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
