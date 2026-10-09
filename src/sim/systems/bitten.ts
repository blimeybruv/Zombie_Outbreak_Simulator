// A bitten sim knows. At its first decision after the bite it chooses, once, by
// archetype (`isolates`), what to do about it:
//
//   conceal  carry on as if nothing happened: home, shelter, the trip it was on. If
//            nobody saw the bite it will be let in, and turn among the people inside.
//   isolate  go off alone to the nearest empty building it can see, leaving its
//            shelter and whatever it did there, and turn where it can hurt nobody.
//
// Its own infection is the one a sim may read; nobody else's.

import type { Context } from '../context';
import { chance } from '../rng';
import type { Building, Sim, World } from '../state';
import { entranceNearest, exitTicks, setDestination } from './common';
import { visibleFill } from './shelter';

/** The nearest building within isolationRadius that looks empty from outside, other than where it is. */
export function emptyBuilding(world: World, ctx: Context, sim: Sim): Building | null {
  const { config, buildings } = world;
  let best: Building | null = null;
  let bestD = Infinity;
  for (const bid of ctx.map.buildingsNear(sim.x, sim.y, config.awareness.isolationRadius, ctx.buildingIds)) {
    if (bid === sim.insideBuilding || bid === sim.refusedBy) continue;
    const b = buildings[bid]!;
    if (visibleFill(b) > 0) continue;
    const e = entranceNearest(b, sim.x, sim.y);
    const d = Math.hypot(e.x - sim.x, e.y - sim.y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

export function decideBitten(world: World, ctx: Context, sim: Sim): void {
  if (sim.condition !== 'infected' || sim.infectedChoice !== null) return;
  const { config, tick, buildings } = world;
  const target = chance(world.rng, config.archetypes[sim.archetype].isolates) ? emptyBuilding(world, ctx, sim) : null;
  if (target === null) {
    sim.infectedChoice = 'conceal';
    return;
  }
  sim.infectedChoice = 'isolate';
  // Whatever it was to the house, it is not coming back.
  sim.shelter = null;
  sim.role = null;
  sim.sortieUntil = null;
  sim.idleUntil = null;
  setDestination(sim, target, 'isolate');
  if (sim.insideBuilding !== null) sim.exitingUntil ??= tick + exitTicks(world, buildings[sim.insideBuilding]!);
  ctx.events.push({ type: 'simIsolating', tick, sim: sim.id, building: target.id });
}
