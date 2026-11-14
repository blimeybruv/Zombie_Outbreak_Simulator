// The ways a sim on foot can turn when its way is in question: a door near it, a stand,
// a fresh plan, another door when the way is blocked. Shared by the decisions in
// sims.ts and by flight (flight.ts).

import type { Context } from '../../context';
import type { Building, Sim, Stand, World } from '../../state';
import { capacity, clearDestination, entranceNearest, refusedLately, setDestination } from '../shared/common';
import { breaks, type Mode } from './panic';
import { headFor, steerAway } from './steering';

/** Anyone going somewhere other than a routine stop, routing on memory, plans again now. */
export function replan(world: World, ctx: Context, sim: Sim, mode: Mode): void {
  if (sim.destination === null || sim.destinationKind === 'routine' || mode !== 'informed') return;
  sim.route = ctx.paths.route(sim, sim.destination.x, sim.destination.y, true) ?? [];
  sim.routeIndex = 0;
  sim.nextRepathAt = world.tick + world.config.pathfinding.repathCooldown;
}

/** Whether a door lies toward what the sim fears: within doorTowardThreatCos of its direction. */
export function towardThreat(world: World, ctx: Context, sim: Sim, x: number, y: number): boolean {
  const tx = ctx.threatX[sim.id]!, ty = ctx.threatY[sim.id]!;
  const tl = Math.hypot(tx, ty);
  const d = Math.hypot(x - sim.x, y - sim.y);
  if (tl === 0 || d === 0) return false;
  return ((x - sim.x) * tx + (y - sim.y) * ty) / (d * tl) > world.config.behaviour.doorTowardThreatCos;
}

/**
 * The nearest door within doorSearchRadius, never the one that last turned the sim
 * away nor `skip`. A door lying toward the danger is taken anyway ('any'), counts
 * doorTowardThreatPenalty times as far ('penalise'), or is passed over ('exclude').
 */
export function nearestDoor(world: World, ctx: Context, sim: Sim, toward: 'any' | 'penalise' | 'exclude', skip: number | null = null, skipToo: number | null = null): Building | null {
  const { config, buildings } = world;
  let door: Building | null = null;
  let doorD = Infinity;
  for (const bid of ctx.map.buildingsNear(sim.x, sim.y, config.behaviour.doorSearchRadius, ctx.buildingIds)) {
    if (bid === sim.refusedBy || bid === skip || bid === skipToo || refusedLately(world, sim, bid)) continue;
    const b = buildings[bid]!;
    const e = entranceNearest(b, sim.x, sim.y);
    let d = Math.hypot(e.x - sim.x, e.y - sim.y);
    if (toward !== 'any' && towardThreat(world, ctx, sim, e.x, e.y)) {
      if (toward === 'exclude') continue;
      d *= config.behaviour.doorTowardThreatPenalty;
    }
    if (d < doorD) {
      doorD = d;
      door = b;
    }
  }
  return door;
}

export function takeStand(world: World, sim: Sim, stand: Stand, ticks?: number): void {
  const cc = world.config.cornered;
  sim.stand = stand;
  sim.standUntil = world.tick + (ticks ?? (stand === 'fight' ? cc.fightTicks : cc.freezeTicks));
  sim.gait = 'still';
}

/**
 * The danger is squarely between the sim and where it is going, though there is a
 * way out. Fight, if what it carries is up to the zombies close by; else another
 * door, one that does not lie toward them; else back off for avoidHold ticks, with
 * the route planned again around what it saw.
 */
export function wayBlocked(world: World, ctx: Context, sim: Sim, mode: Mode): void {
  const { config } = world;
  const cap = capacity(world, sim);
  if (cap > 0 && !breaks(sim, config, ctx.company[sim.id]!)) {
    ctx.zombieHash.query(sim.x, sim.y, config.cornered.fightRadius, ctx.ids2);
    if (ctx.ids2.length > 0 && cap >= ctx.ids2.length) return takeStand(world, sim, 'fight');
  }
  // (Someone going off alone, bitten, wants no other door: it backs off and goes on.)
  // Not back to the door it last turned from, for a while: two doors whose ways both
  // looked blocked had sims swapping between them, some every tick, like pong balls.
  const from = sim.turnedFromUntil !== null && world.tick < sim.turnedFromUntil ? sim.turnedFrom : null;
  const door = sim.destinationKind === 'isolate' ? null : nearestDoor(world, ctx, sim, 'exclude', sim.destinationBuilding, from);
  if (door !== null) {
    if (sim.destinationBuilding !== null) {
      sim.turnedFrom = sim.destinationBuilding;
      sim.turnedFromUntil = world.tick + config.behaviour.turnedFromHold;
    }
    setDestination(sim, door, 'shelter');
    sim.lastMigratedAt = world.tick;
    sim.gait = 'run';
    headFor(world, ctx, sim, sim.destination!.x, sim.destination!.y);
    return;
  }
  // Backing off. A shelter not yet its own is given up, to be chosen afresh when the
  // hold ends with what it has just seen in mind; walking the same way into the same
  // danger was a slow loop. A shelter it holds, or a trip it is on, is planned again.
  sim.avoidUntil = world.tick + config.behaviour.avoidHold;
  if (sim.destinationKind === 'shelter' && sim.destinationBuilding !== sim.shelter) clearDestination(sim);
  else replan(world, ctx, sim, mode);
  sim.gait = 'run';
  steerAway(ctx, sim);
}
