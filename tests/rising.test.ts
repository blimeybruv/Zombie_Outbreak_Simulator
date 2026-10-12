import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { killSim } from '../src/sim/systems/combat';
import { riseDue } from '../src/sim/systems/rising';
import { assertInvariant } from '../src/sim/tick';

const sure = { ...config, rising: { chance: 1, delay: [100, 100] as [number, number] } };

describe('rising', () => {
  it('someone the dead kill gets up again, later, where they fell; someone shot does not', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, sure);
    const [eaten, shot] = world.sims.filter((s) => s.condition === 'healthy' && s.insideBuilding === null && s.car === null);
    if (!eaten || !shot) throw new Error('two outdoors needed');
    const zombies = world.zombies.length;
    killSim(world, ctx, eaten, 'fedOn');
    killSim(world, ctx, shot, 'shot');
    expect(eaten.risesAt).toBe(world.tick + 100);
    expect(shot.risesAt).toBeNull();
    world.tick += 99;
    riseDue(world, ctx);
    expect(eaten.condition).toBe('dead');
    world.tick++;
    riseDue(world, ctx);
    expect(eaten.condition).toBe('turned');
    expect(world.zombies).toHaveLength(zombies + 1);
    const z = world.zombies[world.zombies.length - 1]!;
    expect([z.x, z.y, z.state]).toEqual([eaten.x, eaten.y, 'active']);
    expect(shot.condition).toBe('dead');
    assertInvariant(world);
  });
});
