import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { buildingProcesses } from '../src/sim/systems/buildings';
import { assertInvariant } from '../src/sim/tick';

describe('evacuation', () => {
  it('a district that comes to know sends people out together, aware and for a way off the map; its neighbour stays calm', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, { ...config, features: { ...config.features, evacuation: true } });
    for (const b of world.buildings) b.alertedAt = null;
    const inD = world.buildings.filter((b) => b.district === 0);
    for (const b of inD.slice(0, Math.ceil(config.evacuation.threshold * inD.length))) b.alertedAt = 0;
    world.tick = config.evacuation.interval * 100;
    const before = world.sims.length;
    buildingProcesses(world, ctx);
    expect(ctx.events.some((e) => e.type === 'districtEvacuating' && e.district === 0 && e.first)).toBe(true);
    // The first district to go is what the world outside reacts to: the cordon's clock starts.
    expect(world.noticedAt).toBe(world.tick);
    expect(world.buildings.filter((b) => b.district !== 0).every((b) => b.pendingEvacuate === 0)).toBe(true);
    // (The first release goes out too, by now, unaware and on routines: not these.)
    const out = world.sims.slice(before).filter((s) => s.destinationKind === 'leave');
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) {
      expect(s.awareAt).not.toBeNull();
      // For an exit: the nearest way off the map.
      expect(world.exits.some((e) => e.x === s.destination!.x && e.y === s.destination!.y)).toBe(true);
    }
    assertInvariant(world);
  });
});
