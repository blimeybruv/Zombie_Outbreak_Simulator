import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { queueAt } from '../src/sim/systems/cordon';
import { rebuildHashes } from '../src/sim/systems/perception';
import { rescueTally, updateRescue } from '../src/sim/systems/rescue';
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

  it('after the broadcast those who believe it and dare make for its exit, and trucks take those waiting, up to their capacity', () => {
    const { world, ctx } = fresh();
    world.tick = soon.rescue.at;
    updateRescue(world, ctx);
    world.tick = soon.rescue.at + soon.rescue.broadcast;
    updateRescue(world, ctx);
    expect(ctx.events.some((e) => e.type === 'rescueBroadcast')).toBe(true);
    const e = world.exits[world.rescueExit!]!;
    const free = world.sims.filter((s) => s.condition === 'healthy' && !s.outsider && s.archetype !== 'police' && s.crew === null);
    // Answering is a choice: some go, sceptics stay put, and the cautious far from the corridor stay hidden.
    const went = free.filter((s) => s.destinationKind === 'leave');
    expect(went.length).toBeGreaterThan(0);
    expect(went.length).toBeLessThan(free.length);
    expect(went.every((s) => s.trust >= soon.rescue.trustFloor)).toBe(true);
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

  it('counts what became of those who answered the broadcast', () => {
    const { world, ctx } = fresh();
    world.tick = soon.rescue.at;
    updateRescue(world, ctx);
    world.tick = soon.rescue.at + soon.rescue.broadcast;
    updateRescue(world, ctx);
    const answered = world.sims.filter((s) => s.answeredAt !== null);
    expect(answered.length).toBeGreaterThan(0);
    const [a, b] = answered;
    a!.condition = 'dead';
    b!.condition = 'evacuated';
    const t = rescueTally(world);
    expect(t.answered).toBe(answered.length);
    expect(t.dead).toBe(1);
    expect(t.out).toBe(1);
    expect(t.out + t.dead + t.turned + t.waiting + t.elsewhere).toBe(t.answered);
  });
});
