import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { transfer } from '../src/sim/counters';
import { carLeaves, exitArrivals, headForExit } from '../src/sim/systems/exits';
import { assertInvariant } from '../src/sim/tick';

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
