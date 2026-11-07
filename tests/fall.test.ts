import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { fallen, livingInCity } from '../src/sim/fall';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/tick';

describe('a fallen city', () => {
  it('opens with a first wave of its own, scattered, taken from the population', () => {
    const { world } = createWorld({ ...defaultScenario, population: 2000, start: 'fallen', survivors: 100, initialZombies: 1, origin: 'street', runSeed: 3 }, config);
    const awake = world.zombies.filter((z) => z.state !== 'destroyed').length;
    expect(awake).toBe(Math.round(2000 * config.fallen.wave));
    expect(world.zombies.every((z) => z.insideBuilding !== null)).toBe(true); // scattered through buildings, whatever the origin set
    const c = world.counters;
    const sum = c.unturned.outdoors + c.unturned.indoors + c.unturned.dead + c.unturned.evacuated + c.turned.symptomatic + c.turned.outdoors + c.turned.occupying + c.turned.destroyed;
    expect(sum).toBe(world.scenario.population + world.outsiders);
    expect(fallen(world)).toBe(false);
  });

  it('has fallen once few enough are left, or at the latest by fallen.maxTicks; an ordinary run never waits', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, population: 2000, start: 'fallen', survivors: 1999, runSeed: 3 }, config);
    for (let i = 0; i < 600 && !fallen(world); i++) step(world, ctx, { checkInvariant: true });
    expect(fallen(world)).toBe(true);
    expect(livingInCity(world)).toBeLessThanOrEqual(1999);
    const late = createWorld({ ...defaultScenario, population: 2000, start: 'fallen', survivors: 0, runSeed: 3 }, config);
    late.world.tick = config.fallen.maxTicks;
    expect(fallen(late.world)).toBe(true);
    const plain = createWorld({ ...defaultScenario, population: 2000, runSeed: 3 }, config);
    expect(fallen(plain.world)).toBe(true);
  });
});
