// Flight: panicked past routingCutoff (panic.ts modeOf). No route; a door in sight,
// preferring one that does not lie toward the danger, else away from it. Exceptions
// first: the rescue's queue, a crossing already begun, a barrier that fired on it, and
// those who will never go indoors.

import type { Context } from '../../context';
import { roundCorner, roundObstacle } from '../../navigation/round';
import type { Building, Exit, Sim, StreetId, Vec2, World } from '../../state';
import { clearDestination, entranceNearest, refusedLately, setDestination } from '../shared/common';
import { barrierAt, barrierNear, flank, pastBarrier } from '../outside/cordon';
import { nearestExit } from '../outside/exits';
import type { Mode } from './panic';
import { headFor, steerAway, steerToward } from './steering';
import { diehard } from './traits';
import { nearestDoor, towardThreat, wayBlocked } from './ways';

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
    runOpen(world, ctx, sim);
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
    // ...unless it has since seen the dead on that door's street: news, not a swing.
    // Kept regardless, most runs onto a street just seen dangerous were for a door picked
    // before the sighting (the flight-choice probe, reference "Flight and memory").
    if (door !== null && config.features.flightMemory && door.street !== sim.street && learntSince(world, sim, door.street, sim.lastMigratedAt)) door = null;
  }
  const from = sim.turnedFromUntil !== null && tick < sim.turnedFromUntil ? sim.turnedFrom : null;
  door ??= config.features.flightMemory ? fleeDoor(world, ctx, sim, from) : nearestDoor(world, ctx, sim, 'penalise', null, from);
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
    runOpen(world, ctx, sim);
  }
}

/**
 * Danger the sim remembers on a street from the last flight.recent ticks — seen, shouted
 * to it, or a building fallen there — else 0. Flight does not plan, but it does not
 * forget what it ran from a minute ago: it reads the same street memory routing does,
 * only the fresh part of it, and only for the few streets in front of it.
 */
function recentDanger(world: World, sim: Sim, street: StreetId): number {
  const b = sim.streetMemory.get(street);
  return b !== undefined && world.tick - b.observedAt <= world.config.flight.recent ? b.danger : 0;
}

/** Whether the sim has lately seen danger on `street` that it did not know of at tick `since`. */
function learntSince(world: World, sim: Sim, street: StreetId, since: number | null): boolean {
  const b = sim.streetMemory.get(street);
  return recentDanger(world, sim, street) > 0 && b !== undefined && (since === null || b.observedAt > since);
}

/**
 * The door to run for: the nearest within doorSearchRadius, by distance, made
 * doorTowardThreatPenalty times as far if it lies toward what is in sight and
 * (1 + flight.doorRecent × recent danger) times as far if its street is one the sim
 * has lately seen the dead on — not its own street, where what it can see decides.
 * Never the door that last turned it away, `from`, or one that refused it lately.
 */
function fleeDoor(world: World, ctx: Context, sim: Sim, from: number | null): Building | null {
  const { config, buildings } = world;
  let door: Building | null = null;
  let doorD = Infinity;
  for (const bid of ctx.map.buildingsNear(sim.x, sim.y, config.behaviour.doorSearchRadius, ctx.buildingIds)) {
    if (bid === sim.refusedBy || bid === from || refusedLately(world, sim, bid)) continue;
    const b = buildings[bid]!;
    const e = entranceNearest(b, sim.x, sim.y);
    let d = Math.hypot(e.x - sim.x, e.y - sim.y);
    if (towardThreat(world, ctx, sim, e.x, e.y)) d *= config.behaviour.doorTowardThreatPenalty;
    if (b.street !== sim.street) d *= 1 + config.flight.doorRecent * recentDanger(world, sim, b.street);
    if (d < doorD) {
      doorD = d;
      door = b;
    }
  }
  return door;
}

/**
 * Running in the open, no door to make for: which way. Without flight memory, straight
 * away from what is in sight. With it, the ways open to it are scored and the best
 * taken — at a junction (within flight.junction of the end of its street it is heading
 * toward) every street leaving it, a little way along each; between junctions, on toward
 * either end. With nothing in sight and nothing known of any of them, on as it was going.
 *
 *   score = flight.away    × (the way · away from what is in sight)
 *         − flight.recentWeight × danger lately seen on that street (between junctions: on
 *                            the best street beyond that end; a dead end, flight.deadEnd)
 *         − flight.reverse × how far the way turns back on its heading
 *
 * Away from what is visible being the only term was the crossroads reversal: the dead
 * seen on one street, then on another, and the sim ran straight back to the first.
 * Now a side street beats both. Ties keep the lower street id. Off the streets, or
 * with the way squarely blocked, straight away as before.
 */
export function runOpen(world: World, ctx: Context, sim: Sim): void {
  const { config, streets, nodes } = world;
  if (!config.features.flightMemory) return steerAway(ctx, sim);
  // The street it is moving along: the nearest by centreline, not its membership, which
  // is kept while within half a street's width. Across the junction at the end of a wide
  // bridge, membership stayed the bridge: scored from its ends, a sim turned back to the
  // junction, took a cross street, and turned back again, for good (the oddity check).
  const on = ctx.map.nearestStreet(sim.x, sim.y, config.map.offStreetLookup);
  if (on === null) return steerAway(ctx, sim);
  const fc = config.flight;
  const tx = ctx.threatX[sim.id]!, ty = ctx.threatY[sim.id]!;
  const tl = Math.hypot(tx, ty);
  const ax = tl > 0 ? -tx / tl : 0, ay = tl > 0 ? -ty / tl : 0;
  const hx = Math.cos(sim.heading), hy = Math.sin(sim.heading);
  const st = streets[on]!;
  const na = nodes[st.a]!, nb = nodes[st.b]!;
  const da = Math.hypot(na.x - sim.x, na.y - sim.y), db = Math.hypot(nb.x - sim.x, nb.y - sim.y);
  // The junction it is making for: the nearer end it is heading toward. Choosing at
  // whichever end was nearer, a sim on a street shorter than twice flight.junction was
  // always at one, and crossing the middle swung it to the other, where its own street
  // pointed back: it sprinted to and fro there (the oddity check, at the cordons).
  const toward = (n: typeof na, d: number) => d > 0 && ((n.x - sim.x) * hx + (n.y - sim.y) * hy) / d > 0;
  const ta = da <= fc.junction && toward(na, da), tb = db <= fc.junction && toward(nb, db);
  const near = ta && (!tb || da <= db) ? st.a : tb ? st.b : null;
  let best = -Infinity, bestStreet = Infinity, bx = 0, by = 0, known = 0;
  const consider = (x: number, y: number, danger: number, street: number) => {
    known = Math.max(known, danger);
    const ux = x - sim.x, uy = y - sim.y;
    const ul = Math.hypot(ux, uy);
    if (ul === 0) return;
    const ex = ux / ul, ey = uy / ul;
    const score = fc.away * (ex * ax + ey * ay) - fc.recentWeight * danger - fc.reverse * Math.max(0, -(ex * hx + ey * hy));
    if (score > best || (score === best && street < bestStreet)) [best, bestStreet, bx, by] = [score, street, x, y];
  };
  if (near !== null) {
    const n = nodes[near]!;
    for (const adj of ctx.map.adjacency[near]!) {
      const far = nodes[adj.node]!;
      const t = Math.min(1, fc.lookahead / (adj.length || 1));
      consider(n.x + (far.x - n.x) * t, n.y + (far.y - n.y) * t, adj.street === on ? 0 : recentDanger(world, sim, adj.street), adj.street);
    }
  } else {
    for (const end of [st.a, st.b]) {
      let beyond = Infinity;
      for (const adj of ctx.map.adjacency[end]!) if (adj.street !== on) beyond = Math.min(beyond, recentDanger(world, sim, adj.street));
      const n = nodes[end]!;
      consider(n.x, n.y, beyond === Infinity ? fc.deadEnd : beyond, on);
    }
  }
  // Nothing in sight and nothing known of the ways in front of it: on as it was going
  // (steerAway keeps the heading). The scores only act on what it sees or remembers.
  if (best === -Infinity || (tl === 0 && known === 0) || headFor(world, ctx, sim, bx, by)) steerAway(ctx, sim);
}

/** Where someone getting past a closed barrier makes for next: round it, the kerb beside its end and then the road's end on that kerb; over it, straight on out. */
export function crossTo(world: World, e: Exit, sim: Sim): Vec2 {
  const f = flank(world, e, sim.crossing!);
  return sim.crossing !== 0 && pastBarrier(world, e, sim.x, sim.y) < 0 ? f.beside : f.out;
}
