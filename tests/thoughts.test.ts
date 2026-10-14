import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { spawnSim, spawnZombie } from '../src/sim/spawn';
import type { StreetId } from '../src/sim/state';
import { thoughts } from '../src/worker/thoughts';

function scene() {
  const { world } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
  const st = world.streets.find((t) => t.terrain === 'standard')!;
  const a = world.nodes[st.a]!;
  const s = spawnSim(world, { x: a.x, y: a.y, insideBuilding: null, sourceTag: 'office', initialPanic: 0, destinationKind: 'routine' });
  s.archetype = 'civilian';
  s.awareAt = 0;
  s.panic = 0;
  s.stamina = 1;
  const next = world.streets.find((t) => t.id !== st.id && t.terrain === 'standard')!;
  s.route = [st.id as StreetId, next.id as StreetId];
  s.routeIndex = 0;
  world.tick = 1000;
  return { world, s, next };
}

describe('thoughts', () => {
  it('say what the sim believes of the street ahead, not what is there', () => {
    const { world, s, next } = scene();
    s.streetMemory.set(next.id as StreetId, { danger: 0, observedAt: 900, visited: true });
    const before = thoughts(world, s);
    expect(before.some((t) => t.startsWith(`${next.name} was quiet`))).toBe(true);
    // The dead on that street, unseen: the thought does not change.
    const n = world.nodes[next.a]!;
    for (let i = 0; i < 5; i++) spawnZombie(world, n.x + i, n.y, 'active', null, null);
    expect(thoughts(world, s)).toEqual(before);
    // Told it is bad: now it thinks so.
    s.streetMemory.set(next.id as StreetId, { danger: 0.9, observedAt: 990, visited: false });
    expect(thoughts(world, s).some((t) => t.startsWith(`${next.name} was bad`))).toBe(true);
  });

  it('the bitten know it; those who conceal it say so to themselves', () => {
    const { world, s } = scene();
    s.condition = 'infected';
    s.infectedChoice = 'conceal';
    expect(thoughts(world, s)).toContain('Something bit me. Nobody needs to know.');
  });

  it('the unaware think only of their day', () => {
    const { world, s, next } = scene();
    s.awareAt = null;
    s.unease = 0;
    s.streetMemory.set(next.id as StreetId, { danger: 0.9, observedAt: 990, visited: false });
    expect(thoughts(world, s).some((t) => t.includes('was bad'))).toBe(false);
  });
});
