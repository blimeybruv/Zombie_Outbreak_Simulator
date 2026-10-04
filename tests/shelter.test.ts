import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import type { Context } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { spawnSim, spawnZombie } from '../src/sim/spawn';
import { transfer } from '../src/sim/counters';
import type { Building, BuildingId, World } from '../src/sim/state';
import { buildingProcesses } from '../src/sim/systems/buildings';
import { rebuildHashes } from '../src/sim/systems/perception';
import { deliver, doorThreat, shelterWork } from '../src/sim/systems/shelter';
import { assertInvariant, step } from '../src/sim/tick';

function fresh(cfg = config) {
  return createWorld({ ...defaultScenario, runSeed: 7 }, cfg);
}

/** A quiet building away from the outbreak with at least `n` residents. */
function quietHouse(world: World, ctx: Context, n: number): Building {
  rebuildHashes(world, ctx);
  const b = world.buildings.find((x) => x.residents >= n && x.zombiesInside === 0 && queuedOf(x) === 0 && doorThreat(world, ctx, x) === 0);
  if (!b) throw new Error('no quiet building');
  return b;
}

function queuedOf(b: Building): number {
  return b.pendingRelease + b.pendingExpel + b.pendingTurn + b.pendingDie;
}

/** Runs only the building side of the economy for one building, advancing the clock. */
function work(world: World, ctx: Context, b: Building, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    world.tick++;
    shelterWork(world, ctx, b, queuedOf(b));
  }
}

describe('fortification', () => {
  it('rises only once the building is alerted, consuming materials, and decays without them', () => {
    const { world, ctx } = fresh();
    const b = quietHouse(world, ctx, 2);
    b.materials = 4;
    work(world, ctx, b, 200);
    expect(b.fortification).toBe(0); // unaware residents do nothing

    b.alertedAt = world.tick;
    work(world, ctx, b, 100);
    expect(b.fortification).toBeGreaterThan(0);
    expect(b.materials).toBeLessThan(4);

    work(world, ctx, b, 400);
    expect(b.materials).toBe(0);
    const peak = b.fortification;
    b.scavengerOut = null;
    b.residents = 1; // nobody can be spared, so nobody goes out
    b.sheltered = [];
    work(world, ctx, b, 600);
    expect(b.fortification).toBeLessThan(peak);
    expect(b.fortification).toBeGreaterThan(0); // asymptotic, never linear to zero
  });
});

describe('resident scavengers', () => {
  it('sends one resident out for materials, tracked from then on, without changing the counters', () => {
    const { world, ctx } = fresh();
    const b = quietHouse(world, ctx, 2);
    b.materials = 0;
    b.alertedAt = 0;
    const before = structuredClone(world.counters);
    const residents = b.residents;
    const sims = world.sims.length;
    work(world, ctx, b, config.roles.interval);

    expect(world.sims.length).toBe(sims + 1);
    const s = world.sims[sims]!;
    expect(b.residents).toBe(residents - 1);
    expect(b.sheltered).toContain(s.id);
    expect(s.shelter).toBe(b.id);
    expect(s.role).toBe('scavenger');
    expect(s.destinationKind).toBe('scavenge');
    expect(s.destinationBuilding).not.toBe(b.id);
    expect(b.scavengerOut).toBe(s.id);
    expect(world.counters).toEqual(before);
    assertInvariant(world);

    // Only one at a time.
    work(world, ctx, b, config.roles.interval * 3);
    expect(world.sims.length).toBe(sims + 1);
  });

  it.each([
    [0, 1],
    [1, 0],
  ])('with minStayBehind %i, a lone resident sends %i out', (stay, out) => {
    const cfg = structuredClone(config);
    cfg.roles.minStayBehind = stay;
    const { world, ctx } = fresh(cfg);
    const b = quietHouse(world, ctx, 1);
    b.residents = 1;
    b.materials = 0;
    b.alertedAt = 0;
    const sims = world.sims.length;
    work(world, ctx, b, cfg.roles.interval * 2);
    expect(world.sims.length).toBe(sims + out);
  });
});

describe('delivery', () => {
  it('hands materials to the shelter, counts them in history and emits an event', () => {
    const { world, ctx } = fresh();
    const b = quietHouse(world, ctx, 1);
    b.materials = 0;
    const e = b.entrances[0]!;
    const s = spawnSim(world, { x: e.x, y: e.y, insideBuilding: null, sourceTag: b.tag, initialPanic: 0, destinationKind: 'shelter' });
    s.materials = 5;
    s.role = 'scavenger';
    s.shelter = b.id;
    b.scavengerOut = s.id;
    deliver(world, ctx, s, b);
    expect(b.materials).toBe(5);
    expect(s.materials).toBe(0);
    expect(s.history.materialsDelivered).toBe(5);
    expect(s.role).toBeNull();
    expect(b.scavengerOut).toBeNull();
    expect(ctx.events.some((x) => x.type === 'materialsDelivered' && x.amount === 5)).toBe(true);
  });
});

/** Puts a tracked sim inside a building, keeping the counters straight. */
function placeInside(world: World, b: Building) {
  const e = b.entrances[0]!;
  const s = spawnSim(world, { x: e.x, y: e.y, insideBuilding: b.id, sourceTag: b.tag, initialPanic: 0, destinationKind: 'shelter' });
  b.residents--; // the resident becomes this tracked sim
  b.sheltered.push(s.id);
  s.shelter = b.id;
  return s;
}

/** Puts occupiers inside, as if a breach had happened, keeping the counters straight. */
function occupy(world: World, b: Building, n: number): void {
  for (let i = 0; i < n; i++) {
    spawnZombie(world, b.entrances[0]!.x, b.entrances[0]!.y, 'occupying', b.id, null);
    b.residents--;
    b.zombiesInside++;
    transfer(world, 'unturned.indoors', 'turned.occupying');
  }
  b.occupiedAt = world.tick;
}

describe('occupation contest', () => {
  it('an armed sim with the odds clears the occupiers and the building is retaken', () => {
    const { world, ctx } = fresh();
    const b = quietHouse(world, ctx, 4);
    const s = placeInside(world, b);
    s.archetype = 'police';
    s.weapon = 'shotgun';
    s.ammo = 30;
    occupy(world, b, 2);
    assertInvariant(world);
    let retaken = false;
    for (let i = 0; i < 300 && b.zombiesInside > 0 && s.condition === 'healthy'; i++) {
      step(world, ctx, { checkInvariant: true });
      retaken ||= world.events.some((x) => x.type === 'buildingRetaken' && x.building === b.id);
    }
    if (s.condition === 'healthy') {
      expect(b.zombiesInside).toBe(0);
      expect(retaken).toBe(true);
      expect(s.history.kills).toBeGreaterThanOrEqual(2);
    }
    assertInvariant(world);
  });

  it('an unarmed sim does not fight: it heads for the door, slowed by the barricades', () => {
    const { world, ctx } = fresh();
    const b = quietHouse(world, ctx, 3);
    b.fortification = 1;
    const s = placeInside(world, b);
    s.weapon = null;
    s.archetype = 'civilian';
    occupy(world, b, 1);
    rebuildHashes(world, ctx);
    world.tick++;
    buildingProcesses(world, ctx);
    expect(s.exitingUntil).toBe(world.tick + config.buildings.exitTicksPerFortification);
    expect(s.insideBuilding).toBe(b.id);
    assertInvariant(world);
  });
});

describe('garrisons', () => {
  it('a building becomes a shelter once alerted, peopled and fortifying, and falls when occupied', () => {
    const { world, ctx } = fresh();
    const b = quietHouse(world, ctx, config.shelter.garrisonMin);
    b.alertedAt = 0;
    b.materials = 10;
    const events = () => ctx.events.filter((x) => 'building' in x && x.building === (b.id as BuildingId)).map((x) => x.type);
    work(world, ctx, b, 100);
    expect(b.garrisonedAt).not.toBeNull();
    expect(events()).toContain('shelterEstablished');
    occupy(world, b, 1);
    work(world, ctx, b, 1);
    expect(b.garrisonedAt).toBeNull();
    expect(events()).toContain('shelterFell');
  });
});

describe('the economy over a run', () => {
  it('holds the invariant and is reproducible with scavenging under way', () => {
    const run = () => {
      const { world, ctx } = createWorld({ ...defaultScenario, runSeed: 2 }, config);
      while (world.tick < 4000) step(world, ctx, { checkInvariant: true });
      return world;
    };
    const a = run();
    expect(a.sims.some((s) => s.history.materialsDelivered > 0 || s.role === 'scavenger')).toBe(true);
    const b = run();
    expect(b.sims.map((s) => [s.condition, s.role, s.materials, s.x])).toEqual(a.sims.map((s) => [s.condition, s.role, s.materials, s.x]));
    expect(b.buildings.map((x) => [x.fortification, x.materials])).toEqual(a.buildings.map((x) => [x.fortification, x.materials]));
  }, 120_000);
});
