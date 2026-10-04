// Tick step 8: infection countdowns and conversions. After combat, so a sim due
// to turn still got its final action.

import type { Context } from '../context';
import { transfer } from '../counters';
import { spawnZombie } from '../spawn';
import type { World } from '../state';
import { occupierAppeared } from './buildings';

export function convertDue(world: World, ctx: Context): void {
  const { tick } = world;
  const count = world.sims.length;
  for (let i = 0; i < count; i++) {
    const sim = world.sims[i]!;
    if (sim.condition !== 'infected' || sim.turnsAt === null || sim.turnsAt > tick) continue;
    sim.condition = 'turned';
    sim.turnsAt = null;
    sim.history.endedAt = tick;
    world.lastConversionAt = tick;

    const inside = sim.insideBuilding;
    if (inside === null) {
      const z = spawnZombie(world, sim.x, sim.y, 'active', null, sim.id);
      transfer(world, 'turned.symptomatic', 'turned.outdoors');
      ctx.events.push({ type: 'simTurned', tick, sim: sim.id, zombie: z.id, x: sim.x, y: sim.y });
      continue;
    }
    const b = world.buildings[inside]!;
    b.sheltered = b.sheltered.filter((id) => id !== sim.id);
    const z = spawnZombie(world, sim.x, sim.y, 'occupying', b.id, sim.id);
    b.zombiesInside++;
    transfer(world, 'turned.symptomatic', 'turned.occupying');
    ctx.events.push({ type: 'simTurned', tick, sim: sim.id, zombie: z.id, x: sim.x, y: sim.y });
    occupierAppeared(world, ctx, b);
  }
}
