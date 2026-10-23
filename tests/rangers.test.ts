import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { rebuildHashes } from '../src/sim/systems/shared/perception';
import { updateRescue } from '../src/sim/systems/outside/rescue';
import type { CarId } from '../src/sim/state/units';
import { rangerPositions } from '../src/worker/rangers';

const soon = { ...config, rescue: { ...config.rescue, at: 10, broadcast: 100, truckEvery: 50, truckLoad: 20 } };

function fresh() {
  const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, soon);
  sizeContext(ctx, world);
  rebuildHashes(world, ctx);
  return { world, ctx };
}

describe('ranger positions on the frame', () => {
  it('is empty at tick 0 and lists living outdoor Rangers just after the sweep', () => {
    const { world, ctx } = fresh();
    expect(world.tick).toBe(0);
    expect(rangerPositions(world.sims)).toHaveLength(0);

    world.tick = soon.rescue.at;
    updateRescue(world, ctx);
    const company = world.sims.filter((s) => s.sweep);
    expect(company).toHaveLength(soon.rescue.squads * config.squads.size);
    const packed = rangerPositions(world.sims);
    expect(packed).toHaveLength(company.length * 2);
    for (let i = 0; i < company.length; i++) {
      expect(packed[i * 2]).toBeCloseTo(company[i]!.x);
      expect(packed[i * 2 + 1]).toBeCloseTo(company[i]!.y);
    }

    company[0]!.condition = 'dead';
    company[1]!.insideBuilding = world.buildings[0]!.id;
    company[2]!.car = 1 as CarId;
    company[3]!.condition = 'turned';
    const bystander = world.sims.find((s) => !s.sweep && s.condition === 'healthy');
    expect(bystander).toBeDefined();
    bystander!.outsider = true;
    expect(rangerPositions(world.sims)).toHaveLength((company.length - 4) * 2);
  });
});
