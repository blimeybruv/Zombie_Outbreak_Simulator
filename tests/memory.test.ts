import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { noteStreet, settleDanger, trim } from '../src/sim/memory';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import type { StreetId } from '../src/sim/state';

function oneSim() {
  const { world } = createWorld({ ...defaultScenario, population: 2000 }, config);
  const sim = world.sims.find((s) => s.insideBuilding === null) ?? world.sims[0]!;
  sim.streetMemory.clear();
  sim.destination = null;
  return { world, sim };
}

describe('street danger is not written symmetrically', () => {
  it('rises at once', () => {
    expect(settleDanger(0.1, 0.9, 0.5)).toBe(0.9);
  });

  it('falls only part of the way on a quiet look, and repeated looks clear it', () => {
    const { world, sim } = oneSim();
    const street = 3 as StreetId;
    sim.streetMemory.set(street, { danger: 1, observedAt: 0, visited: false });
    world.tick = 100;
    noteStreet(world, sim, street, 0, true);
    expect(sim.streetMemory.get(street)!.danger).toBe(config.memory.quietLook);
    expect(sim.streetMemory.get(street)!.observedAt).toBe(100);
    for (let t = 0; t < 8; t++) noteStreet(world, sim, street, 0, true);
    expect(sim.streetMemory.get(street)!.danger).toBeLessThan(0.01);
  });

  it('keeps visited once set', () => {
    const { world, sim } = oneSim();
    const street = 3 as StreetId;
    sim.streetMemory.set(street, { danger: 0, observedAt: 0, visited: true });
    noteStreet(world, sim, street, 1);
    expect(sim.streetMemory.get(street)!.visited).toBe(true);
  });
});

describe('street tables are trimmed by relevance', () => {
  it('keeps the nearest streets and the gravest warnings wherever they are', () => {
    const { world, sim } = oneSim();
    const cap = config.memory.streetCap;
    const mid = (k: number) => {
      const s = world.streets[k]!;
      return Math.hypot((world.nodes[s.a]!.x + world.nodes[s.b]!.x) / 2 - sim.x, (world.nodes[s.a]!.y + world.nodes[s.b]!.y) / 2 - sim.y);
    };
    const ids = world.streets.map((_, k) => k).sort((a, b) => mid(a) - mid(b) || a - b);
    const farthest = ids[ids.length - 1]! as StreetId;
    // Fill past the slack with quiet streets, the gravest warning the farthest of all.
    sim.streetMemory.set(farthest, { danger: 1, observedAt: world.tick, visited: false });
    for (const k of ids.slice(0, 2 * cap)) sim.streetMemory.set(k as StreetId, { danger: 0, observedAt: 0, visited: false });
    noteStreet(world, sim, ids[2 * cap]! as StreetId, 0);
    expect(sim.streetMemory.size).toBe(cap);
    expect(sim.streetMemory.has(farthest)).toBe(true);
    for (const k of ids.slice(0, cap - 1)) expect(sim.streetMemory.has(k as StreetId)).toBe(true);
  });
});

describe('trim', () => {
  it('waits for twice the cap, then keeps the newest, ties to the lower key, newest first', () => {
    const table = new Map<number, { observedAt: number }>();
    for (const [k, t] of [[9, 5], [2, 7], [4, 5], [1, -3]] as const) table.set(k, { observedAt: t });
    trim(table, 2);
    expect(table.size).toBe(4);
    table.set(7, { observedAt: 7 });
    trim(table, 2);
    expect([...table.keys()]).toEqual([2, 7]);
    table.set(3, { observedAt: 5 });
    table.set(8, { observedAt: 5 });
    table.set(0, { observedAt: -3 });
    trim(table, 1);
    expect([...table.keys()]).toEqual([2]);
  });
});
