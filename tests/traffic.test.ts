import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { barrierAt } from '../src/sim/systems/outside/cordon';
import { headForExit } from '../src/sim/systems/outside/exits';
import { rebuildHashes } from '../src/sim/systems/shared/perception';
import { squadTarget } from '../src/sim/systems/services/squads';
import { updateTraffic } from '../src/sim/systems/services/traffic';
import { assertInvariant } from '../src/sim/tick';

function fresh() {
  const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
  return { world, ctx };
}

describe('traffic police', () => {
  it('place a checkpoint on each exit’s road, inside the barrier, and a unit at a station for each, without moving the counters', () => {
    const { world } = fresh();
    expect(world.checkpoints).toHaveLength(world.exits.length);
    for (const [k, c] of world.checkpoints.entries()) {
      const e = world.exits[c.exit]!;
      const b = barrierAt(world, e);
      expect((c.x - b.x) * e.dx + (c.y - b.y) * e.dy).toBeLessThan(0); // on the city side
      const unit = world.sims.filter((s) => s.checkpoint === k);
      expect(unit).toHaveLength(config.traffic.officers);
      expect(unit.every((s) => s.archetype === 'police' && s.station !== null && s.insideBuilding === s.station && s.squadLeader === unit[0]!.id)).toBe(true);
    }
    assertInvariant(world);
  });

  it('wait until the first barrier closes, then make for their checkpoint', () => {
    const { world, ctx } = fresh();
    const leader = world.sims.find((s) => s.checkpoint === 0 && s.squadLeader === s.id)!;
    updateTraffic(world, ctx);
    expect(world.checkpointsAt).toBeNull();
    expect(squadTarget(world, ctx, leader)).toBeNull();
    world.exits[0]!.closedAt = world.tick;
    updateTraffic(world, ctx);
    expect(world.checkpointsAt).toBe(world.tick);
    const t = squadTarget(world, ctx, leader)!;
    expect([t.x, t.y]).toEqual([world.checkpoints[0]!.x, world.checkpoints[0]!.y]);
  });

  it('set, turn back anyone on foot making for their exit; with none of the unit left there, fall for good', () => {
    const { world, ctx } = fresh();
    world.exits[0]!.closedAt = world.tick;
    updateTraffic(world, ctx);
    const c = world.checkpoints[0]!;
    const unit = world.sims.filter((s) => s.checkpoint === 0);
    for (const s of unit) {
      world.buildings[s.insideBuilding!]!.sheltered = world.buildings[s.insideBuilding!]!.sheltered.filter((id) => id !== s.id);
      s.insideBuilding = null;
      s.x = c.x;
      s.y = c.y;
    }
    unit[0]!.post = { x: c.x, y: c.y };
    const walker = world.sims.find((s) => s.condition === 'healthy' && s.insideBuilding === null && s.archetype !== 'police')!;
    walker.x = c.x - c.dx * 5;
    walker.y = c.y - c.dy * 5;
    world.rescueExit = 0;
    headForExit(world, walker);
    world.rescueExit = null;
    expect(walker.destinationKind).toBe('leave');
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    updateTraffic(world, ctx);
    expect(c.setAt).toBe(world.tick);
    world.tick += config.traffic.every - (world.tick % config.traffic.every); // its turn to check
    updateTraffic(world, ctx);
    expect(walker.knownClosed & 1).toBe(1);
    const e = world.exits[0]!;
    expect(walker.destinationKind !== 'leave' || walker.destination!.x !== e.x || walker.destination!.y !== e.y).toBe(true);
    for (const s of unit) {
      s.x += 500;
      s.y += 0;
    }
    world.tick++;
    updateTraffic(world, ctx);
    expect(c.fallenAt).toBe(world.tick);
    expect(unit.every((s) => s.checkpoint === null)).toBe(true);
  });
});
