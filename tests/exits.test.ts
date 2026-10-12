import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { transfer } from '../src/sim/counters';
import { carLeaves, exitArrivals, headForExit } from '../src/sim/systems/exits';
import { assertInvariant, step } from '../src/sim/tick';
import { flank, queueAt, updateCordon } from '../src/sim/systems/cordon';

describe('leaving the city', () => {
  it('one on foot who reaches a way off the map is out of play, counted as rescued', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
    const e = world.exits[0]!;
    const s = world.sims.find((x) => x.condition === 'healthy' && x.insideBuilding === null)!;
    s.x = e.x - e.dx * 20;
    s.y = e.y - e.dy * 20;
    expect(headForExit(world, s)).toBe(true);
    expect(s.destinationKind).toBe('leave');
    const before = world.counters.unturned.rescued;
    exitArrivals(world, ctx);
    expect(s.condition).not.toBe('rescued'); // not there yet
    s.x = e.x;
    s.y = e.y;
    exitArrivals(world, ctx);
    expect(s.condition).toBe('rescued');
    expect(world.counters.unturned.rescued).toBe(before + 1);
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
    expect([a.condition, b.condition]).toEqual(['rescued', 'rescued']);
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
    expect(s.condition).toBe('rescued');
    assertInvariant(world);
  });

  // A unit that fires shoots someone trying to pass its barrier; one that holds its fire lets them by.
  for (const fires of [true, false]) {
    it(`a cordon unit that ${fires ? 'fires' : 'holds its fire'} on those getting round it`, () => {
      const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
      world.noticedAt = world.tick;
      world.tick += config.cordon.delay - 1;
      step(world, ctx, { checkInvariant: true });
      for (const x of world.sims) if (x.outsider) x.firesOnCrossers = fires;
      for (let k = 0; k < 120; k++) step(world, ctx, { checkInvariant: true });
      const e = world.exits[0]!;
      expect(e.closedAt).not.toBeNull();
      const s = world.sims.find((x) => x.condition === 'healthy' && x.insideBuilding === null && x.car === null && !x.outsider)!;
      const q = queueAt(world, e);
      s.x = q.x;
      s.y = q.y;
      headForExit(world, s);
      s.crossing = 1;
      for (let k = 0; k < 120 && (s.condition === 'healthy' || s.condition === 'infected'); k++) step(world, ctx, { checkInvariant: true });
      expect(s.condition).toBe(fires ? 'dead' : 'rescued');
    }, 60_000);
  }
});
