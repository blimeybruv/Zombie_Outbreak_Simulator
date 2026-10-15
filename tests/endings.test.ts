import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/tick';
import { clearEndings, noteEndings } from '../src/worker/endings';
import { inspect } from '../src/worker/inspect';

describe('endings', () => {
  it('a tracked person who dies is told by how, where and when', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, runSeed: 1 }, config);
    clearEndings();
    let dead: number | null = null;
    while (dead === null && world.tick < 3000) {
      step(world, ctx, { checkInvariant: false });
      noteEndings(world, ctx, world.events);
      for (const e of world.events) if (e.type === 'simDied' && e.sim !== null) dead = e.sim;
    }
    expect(dead).not.toBeNull();
    const d = inspect(world, { kind: 'sim', id: dead! });
    expect(d?.kind).toBe('sim');
    if (d?.kind !== 'sim') return;
    expect(d.ending).not.toBeNull();
    expect(['fedOn', 'breach', 'shot', 'mistaken']).toContain(d.ending!.how);
    expect(d.ending!.place.length).toBeGreaterThan(0);
    expect(d.ending!.hoursIn).toBeGreaterThan(0);
    expect(d.thoughts).toEqual([]);
  }, 60_000);
});
