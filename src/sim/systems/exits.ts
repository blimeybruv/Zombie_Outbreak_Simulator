// Leaving the city. A sim making for a way off the map (`destinationKind` leave) walks
// or drives to its exit — the nearest, by the signposts: the highways out are common
// knowledge — and on reaching it is out of play, counted as rescued. A car reaching an
// exit takes everyone in it out, and is gone. Nobody at the exit looks for a bite (no
// cordon yet): the bitten get out too, and are counted as they leave (World.escapedInfected).

import type { Context } from '../context';
import { simLeaf, transfer } from '../counters';
import type { Car, Sim, World } from '../state';

/** The nearest way off the map from a point, of those not in `skip` (bits), or null. */
export function nearestExit(world: World, x: number, y: number, skip = 0): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  world.exits.forEach((e, i) => {
    if (skip & (1 << i)) return;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Sets a sim making for the nearest way off the map it has not found closed. False if there is none. */
export function headForExit(world: World, sim: Sim): boolean {
  const i = nearestExit(world, sim.x, sim.y, sim.knownClosed);
  if (i === null) return false;
  const e = world.exits[i]!;
  sim.destinationKind = 'leave';
  sim.destinationBuilding = null;
  sim.destination = { x: e.x, y: e.y };
  sim.route = [];
  sim.routeIndex = 0;
  return true;
}

/** Out of play: through the exit, counted as rescued (bitten or not). */
export function leaveMap(world: World, ctx: Context, sim: Sim): void {
  const from = simLeaf(sim);
  if (from === null) return;
  if (sim.condition === 'infected') world.escapedInfected++;
  sim.condition = 'rescued';
  sim.turnsAt = null;
  sim.car = null;
  sim.history.endedAt = world.tick;
  transfer(world, from, 'unturned.rescued');
  ctx.events.push({ type: 'simLeft', tick: world.tick, sim: sim.id, x: sim.x, y: sim.y });
}

/** On foot: anyone making for a way off the map who has reached it leaves. Building processes. */
export function exitArrivals(world: World, ctx: Context): void {
  const reach = world.config.map.exits.reach;
  for (const sim of world.sims) {
    if (sim.destinationKind !== 'leave' || sim.insideBuilding !== null || sim.car !== null || sim.destination === null) continue;
    if (sim.condition !== 'healthy' && sim.condition !== 'infected') continue;
    const e = world.exits[nearestExit(world, sim.destination.x, sim.destination.y)!]!;
    if (e.closedAt !== null) continue; // the cordon: nobody passes
    if (Math.hypot(sim.destination.x - sim.x, sim.destination.y - sim.y) <= reach) leaveMap(world, ctx, sim);
  }
}

/** A car at its exit: everyone in it leaves, and so does the car. */
export function carLeaves(world: World, ctx: Context, car: Car): void {
  for (const id of car.occupants) leaveMap(world, ctx, world.sims[id]!);
  car.occupants = [];
  car.state = 'gone';
  car.speed = 0;
  car.route = [];
  car.destination = null;
  car.exit = null;
}
