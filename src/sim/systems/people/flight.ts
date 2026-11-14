// Flight: panicked past routingCutoff (panic.ts modeOf). No route; a door in sight,
// preferring one that does not lie toward the danger, else away from it. Exceptions
// first: the rescue's queue, a crossing already begun, a barrier that fired on it, and
// those who will never go indoors.

import type { Context } from '../../context';
import { roundCorner, roundObstacle } from '../../navigation/round';
import type { Building, Exit, Sim, Vec2, World } from '../../state';
import { clearDestination, setDestination } from '../shared/common';
import { barrierAt, barrierNear, flank, pastBarrier } from '../outside/cordon';
import { nearestExit } from '../outside/exits';
import type { Mode } from './panic';
import { headFor, steerAway, steerToward } from './steering';
import { diehard } from './traits';
import { nearestDoor, wayBlocked } from './ways';

/** A panicked sim on foot, outdoors, not cornered, standing or backing off: this tick's flight. */
export function flee(world: World, ctx: Context, sim: Sim, mode: Mode): void {
  const { config, buildings, tick } = world;
  sim.gait = 'sprint';
  // Fired on at a barrier: it runs from the guns, back the way it came. Running from the dead as anywhere else, with no door out on the
  // road, the frightened sprinted straight into the soldiers' aimed fire.
  // In the rescue's queue: it keeps its place, cowering, among the soldiers. Bolting,
  // the frightened left the queue for the end of the road.
  if (sim.queuedSince !== null && sim.destinationKind === 'leave' && world.rescueExit !== null) {
    sim.gait = 'still';
    return;
  }
  // Going round it already, it keeps going, at a sprint: panic does not undo the choice.
  if (sim.crossing !== null && sim.destinationKind === 'leave' && sim.destination !== null) {
    const e = world.exits[nearestExit(world, sim.destination.x, sim.destination.y)!]!;
    const to = crossTo(world, e, sim);
    steerToward(sim, to.x, to.y);
    return;
  }
  if (sim.crossing === null && sim.firedOnAt !== null && tick - sim.firedOnAt <= config.cordon.warnEvery) {
    const e = barrierNear(world, sim);
    if (e !== null) {
      // Frightened or not, it knows now that way out is held. Learning it only when
      // calm, the panicked came back to be shot over again, ran for the houses by the
      // barrier, were turned away and froze, over and over (the oddity check).
      sim.knownClosed |= 1 << world.exits.indexOf(e);
      const b = barrierAt(world, e);
      steerToward(sim, b.x - e.dx * 2 * config.cordon.warnRadius, b.y - e.dy * 2 * config.cordon.warnRadius);
      return;
    }
  }
  // One that will never go indoors runs from it in the open. Running for doors, a
  // claustrophobe was turned away by house after house, froze, and ran round them again.
  if (diehard(world, sim)) {
    sim.gait = 'sprint';
    steerAway(ctx, sim);
    return;
  }
  // Not choosing a shelter: running for a door in sight, preferring one that does not
  // lie toward what it is running from — and, once chosen, keeping to it while it is
  // near, unless the danger comes squarely between (wayBlocked picks another).
  // Re-choosing every tick swung the sim between doors as the danger moved.
  // A door it has just chosen is kept wherever it is: one picked as lying away from the
  // danger was often just past the search radius, dropped the next tick for the nearer
  // door it had turned from, and picked again the tick after.
  let door: Building | null = null;
  const chosenLately = sim.lastMigratedAt !== null && tick - sim.lastMigratedAt < config.behaviour.turnedFromHold;
  if (sim.destinationKind === 'shelter' && sim.destinationBuilding !== null && sim.destination !== null) {
    if (chosenLately || Math.hypot(sim.destination.x - sim.x, sim.destination.y - sim.y) <= config.behaviour.doorSearchRadius) door = buildings[sim.destinationBuilding]!;
  }
  door ??= nearestDoor(world, ctx, sim, 'penalise', null, sim.turnedFromUntil !== null && tick < sim.turnedFromUntil ? sim.turnedFrom : null);
  if (door !== null) {
    if (sim.destinationBuilding !== door.id || sim.destinationKind !== 'shelter') {
      // A change of shelter like any other: calm again a tick later, it does not
      // reconsider straight back to the one it was making for. Panic flickering about
      // the flight threshold swung it between the two every tick or two.
      setDestination(sim, door, 'shelter');
      sim.lastMigratedAt = tick;
    }
    // Round the building to a door on its far side. Straight at the nearest door, the
    // panicked sprinted to and fro along a hotel's back wall at the rescue's hour, dozens
    // of them (the oddity check: lap).
    const own = roundCorner(world, ctx, door, sim.x, sim.y, sim.destination!.x, sim.destination!.y, true, sim.heading);
    const w = own === null ? roundObstacle(world, ctx, sim.x, sim.y, sim.destination!.x, sim.destination!.y, door.id, sim.heading) : own;
    const to = w !== null && w !== 'shut' ? w : sim.destination!;
    if (headFor(world, ctx, sim, to.x, to.y)) wayBlocked(world, ctx, sim, mode);
  } else {
    clearDestination(sim);
    sim.destinationKind = null;
    steerAway(ctx, sim);
  }
}

/** Where someone getting past a closed barrier makes for next: round it, the kerb beside its end and then the road's end on that kerb; over it, straight on out. */
export /** Where someone getting past a closed barrier makes for next: round it, the kerb beside its end and then the road's end on that kerb; over it, straight on out. */
function crossTo(world: World, e: Exit, sim: Sim): Vec2 {
  const f = flank(world, e, sim.crossing!);
  return sim.crossing !== 0 && pastBarrier(world, e, sim.x, sim.y) < 0 ? f.beside : f.out;
}
