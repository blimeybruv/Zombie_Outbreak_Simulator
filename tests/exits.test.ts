import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { transfer } from '../src/sim/counters';
import { carLeaves, exitArrivals, headForExit } from '../src/sim/systems/outside/exits';
import { assertInvariant, step } from '../src/sim/tick';
import { barrierAt, flank, queueAt, updateCordon } from '../src/sim/systems/outside/cordon';
import { queueSlot } from '../src/sim/systems/outside/rescue';
import { killSim } from '../src/sim/systems/fighting/combat';

describe('leaving the city', () => {
  it('one on foot who reaches a way off the map is out of play, counted as evacuated', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
    const e = world.exits[0]!;
    const s = world.sims.find((x) => x.condition === 'healthy' && x.insideBuilding === null)!;
    s.x = e.x - e.dx * 20;
    s.y = e.y - e.dy * 20;
    expect(headForExit(world, s)).toBe(true);
    expect(s.destinationKind).toBe('leave');
    const before = world.counters.unturned.evacuated;
    exitArrivals(world, ctx);
    expect(s.condition).not.toBe('evacuated'); // not there yet
    s.x = e.x;
    s.y = e.y;
    exitArrivals(world, ctx);
    expect(s.condition).toBe('evacuated');
    expect(world.counters.unturned.evacuated).toBe(before + 1);
    assertInvariant(world);
  });

  it('a car reaching its exit takes everyone in it out, and is gone; the bitten among them are counted', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
    const car = world.cars.find((c) => c.kind === 'car' && c.state === 'parked')!;
    const [a, b] = world.sims.filter((x) => x.condition === 'healthy' && x.insideBuilding === null);
    if (!a || !b) throw new Error('two outdoors needed');
    b.condition = 'infected';
    transfer(world, 'unturned.outdoors', 'turned.symptomatic');
    a.car = car.id;
    b.car = car.id;
    car.occupants = [a.id, b.id];
    car.state = 'driving';
    car.exit = 0;
    carLeaves(world, ctx, car);
    expect(car.state).toBe('gone');
    expect([a.condition, b.condition]).toEqual(['evacuated', 'evacuated']);
    expect(world.escapedInfected).toBe(1);
    assertInvariant(world);
  });
});

describe('the cordon', () => {
  it('soldiers from outside arrive after the delay, close every exit for good, and are counted on top of the population', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
    world.noticedAt = world.tick;
    world.tick += config.cordon.delay;
    updateCordon(world, ctx);
    const soldiers = world.sims.filter((s) => s.outsider);
    expect(soldiers).toHaveLength(world.exits.length * config.squads.size);
    expect(world.outsiders).toBe(soldiers.length);
    assertInvariant(world);
    // Their leaders at their posts: the barriers close.
    for (const s of soldiers) if (s.post !== null) {
      s.x = s.post.x;
      s.y = s.post.y;
    }
    world.tick++;
    updateCordon(world, ctx);
    for (const e of world.exits) {
      expect(e.closedAt).not.toBeNull();
      expect(world.streets[e.street]!.blocked).toBe(1);
    }
  });

  it('nobody passes a closed exit on foot', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
    const e = world.exits[0]!;
    e.closedAt = world.tick;
    const s = world.sims.find((x) => x.condition === 'healthy' && x.insideBuilding === null)!;
    headForExit(world, s);
    s.x = e.x;
    s.y = e.y;
    exitArrivals(world, ctx);
    expect(s.condition).toBe('healthy');
  });

  it('one getting round a closed barrier along the kerb is out at the edge', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
    const e = world.exits[0]!;
    e.closedAt = world.tick;
    const s = world.sims.find((x) => x.condition === 'healthy' && x.insideBuilding === null && x.car === null)!;
    const q = queueAt(world, e);
    s.x = q.x;
    s.y = q.y;
    headForExit(world, s);
    s.crossing = 1;
    const out = flank(world, e, 1).out;
    s.x = out.x;
    s.y = out.y;
    exitArrivals(world, ctx);
    expect(s.condition).toBe('evacuated');
    assertInvariant(world);
  });

  /** A world whose cordon has arrived and closed every exit, with one civilian on foot to place. */
  function closed() {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
    world.noticedAt = world.tick;
    world.tick += config.cordon.delay - 1;
    step(world, ctx, { checkInvariant: true });
    for (let k = 0; k < 120; k++) step(world, ctx, { checkInvariant: true });
    const e = world.exits[0]!;
    expect(e.closedAt).not.toBeNull();
    const s = world.sims.find((x) => x.condition === 'healthy' && x.insideBuilding === null && x.car === null && x.archetype === 'civilian' && x.crew === null && x.squadLeader === null)!;
    return { world, ctx, e, s };
  }
  /** Stands a sim on the road in, `d` metres short of the barrier. */
  function standAt(world: ReturnType<typeof closed>['world'], s: ReturnType<typeof closed>['s'], e: ReturnType<typeof closed>['e'], d: number) {
    const b = barrierAt(world, e);
    s.x = b.x - e.dx * d;
    s.y = b.y - e.dy * d;
  }

  it('one making for a closed exit is warned off with a shot, not hit, and gives the exit up', () => {
    const { world, ctx, e, s } = closed();
    s.trust = 1; // the trusting never defy
    standAt(world, s, e, (config.cordon.warnRadius + config.cordon.fireRadius) / 2);
    headForExit(world, s);
    let warned = false;
    for (let k = 0; k < 60 && !warned; k++) {
      step(world, ctx, { checkInvariant: true });
      warned = world.events.some((ev) => ev.type === 'cordonWarned' && ev.sim === s.id);
    }
    expect(warned).toBe(true);
    expect(s.condition).toBe('healthy');
    for (let k = 0; k < 5; k++) step(world, ctx, { checkInvariant: true });
    expect(s.knownClosed & 1).toBe(1);
    expect(s.destinationKind === 'leave' ? s.destination!.x !== e.x || s.destination!.y !== e.y : true).toBe(true);
  }, 60_000);

  it('one standing close to the barrier is fired on, to wound or kill', () => {
    const { world, ctx, e, s } = closed();
    standAt(world, s, e, config.cordon.fireRadius / 2);
    s.stand = 'freeze';
    s.standUntil = 1e9;
    let hit = false;
    for (let k = 0; k < 300 && !hit; k++) {
      step(world, ctx, { checkInvariant: true });
      hit = s.condition === 'dead' || world.events.some((ev) => ev.type === 'cordonWounded' && ev.sim === s.id);
    }
    expect(hit).toBe(true);
  }, 60_000);

  it('one on the far side of the barrier, hugging the edge, is fired on too', () => {
    const { world, ctx, e, s } = closed();
    const out = flank(world, e, 1);
    s.x = (out.beside.x + out.out.x) / 2;
    s.y = (out.beside.y + out.out.y) / 2;
    s.stand = 'freeze';
    s.standUntil = 1e9;
    for (let k = 0; k < 60 && s.firedOnAt === null; k++) step(world, ctx, { checkInvariant: true });
    expect(s.firedOnAt).not.toBeNull();
  }, 60_000);

  it("at the rescue's exit, once the rescue has come, those waiting are not fired on, and keep a step apart", () => {
    const { world, ctx, e, s } = closed();
    world.rescueExit = 0;
    const q = queueAt(world, e);
    const others = world.sims.filter((x) => x !== s && x.condition === 'healthy' && x.insideBuilding === null && x.car === null && !x.outsider).slice(0, 5);
    for (const x of [s, ...others]) {
      x.x = q.x;
      x.y = q.y;
      headForExit(world, x);
    }
    for (let k = 0; k < 300; k++) {
      step(world, ctx, { checkInvariant: true });
      expect(world.events.some((ev) => (ev.type === 'cordonWarned' || ev.type === 'cordonWounded') && ev.sim === s.id)).toBe(false);
    }
    expect(s.condition).toBe('healthy');
    const waiting = [s, ...others].filter((x) => x.condition === 'healthy' && x.queuedSince !== null);
    // Each stands on its own rank, within the arrival radius of that slot. The radius
    // is most of the gap to the next person, so a pair can finish closer than half a
    // step and still be on two different squares.
    const reach = config.rescue.tents.reach / 2;
    const ranks = new Set<number>();
    for (const x of waiting) {
      const rank = ctx.queueRank[x.id]!;
      ranks.add(rank);
      const p = queueSlot(world, e, rank);
      expect(Math.hypot(p.x - x.x, p.y - x.y)).toBeLessThanOrEqual(reach + 1e-6);
    }
    expect(ranks.size).toBe(waiting.length);
  }, 60_000);

  // The third exception: an armed sim pressing on round the barrier, fired on, fires back.
  it('an armed sim pressing on round the barrier, fired on, fires back', () => {
    const { world, ctx, e, s } = closed();
    s.weapon = 'pistol';
    s.ammo = 12;
    s.trust = 0.9;
    standAt(world, s, e, config.cordon.fireRadius / 2);
    headForExit(world, s);
    s.crossing = 1;
    let opened: boolean | null = null;
    for (let k = 0; k < 120 && opened === null && (s.condition === 'healthy' || s.condition === 'infected'); k++) {
      step(world, ctx, { checkInvariant: true });
      for (const ev of world.events) if (ev.type === 'cordonFiredOn' && ev.sim === s.id) opened = ev.first;
    }
    expect(opened === false || s.condition === 'dead' || s.condition === 'evacuated' || s.destinationKind !== 'leave').toBe(true); // fired back, unless hit, wounded, or past
  }, 60_000);

  it('a barrier nobody is left to hold is breached, and those waiting at it walk out', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
    world.noticedAt = world.tick;
    world.tick += config.cordon.delay - 1;
    step(world, ctx, { checkInvariant: true });
    for (let k = 0; k < 120; k++) step(world, ctx, { checkInvariant: true });
    const e = world.exits[0]!;
    expect(e.closedAt).not.toBeNull();
    expect(e.breachedAt).toBeNull();
    const s = world.sims.find((x) => x.condition === 'healthy' && x.insideBuilding === null && x.car === null && x.archetype === 'civilian' && x.crew === null && x.squadLeader === null)!;
    const q = queueAt(world, e);
    s.x = q.x;
    s.y = q.y;
    headForExit(world, s);
    // The squad there wiped out.
    for (const x of world.sims) if (x.outsider && Math.hypot(x.x - q.x, x.y - q.y) < config.cordon.breachRadius + 20) killSim(world, ctx, x, 'returned');
    let breached = false;
    for (let k = 0; k < 600 && s.condition === 'healthy'; k++) {
      step(world, ctx, { checkInvariant: true });
      if (world.events.some((ev) => ev.type === 'cordonBreached')) breached = true;
    }
    expect(breached).toBe(true);
    expect(e.breachedAt).not.toBeNull();
    expect(s.condition).toBe('evacuated');
  }, 60_000);
});
