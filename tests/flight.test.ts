import { describe, expect, it } from 'vitest';
import { config as baseConfig, type Config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { spawnSim } from '../src/sim/spawn';
import type { StreetId } from '../src/sim/state';
import { noteStreet } from '../src/sim/navigation/memory';
import { runOpen } from '../src/sim/systems/people/flight';
import { computePerception, rebuildHashes } from '../src/sim/systems/shared/perception';

function fresh(cfg: Config) {
  return createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, cfg);
}

/**
 * The crossroads the user saw: a sim at a four-way junction, the dead seen a moment ago
 * on the street ahead and now behind it on the street it is on. Which way does it run?
 */
function crossroads(flightMemory: boolean, age = 0) {
  const cfg: Config = { ...baseConfig, features: { ...baseConfig.features, flightMemory } };
  const { world, ctx } = fresh(cfg);
  const size = cfg.map.size;
  const inner = (v: number) => v > size / 4 && v < (size * 3) / 4;
  const node = world.nodes.findIndex((n, i) => inner(n.x) && inner(n.y) && ctx.map.adjacency[i]!.length === 4 && ctx.map.adjacency[i]!.every((a) => a.length > 40));
  expect(node).toBeGreaterThanOrEqual(0);
  const n = world.nodes[node]!;
  const adj = ctx.map.adjacency[node]!;
  const dir = (a: (typeof adj)[number]) => {
    const f = world.nodes[a.node]!;
    const l = Math.hypot(f.x - n.x, f.y - n.y);
    return { x: (f.x - n.x) / l, y: (f.y - n.y) / l };
  };
  const on = adj[0]!; // the street it is on, the dead behind it down that street
  const b = dir(on);
  const ahead = adj.reduce((best, a) => (dir(a).x * b.x + dir(a).y * b.y < dir(best).x * b.x + dir(best).y * b.y ? a : best)); // straight on: where it saw them first
  const sim = spawnSim(world, { x: n.x + b.x * 6, y: n.y + b.y * 6, insideBuilding: null, sourceTag: 'office', initialPanic: 1, destinationKind: null });
  sim.archetype = 'civilian';
  sizeContext(ctx, world);
  rebuildHashes(world, ctx);
  computePerception(world, ctx);
  sim.street = on.street as StreetId;
  sim.heading = Math.atan2(-b.y, -b.x); // running toward the junction, away from them
  ctx.threatX[sim.id] = b.x * 0.5; // what it sees: the dead back down its own street
  ctx.threatY[sim.id] = b.y * 0.5;
  ctx.threat[sim.id] = 0.5;
  noteStreet(world, sim, ahead.street as StreetId, cfg.memory.sightedDanger); // seen a moment ago
  world.tick += age;
  runOpen(world, ctx, sim);
  const hx = Math.cos(sim.heading), hy = Math.sin(sim.heading);
  const chosen = adj.reduce((best, a) => (dir(a).x * hx + dir(a).y * hy > dir(best).x * hx + dir(best).y * hy ? a : best));
  return { chosen: chosen.street, ahead: ahead.street, on: on.street };
}

describe('flight with memory', () => {
  it('at a crossroads, runs down a side street: not back onto the street it saw the dead on, nor toward those behind', () => {
    const r = crossroads(true);
    expect(r.chosen).not.toBe(r.ahead);
    expect(r.chosen).not.toBe(r.on);
  });

  it('without it, runs straight away from what it sees, back onto the street it saw the dead on', () => {
    const r = crossroads(false);
    expect(r.chosen).toBe(r.ahead);
  });

  it('reads only the fresh part of memory: a sighting older than flight.recent does not count', () => {
    const r = crossroads(true, baseConfig.flight.recent + 1);
    expect(r.chosen).toBe(r.ahead);
  });
});
