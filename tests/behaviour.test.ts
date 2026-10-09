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
import { setDestination } from '../src/sim/systems/common';
import { dispatchCalls, placeCall } from '../src/sim/systems/dispatch';
import { chooseShelter } from '../src/sim/systems/shelter';
import { zombieDecisions } from '../src/sim/systems/zombies';

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

    b.archetype = 'hunkerDown'; // goes home from anywhere in the city
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
  it('a sociable sim bound for a far shelter goes along with someone bound for a nearer one', () => {
    const cfg = structuredClone(baseConfig);
    cfg.archetypes.civilian.sociality = 1;
    const { world, ctx } = fresh(cfg);
    const p = streetPoint(world);
    const a = walker(world, p.x, p.y);
    const b = walker(world, p.x + 1, p.y);
    a.awareAt = 0;
    b.awareAt = 0;
    const byDistance = [...world.buildings].sort(
      (m, n) => Math.hypot(m.entrances[0]!.x - p.x, m.entrances[0]!.y - p.y) - Math.hypot(n.entrances[0]!.x - p.x, n.entrances[0]!.y - p.y),
    );
    setDestination(a, byDistance[200]!, 'shelter');
    setDestination(b, byDistance[1]!, 'shelter');
    a.lastMergeAt = b.lastMergeAt = -1000;
    sizeContext(ctx, world);
    resolveEncounters(world, ctx);
    expect(a.destinationBuilding).toBe(byDistance[1]!.id);
    expect(b.destinationBuilding).toBe(byDistance[1]!.id);
  });

  it('a loner never goes along', () => {
    const { world, ctx } = fresh();
    const p = streetPoint(world);
    const a = walker(world, p.x, p.y);
    const b = walker(world, p.x + 1, p.y);
    a.archetype = 'loner';
    a.awareAt = b.awareAt = 0;
    const far = world.buildings[world.buildings.length - 1]!;
    const near = world.buildings.find((x) => Math.hypot(x.entrances[0]!.x - p.x, x.entrances[0]!.y - p.y) < 100)!;
    setDestination(a, far, 'shelter');
    setDestination(b, near, 'shelter');
    a.lastMergeAt = b.lastMergeAt = -1000;
    sizeContext(ctx, world);
    resolveEncounters(world, ctx);
    expect(a.destinationBuilding).toBe(far.id);
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
    world.stimuli.push({ x: sx, y: sy, kind: 'pistol', radius: 120, intensity: 1, createdAt: world.tick - 1, expiresAt: world.tick + 30 });
    decide(world, ctx);
    expect(cop.destinationKind).toBe('respond');
    expect(cop.destination).toEqual({ x: sx, y: sy });
    expect(cop.gait).toBe('run');
  });
});
