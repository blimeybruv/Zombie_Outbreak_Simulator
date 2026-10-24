// Tick step 8: infection countdowns and conversions. After combat, so a sim due
// to turn still got its final action.

import type { Context } from '../../context';
import { transfer } from '../../counters';
import { spawnZombie } from '../../spawn';
import { turnedInCar } from '../services/cars';
import type { World } from '../../state';
import { occupierAppeared } from '../buildings/buildings';
import { dropWeapon } from '../fighting/arms';

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
    if (sim.car !== null) {
      // Turned in a car: out of it, among whoever is still inside (cars.ts turnedInCar).
      turnedInCar(world, ctx, sim);
    }
    dropWeapon(world, sim); // left where it turned
    if (inside === null) {
      const z = spawnZombie(world, sim.x, sim.y, 'active', null, sim.id);
      z.intact = world.config.features.intactZombies && sim.bites <= 1; // one bite, no worse: nothing to see
      transfer(world, 'turned.symptomatic', 'turned.outdoors');
      ctx.events.push({ type: 'simTurned', tick, sim: sim.id, zombie: z.id, x: sim.x, y: sim.y });
      continue;
    }
    const b = world.buildings[inside]!;
    b.sheltered = b.sheltered.filter((id) => id !== sim.id);
    const z = spawnZombie(world, sim.x, sim.y, 'occupying', b.id, sim.id);
    z.intact = world.config.features.intactZombies && sim.bites <= 1;
    b.zombiesInside++;
    transfer(world, 'turned.symptomatic', 'turned.occupying');
    ctx.events.push({ type: 'simTurned', tick, sim: sim.id, zombie: z.id, x: sim.x, y: sim.y });
    occupierAppeared(world, ctx, b, 'inside', sim);
  }
}
