import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { rebuildHashes } from '../src/sim/systems/shared/perception';
import { queueSlot, rescueTally, updateRescue } from '../src/sim/systems/outside/rescue';
import { barrierAt, updateCordon } from '../src/sim/systems/outside/cordon';
import { assertInvariant, step } from '../src/sim/tick';

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

  it("the cordon squad at the rescue's exit takes the gate, advances to the DO NOT CROSS line at the broadcast, and a fresh squad takes the gate", () => {
    const { world, ctx } = fresh();
    world.noticedAt = 0;
    world.tick = config.cordon.delay;
    updateCordon(world, ctx);
    world.tick = soon.rescue.at;
    updateRescue(world, ctx);
    const e = world.exits[world.rescueExit!]!;
    const b = barrierAt(world, e);
    const leader = world.sims.find((s) => s.outsider && !s.sweep && s.post !== null && Math.hypot(s.post.x - b.x, s.post.y - b.y) <= config.cordon.post * 2)!;
    const gate = { ...leader.post! };
    expect((gate.x - b.x) * e.dx + (gate.y - b.y) * e.dy).toBeGreaterThan(0); // beyond the line
    const before = world.outsiders;
    world.tick = soon.rescue.at + soon.rescue.broadcast;
    updateRescue(world, ctx);
    expect((leader.post!.x - b.x) * e.dx + (leader.post!.y - b.y) * e.dy).toBeCloseTo(-config.cordon.warnRadius);
    expect(world.outsiders).toBe(before + config.squads.size);
    const relief = world.sims.filter((s) => s.outsider && !s.sweep && s.post !== null && s.post.x === gate.x && s.post.y === gate.y);
    expect(relief).toHaveLength(1); // its leader
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
    // A queue behind the line, let through in order to the tents, and a truck from them.
    // (The cordon has closed the road by now in a run; here it is closed by hand.)
    e.closedAt = world.tick;
    world.streets[e.street]!.blocked = 1;
    const waiting = free.filter((s) => s.insideBuilding === null && s.car === null && s.crew === null && s.squadLeader === null).slice(0, 8);
    waiting.forEach((s, k) => {
      const p = queueSlot(world, e, k);
      s.x = p.x;
      s.y = p.y;
      s.queuedSince = world.tick + k; // in this order
      s.destinationKind = 'leave';
      s.destination = { x: e.x, y: e.y };
      s.panic = 0;
    });
    const before = world.counters.unturned.evacuated;
    const order: number[] = [];
    for (let t = 0; t < soon.rescue.passEvery * 4 + 60; t++) {
      step(world, ctx, { checkInvariant: true });
      for (const s of waiting) if (s.tent !== null && !order.includes(s.id)) order.push(s.id);
    }
    expect(order.length).toBeGreaterThanOrEqual(3);
    expect(order.slice(0, 3)).toEqual(waiting.filter((s) => order.includes(s.id)).map((s) => s.id).slice(0, 3)); // the front first
    const inTents = waiting.filter((s) => s.condition === 'evacuated').length; // (others may leave the city by other ways meanwhile)
    expect(inTents).toBeGreaterThan(0);
    expect(world.tented + world.trucked).toBeGreaterThanOrEqual(inTents); // in the tents, or already on a truck
    expect(world.counters.unturned.evacuated - before).toBeGreaterThanOrEqual(inTents);
    // Those still waiting each stand in a place of their own.
    const still = waiting.filter((s) => s.queuedSince !== null && (s.condition === 'healthy' || s.condition === 'infected'));
    for (const p of still) for (const q of still) if (p !== q) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(0.5);
    // A truck takes the tents' people, up to its capacity.
    const trucked = world.trucked, tented = world.tented;
    let left = -1;
    for (let t = 0; t < soon.rescue.truckEvery + soon.rescue.truckLoad + 2 && left < 0; t++) {
      step(world, ctx, { checkInvariant: true });
      for (const ev of world.events) if (ev.type === 'truckLeft') left = ev.count;
    }
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(soon.rescue.truckCapacity);
    expect(world.trucked - trucked).toBe(left);
    expect(left).toBeGreaterThanOrEqual(Math.min(tented, soon.rescue.truckCapacity));
  }, 120_000);

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
