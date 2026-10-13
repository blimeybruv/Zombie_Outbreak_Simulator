import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { queueAt } from '../src/sim/systems/cordon';
import { rebuildHashes } from '../src/sim/systems/perception';
import { updateRescue } from '../src/sim/systems/rescue';
import { assertInvariant } from '../src/sim/tick';

const soon = { ...config, rescue: { ...config.rescue, at: 10, broadcast: 100, truckEvery: 50, truckLoad: 20 } };

function fresh() {
  const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, soon);
  sizeContext(ctx, world);
  rebuildHashes(world, ctx);
  return { world, ctx };
}

describe('the rescue', () => {
  it('a company comes in by one exit at rescue.at, counted on top of the population', () => {
    const { world, ctx } = fresh();
    world.tick = soon.rescue.at;
    updateRescue(world, ctx);
    expect(world.rescueExit).not.toBeNull();
    const company = world.sims.filter((s) => s.sweep);
    expect(company).toHaveLength(soon.rescue.squads * config.squads.size);
    expect(company.every((s) => s.outsider)).toBe(true);
    expect(ctx.events.some((e) => e.type === 'rescueSweep')).toBe(true);
    assertInvariant(world);
  });

  it('after the broadcast everyone free to makes for its exit, and trucks take those waiting, up to their capacity', () => {
    const { world, ctx } = fresh();
    world.tick = soon.rescue.at;
    updateRescue(world, ctx);
    world.tick = soon.rescue.at + soon.rescue.broadcast;
    updateRescue(world, ctx);
    expect(ctx.events.some((e) => e.type === 'rescueBroadcast')).toBe(true);
    const e = world.exits[world.rescueExit!]!;
    const free = world.sims.filter((s) => s.condition === 'healthy' && !s.outsider && s.archetype !== 'police' && s.crew === null);
    expect(free.filter((s) => s.destinationKind === 'leave').length).toBeGreaterThan(free.length * 0.9);
    for (const s of free) expect(s.destination === null || s.destinationKind !== 'leave' || (s.destination.x === e.x && s.destination.y === e.y)).toBe(true);
    // A queue at the barrier, and a truck.
    const q = queueAt(world, e);
    const waiting = free.filter((s) => s.insideBuilding === null && s.car === null).slice(0, soon.rescue.truckCapacity + 5);
    for (const s of waiting) {
      s.x = q.x;
      s.y = q.y;
      s.queuedSince = world.tick;
      s.destinationKind = 'leave';
    }
    const before = world.counters.unturned.evacuated;
    for (let t = 0; t < soon.rescue.truckEvery + soon.rescue.truckLoad + 2; t++) {
      world.tick++;
      updateRescue(world, ctx);
    }
    expect(world.counters.unturned.evacuated - before).toBe(soon.rescue.truckCapacity);
    expect(ctx.events.some((e) => e.type === 'truckLeft' && e.count === soon.rescue.truckCapacity)).toBe(true);
    assertInvariant(world);
  });
});
