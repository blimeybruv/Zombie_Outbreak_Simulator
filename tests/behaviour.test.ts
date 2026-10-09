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
