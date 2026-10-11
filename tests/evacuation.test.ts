import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { buildingProcesses } from '../src/sim/systems/buildings';
import { assertInvariant } from '../src/sim/tick';

describe('evacuation', () => {
  it('a district that comes to know sends people out together, aware and for somewhere far off; its neighbour stays calm', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
    for (const b of world.buildings) b.alertedAt = null;
    const inD = world.buildings.filter((b) => b.district === 0);
    for (const b of inD.slice(0, Math.ceil(config.evacuation.threshold * inD.length))) b.alertedAt = 0;
    world.tick = config.evacuation.interval * 100;
    const before = world.sims.length;
    buildingProcesses(world, ctx);
    expect(ctx.events.some((e) => e.type === 'districtEvacuating' && e.district === 0)).toBe(true);
    expect(world.buildings.filter((b) => b.district !== 0).every((b) => b.pendingEvacuate === 0)).toBe(true);
    // (The first release goes out too, by now, unaware and on routines: not these.)
    const out = world.sims.slice(before).filter((s) => s.destinationKind === 'shelter');
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) {
      expect(s.awareAt).not.toBeNull();
      expect(s.destinationKind).toBe('shelter');
    }
    const far = out.filter((s) => s.destination !== null && Math.hypot(s.destination.x - s.x, s.destination.y - s.y) >= config.evacuation.minDistance);
    expect(far.length).toBeGreaterThan(out.length / 2);
    assertInvariant(world);
  });
});
