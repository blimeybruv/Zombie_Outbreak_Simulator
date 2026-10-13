// Tick step 6: sim decisions. Writes beliefs and intent (heading, gait,
// destination, route), never position.
//
// Order of concerns per outdoor sim:
//   observe   write the current street's danger and nearby buildings to memory;
//             a fresh sighting is noted and shouted
//   stand     holding ground: fighting, or frozen, until the stand is reconsidered
//   cornered  no way out: fight if armed, else any door in reach, else freeze
//   flight    panicked: no routing; run for the nearest door, else away from threat
//   engage    police and reckless approach zombies while threat is under their threshold
//   sortie    a dispatcher holds near its door until the sortie ends, then goes back in
//   shelter   threat over the archetype's threshold (or already heading in): home if it
//             has one (commit on choice), else the best known building
//   back off  the way was blocked and there was no other door: away, for a while
//   isolate   bitten, and going off alone to turn in an empty building (bitten.ts)
//   scavenge  on a trip for materials: on to the target, pushing past a little danger
//   respond   those who engage, on the way to trouble they have heard of
//   objective aware of the outbreak: home, else the best shelter known (awareness.ts)
//   routine   unaware: walk to a building, idle inside, pick another
// Anyone travelling goes round danger it can see; danger squarely in the way is a
// decision (wayBlocked): fight if up to it, another door, or back off.
// Indoor sims tick cheaply: stamina, leaving when a routine stop is over, and the
// shelter economy's role and migration check on a staggered cycle (shelter.ts).

import { isOutdoorLiving, type Context } from '../context';
import { functionalProfile } from '../mapgen/generate';
import { noteStreet, remember } from '../memory';
import { sharedNode } from '../pathfinding';
import { chance, nextFloat, nextInt } from '../rng';
import type { Building, Sim, Stand, StreetId, World } from '../state';
import { isFirearm } from '../state';
import { chooseObjective, reconsider, setObjective } from './awareness';
import { decideBitten, emptyBuilding } from './bitten';
import { capacity, clearDestination, entranceNearest, exitTicks, isLiving, leaveTalk, setDestination } from './common';
import { carStillMine, considerDriving, decideCars, giveUpCar } from './cars';
import { breaks, modeOf, type Mode } from './panic';
import { emitStimulus, intensityAt } from './stimuli';
import { alert, chooseShelter, evaluateRole, visibleFill } from './shelter';
import { radioForSwat, resolveTarget, squadPass, squadTarget, swatVan } from './squads';
import { callAmbulance, decideEmt, decidePatient } from './emt';
import { rideToCall } from './dispatch';
import { atClosedExit, flank, pastBarrier, queueAt } from './cordon';
import { answersRescue } from './rescue';
import { headForExit, nearestExit } from './exits';

/**
 * Observation is the only way memory is written from the world. A street is
 * written on entering it; nearby buildings on a staggered close-pass check.
 */
function observe(world: World, ctx: Context, sim: Sim): void {
  const { tick, config } = world;
  const street = ctx.street[sim.id]!;
  if (street >= 0 && street !== sim.street) {
    const prev = sim.streetMemory.get(street as StreetId);
    if (!prev?.visited) sim.history.streetsVisited++;
    noteStreet(world, sim, street as StreetId, ctx.threat[sim.id]!, true);
  }
  sim.street = street >= 0 ? (street as StreetId) : null;

  if (sim.id % config.behaviour.observeInterval !== tick % config.behaviour.observeInterval) return;
  for (const bid of ctx.map.buildingsNear(sim.x, sim.y, config.shelter.closePassRadius, ctx.buildingIds)) {
    const b = world.buildings[bid]!;
    const occupants = b.residents + b.sheltered.length + b.zombiesInside;
    const prev = sim.buildingMemory.get(bid);
    if (prev) {
      prev.believedOccupants = occupants;
      prev.materials = b.materials;
      prev.fortification = b.fortification;
      prev.observedAt = tick;
    } else {
      remember(sim.buildingMemory, bid, { believedOccupants: occupants, materials: b.materials, fortification: b.fortification, observedAt: tick, visited: false }, config.memory.buildingCap);
    }
  }
}

/** The next routine stop. */
function pickRoutineStop(world: World, sim: Sim): Building | null {
  const { config, buildings, rng } = world;
  const bc = config.behaviour;
  let total = 0;
  const picks: { b: Building; w: number }[] = [];
  for (let i = 0; i < bc.routineSample; i++) {
    const b = buildings[nextInt(rng, 0, buildings.length - 1)]!;
    if (b.id === sim.destinationBuilding) continue;
    const professions = config.tagProfessions[functionalProfile(b.tag, config)] as readonly string[];
    const match = professions.includes(sim.profession) ? config.routine.professionStopWeight : 1;
    const e = b.entrances[0]!;
    const w = match / (1 + Math.hypot(e.x - sim.x, e.y - sim.y) / bc.routineDistanceScale);
    picks.push({ b, w });
    total += w;
  }
  // The uneasy are drawn home: home joins the sampled stops, weighted as a stop that
  // suits them would be, times homePull × unease.
  if (sim.unease > 0 && sim.home !== null && sim.home !== sim.destinationBuilding) {
    const home = buildings[sim.home]!;
    const e = home.entrances[0]!;
    const w = (config.unease.homePull * sim.unease * config.routine.professionStopWeight) / (1 + Math.hypot(e.x - sim.x, e.y - sim.y) / bc.routineDistanceScale);
    picks.push({ b: home, w });
    total += w;
  }
  let r = nextFloat(rng) * total;
  for (const p of picks) {
    r -= p.w;
    if (r < 0) return p.b;
  }
  return picks[picks.length - 1]?.b ?? null;
}

/**
 * The officers within unitRadius of this one, itself included: how many there are
 * with something to shoot, the most danger any of them can see (perception snapshot,
 * so every officer in the unit decides on the same numbers this tick), and whether
 * any of them is responding (to a call, to shots, to trouble).
 */
function unitOf(world: World, ctx: Context, sim: Sim): { threat: number; size: number; onCall: boolean; cap: number } {
  ctx.simHash.query(sim.x, sim.y, world.config.police.unitRadius, ctx.ids2);
  let threat = ctx.threat[sim.id]!;
  let size = 1;
  let onCall = responding(sim);
  let cap = capacity(world, sim);
  for (const id of ctx.ids2) {
    if (id === sim.id) continue;
    const o = world.sims[id]!;
    if (o.archetype !== 'police' || capacity(world, o) <= 0) continue;
    size++;
    cap += capacity(world, o);
    if (ctx.threat[id]! > threat) threat = ctx.threat[id]!;
    if (responding(o)) onCall = true;
  }
  return { threat, size, onCall, cap };
}

/** Police responding: to a 911 call, to shots, or to trouble they believe in. */
function responding(s: Sim): boolean {
  return s.answering !== null || s.destinationKind === 'respond';
}

/**
 * The loudest gunshot this sim heard since it last decided, further away than
 * shotIgnoreRadius (its own, or its neighbour's, is not news); ties to the earlier.
 */
function shotHeard(world: World, sim: Sim): { x: number; y: number } | null {
  const { tick, config } = world;
  let best: { x: number; y: number } | null = null;
  let loudest = 0;
  for (const st of world.stimuli) {
    if (st.createdAt < tick - 1 || !isFirearm(st.kind)) continue;
    if (Math.hypot(st.x - sim.x, st.y - sim.y) <= config.police.shotIgnoreRadius) continue;
    const i = intensityAt(st, sim.x, sim.y);
    if (i > loudest) {
      loudest = i;
      best = { x: st.x, y: st.y };
    }
  }
  return best;
}

/** Whether a partner on the same call is still leaving the station, or more than pairGap further from the call. */
function aheadOfPartner(world: World, sim: Sim, dest: { x: number; y: number }): boolean {
  const mine = Math.hypot(dest.x - sim.x, dest.y - sim.y);
  for (const o of world.sims) {
    if (o === sim || o.answering !== sim.answering || !isLiving(o)) continue;
    if (o.insideBuilding !== null) return true;
    if (Math.hypot(dest.x - o.x, dest.y - o.y) - mine > world.config.police.pairGap) return true;
  }
  return false;
}

/** Anyone going somewhere other than a routine stop, routing on memory, plans again now. */
function replan(world: World, ctx: Context, sim: Sim, mode: Mode): void {
  if (sim.destination === null || sim.destinationKind === 'routine' || mode !== 'informed') return;
  sim.route = ctx.paths.route(sim, sim.destination.x, sim.destination.y, true) ?? [];
  sim.routeIndex = 0;
  sim.nextRepathAt = world.tick + world.config.pathfinding.repathCooldown;
}

/**
 * A fresh sighting: the sim writes the street the zombie is on into memory as
 * dangerous — an observation, like any other — shouts a warning about it, and, if it
 * is going somewhere other than a routine stop, plans its way there again at once
 * with that in mind. Danger seen directly ahead does not wait its turn in the repath
 * queue. Without this the route still ran through the zombie, and the sim walked back
 * into it as soon as it stopped avoiding: flee, resume, approach, flee.
 */
function noteThreat(world: World, ctx: Context, sim: Sim, mode: Mode): void {
  const { config, zombies } = world;
  const zid = ctx.nearestZombie[sim.id]!;
  if (zid < 0) return;
  const z = zombies[zid]!;
  const street = ctx.map.nearestStreet(z.x, z.y, config.map.offStreetLookup);
  if (street !== null) {
    // The zombie's street, at what a sighting means, not at the seer's distance from it.
    const danger = config.memory.sightedDanger;
    // ...and shouts it to whoever is near (heard in the encounters step). The shout is
    // a noise like any other: the dead hear it too.
    ctx.warnings.push({ from: sim.id, x: sim.x, y: sim.y, street, danger });
    emitStimulus(world, sim.x, sim.y, 'shout', config.encounters.shoutNoiseRadius, false, config.behaviour.shoutIntensity);
    noteStreet(world, sim, street, danger);
  }
  replan(world, ctx, sim, mode);
}

function steerToward(sim: Sim, x: number, y: number): void {
  const dx = x - sim.x;
  const dy = y - sim.y;
  if (dx !== 0 || dy !== 0) sim.heading = Math.atan2(dy, dx);
}

/** How directly ahead, along its heading, the danger lies: the cosine, or 0 with none in sight. */
function dangerAhead(ctx: Context, sim: Sim): number {
  const tx = ctx.threatX[sim.id]!, ty = ctx.threatY[sim.id]!;
  const tl = Math.hypot(tx, ty);
  if (ctx.threat[sim.id]! <= 0 || tl === 0) return 0;
  return (Math.cos(sim.heading) * tx + Math.sin(sim.heading) * ty) / tl;
}

/**
 * Going somewhere with danger ahead: bend the heading away from it, more the closer
 * and more directly ahead it is, so the sim goes round rather than through. Danger
 * behind or beside it changes nothing: it is already getting away.
 *
 * Returns true, leaving the heading on the goal, when the danger is squarely in the
 * way (the blend at least `cornered.blockedAt`). Bending further would turn the sim
 * back the way it came, and a step further off the blend would weaken and turn it
 * forward again: the hover in front of a zombie that read as beelining back and
 * forth. The caller decides instead (wayBlocked).
 */
function goRound(world: World, ctx: Context, sim: Sim): boolean {
  const threat = ctx.threat[sim.id]!;
  const ahead = dangerAhead(ctx, sim);
  if (threat <= 0 || ahead <= 0) return false;
  const tl = Math.hypot(ctx.threatX[sim.id]!, ctx.threatY[sim.id]!);
  const ux = ctx.threatX[sim.id]! / tl, uy = ctx.threatY[sim.id]! / tl;
  const dx = Math.cos(sim.heading), dy = Math.sin(sim.heading);
  const w = world.config.behaviour.avoidWeight * threat * ahead;
  if (w >= world.config.cornered.blockedAt) return true;
  sim.heading = Math.atan2(dy - w * uy, dx - w * ux);
  return false;
}

/** Toward a point, going round any danger in the way. True if the danger blocks it. */
function headFor(world: World, ctx: Context, sim: Sim, x: number, y: number): boolean {
  steerToward(sim, x, y);
  return goRound(world, ctx, sim);
}

function steerAway(ctx: Context, sim: Sim): void {
  const tx = ctx.threatX[sim.id]!;
  const ty = ctx.threatY[sim.id]!;
  if (tx !== 0 || ty !== 0) sim.heading = Math.atan2(-ty, -tx);
}

/** Follows the cached route; queues a repath when there is none. True if danger blocks the way. */
function followRoute(world: World, ctx: Context, sim: Sim): boolean {
  if (sim.destination === null) return false;
  const { config, tick, repathQueue, nodes } = world;
  if (sim.route.length === 0) {
    if (!ctx.queued[sim.id] && tick >= sim.nextRepathAt) {
      ctx.queued[sim.id] = 1;
      repathQueue.push(sim.id);
    }
    return headFor(world, ctx, sim, sim.destination.x, sim.destination.y);
  }
  for (;;) {
    const i = sim.routeIndex;
    if (i >= sim.route.length - 1) return headFor(world, ctx, sim, sim.destination.x, sim.destination.y);
    const node = sharedNode(world, sim.route[i]!, sim.route[i + 1]!);
    if (node === null) {
      sim.route = [];
      return false;
    }
    const n = nodes[node]!;
    if (Math.hypot(n.x - sim.x, n.y - sim.y) <= config.behaviour.waypointRadius) {
      sim.routeIndex++;
      continue;
    }
    return headFor(world, ctx, sim, n.x, n.y);
  }
}

/** Whether a door lies toward what the sim fears: within doorTowardThreatCos of its direction. */
function towardThreat(world: World, ctx: Context, sim: Sim, x: number, y: number): boolean {
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
function nearestDoor(world: World, ctx: Context, sim: Sim, toward: 'any' | 'penalise' | 'exclude', skip: number | null = null): Building | null {
  const { config, buildings } = world;
  let door: Building | null = null;
  let doorD = Infinity;
  for (const bid of ctx.map.buildingsNear(sim.x, sim.y, config.behaviour.doorSearchRadius, ctx.buildingIds)) {
    if (bid === sim.refusedBy || bid === skip) continue;
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

/**
 * No way out: a zombie within `cornered.near` — close enough that running is worse
 * than swinging — danger enough, and either on several sides (threatFocus under
 * `cornered.spread`) or with no walkable ground a few metres along the way away from
 * it — a wall, the river, a building. Without the distance gate, danger seen 60 m off
 * with an open street behind had a sim with a kitchen knife plant its feet.
 */
export function cornered(world: World, ctx: Context, sim: Sim): boolean {
  const cc = world.config.cornered;
  if (ctx.threat[sim.id]! < cc.threat) return false;
  const zid = ctx.nearestZombie[sim.id]!;
  if (zid < 0) return false;
  const z = world.zombies[zid]!;
  if (Math.hypot(z.x - sim.x, z.y - sim.y) > cc.near) return false;
  if (ctx.threatFocus[sim.id]! < cc.spread) return true;
  const tx = ctx.threatX[sim.id]!, ty = ctx.threatY[sim.id]!;
  const tl = Math.hypot(tx, ty);
  return tl > 0 && !ctx.map.walkable(sim.x - (tx / tl) * cc.probe, sim.y - (ty / tl) * cc.probe);
}

function takeStand(world: World, sim: Sim, stand: Stand, ticks?: number): void {
  const cc = world.config.cornered;
  sim.stand = stand;
  sim.standUntil = world.tick + (ticks ?? (stand === 'fight' ? cc.fightTicks : cc.freezeTicks));
  sim.gait = 'still';
}

/** A fighter faces the nearest zombie (combat does the rest); a frozen sim keeps still. */
function holdStand(world: World, ctx: Context, sim: Sim): void {
  sim.gait = 'still';
  const zid = ctx.nearestZombie[sim.id]!;
  if (sim.stand === 'fight' && zid >= 0) steerToward(sim, world.zombies[zid]!.x, world.zombies[zid]!.y);
}

/**
 * Fight, flight or freeze, with nowhere to run: fight if it carries anything to fight
 * with; else a dash for a door, whichever way it lies — the one already chosen, or
 * failing that the nearest in reach; else freeze, and hope not to be seen. Keeping
 * the chosen door matters: on the edge of cornered, re-choosing swung the sim between
 * the nearest door and the one it had picked as lying away from the danger.
 */
function resolveCornered(world: World, ctx: Context, sim: Sim): void {
  // Its nerve gone, it does nothing at all: shock, not hiding.
  if (breaks(sim, world.config, ctx.company[sim.id]!)) return takeStand(world, sim, 'freeze');
  if (capacity(world, sim) > 0) return takeStand(world, sim, 'fight');
  const { buildings } = world;
  let door: Building | null = null;
  if (sim.destinationKind === 'shelter' && sim.destinationBuilding !== null) door = buildings[sim.destinationBuilding]!;
  door ??= nearestDoor(world, ctx, sim, 'any');
  if (door === null) return takeStand(world, sim, 'freeze');
  if (sim.destinationBuilding !== door.id || sim.destinationKind !== 'shelter') setDestination(sim, door, 'shelter');
  sim.gait = 'sprint';
  steerToward(sim, sim.destination!.x, sim.destination!.y);
}

/**
 * The danger is squarely between the sim and where it is going, though there is a
 * way out. Fight, if what it carries is up to the zombies close by; else another
 * door, one that does not lie toward them; else back off for avoidHold ticks, with
 * the route planned again around what it saw.
 */
function wayBlocked(world: World, ctx: Context, sim: Sim, mode: Mode): void {
  const { config } = world;
  const cap = capacity(world, sim);
  if (cap > 0 && !breaks(sim, config, ctx.company[sim.id]!)) {
    ctx.zombieHash.query(sim.x, sim.y, config.cornered.fightRadius, ctx.ids2);
    if (ctx.ids2.length > 0 && cap >= ctx.ids2.length) return takeStand(world, sim, 'fight');
  }
  // (Someone going off alone, bitten, wants no other door: it backs off and goes on.)
  const door = sim.destinationKind === 'isolate' ? null : nearestDoor(world, ctx, sim, 'exclude', sim.destinationBuilding);
  if (door !== null) {
    setDestination(sim, door, 'shelter');
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

/** On along the route, dealing with a blocked way. */
function travel(world: World, ctx: Context, sim: Sim, mode: Mode): void {
  if (followRoute(world, ctx, sim)) wayBlocked(world, ctx, sim, mode);
}

/**
 * Called up: to the depot, never stopping to shelter. Panicked, it gets clear of the
 * danger first — away from it, not into a doorway — and goes on when calm; otherwise
 * it walks, running only with danger in sight (it is a long way, and a reservist run
 * dry was caught on the way). The way blocked: it fights if what it carries is up to
 * the zombies close by, else backs off for avoidHold ticks, plans again, and goes on.
 */
function decideMuster(world: World, ctx: Context, sim: Sim, mode: Mode): void {
  const { config, buildings } = world;
  const depot = buildings[sim.depot!]!;
  if (sim.destinationBuilding !== depot.id || sim.destinationKind !== 'muster') setDestination(sim, depot, 'muster');
  if (mode === 'flight') {
    sim.gait = 'sprint';
    steerAway(ctx, sim);
    return;
  }
  sim.gait = ctx.threat[sim.id]! > 0 || mode === 'direct' ? 'run' : 'walk';
  if (!followRoute(world, ctx, sim)) return;
  const cap = capacity(world, sim);
  if (cap > 0) {
    ctx.zombieHash.query(sim.x, sim.y, config.cornered.fightRadius, ctx.ids2);
    if (ctx.ids2.length > 0 && cap >= ctx.ids2.length) return takeStand(world, sim, 'fight');
  }
  sim.avoidUntil = world.tick + config.behaviour.avoidHold;
  replan(world, ctx, sim, mode);
  steerAway(ctx, sim);
}

/** Faces the nearest zombie in sight, or `fallback`'s way. */
function faceDanger(world: World, ctx: Context, sim: Sim, fallback: number): void {
  const zid = ctx.nearestZombie[sim.id]!;
  if (zid >= 0) steerToward(sim, world.zombies[zid]!.x, world.zombies[zid]!.y);
  else sim.heading = fallback;
}

/**
 * A squad leader: engaged, it holds the diamond, facing the danger (combat does the
 * shooting). Otherwise on to its target (squads.ts squadTarget), or back to its depot
 * with none, at a walk, waiting while a follower lags. At an occupied door it goes in,
 * if the squad's summed capacity says so (buildings.ts acceptable); a call with nothing
 * left to fight is answered. Only the leader plans a route.
 */
function decideLeader(world: World, ctx: Context, sim: Sim): void {
  const { config, tick, buildings } = world;
  const sq = config.squads;
  if (sim.diamondUntil !== null && tick < sim.diamondUntil) {
    sim.gait = 'still';
    faceDanger(world, ctx, sim, sim.heading);
    return;
  }
  // A cordon squad (cordon.ts): to its post by the barrier, and there it stays.
  if (sim.post !== null) {
    if (Math.hypot(sim.post.x - sim.x, sim.post.y - sim.y) > world.config.cordon.postReach / 2) {
      sim.gait = 'walk';
      headFor(world, ctx, sim, sim.post.x, sim.post.y);
    } else {
      sim.gait = 'still';
      faceDanger(world, ctx, sim, sim.heading);
    }
    return;
  }
  const t = squadTarget(world, ctx, sim);
  if (t !== null && Math.hypot(t.x - sim.x, t.y - sim.y) <= sq.sceneRadius) {
    if (t.building !== null && t.building.zombiesInside > 0) {
      if (sim.destinationBuilding !== t.building.id) setDestination(sim, t.building, 'respond');
      sim.gait = 'walk';
      headFor(world, ctx, sim, sim.destination!.x, sim.destination!.y);
      return;
    }
    resolveTarget(world, sim);
    sim.gait = 'still';
    return;
  }
  // SWAT with its van at the station and a long way to go: to the van, and in together.
  if (t !== null && swatVan(world, ctx, sim, t)) {
    if (sim.car === null) {
      sim.gait = ctx.squadLag[sim.id] ? 'still' : 'walk';
      if (sim.gait === 'walk') headFor(world, ctx, sim, sim.destination!.x, sim.destination!.y);
    }
    return;
  }
  if (t === null && sim.depot === null) {
    sim.gait = 'still'; // nowhere it belongs (a cordon squad that lost its post): it holds
    return;
  }
  if (t === null) {
    const depot = buildings[sim.depot!]!;
    if (sim.destinationBuilding !== depot.id) setDestination(sim, depot, 'respond');
  } else if (t.building !== null && sim.destinationBuilding !== t.building.id) {
    setDestination(sim, t.building, 'respond');
  }
  sim.gait = ctx.squadLag[sim.id] ? 'still' : 'walk';
  if (sim.gait === 'still') return;
  // The way blocked: the squad stands and fights it out (the diamond, next tick).
  if (followRoute(world, ctx, sim)) {
    sim.diamondUntil = tick + sq.diamondHold;
    sim.gait = 'still';
  }
}

/**
 * A follower: no route, only its slot (squads.ts squadPass) — or, with the leader gone
 * in somewhere, after it through the door. A slot out of reach slotPatience ticks
 * running (round a corner, inside a wall) and it makes straight for the leader for
 * directHold ticks or until within rejoinRadius: the hysteresis that keeps it from
 * swinging between the two, as backing off does for the fleeing.
 */
function decideFollower(world: World, ctx: Context, sim: Sim): void {
  const { config, tick, buildings } = world;
  const sq = config.squads;
  const leader = world.sims[sim.squadLeader!]!;
  if (leader.insideBuilding !== null) {
    const b = buildings[leader.insideBuilding]!;
    if (sim.destinationBuilding !== b.id) setDestination(sim, b, 'respond');
    sim.gait = 'run';
    headFor(world, ctx, sim, sim.destination!.x, sim.destination!.y);
    return;
  }
  if (sim.destination !== null) clearDestination(sim);
  sim.destinationKind = null;
  let tx = ctx.slotX[sim.id]!, ty = ctx.slotY[sim.id]!;
  if (sim.directUntil !== null) {
    if (tick < sim.directUntil && Math.hypot(leader.x - sim.x, leader.y - sim.y) > sq.rejoinRadius) {
      tx = leader.x;
      ty = leader.y;
    } else {
      sim.directUntil = null;
    }
  }
  if (sim.directUntil === null) {
    if (Math.hypot(tx - sim.x, ty - sim.y) > sq.slotLost) {
      sim.offSlotSince ??= tick;
      if (tick - sim.offSlotSince >= sq.slotPatience) {
        sim.directUntil = tick + sq.directHold;
        sim.offSlotSince = null;
        tx = leader.x;
        ty = leader.y;
      }
    } else {
      sim.offSlotSince = null;
    }
  }
  const d = Math.hypot(tx - sim.x, ty - sim.y);
  if (d <= sq.slotStill) {
    sim.gait = 'still';
    faceDanger(world, ctx, sim, leader.heading);
    return;
  }
  sim.gait = d > sq.slotRun ? 'run' : 'walk';
  headFor(world, ctx, sim, tx, ty);
}

/**
 * A squad indoors. The leader: a building still occupied is fought for (contest); a
 * call answered; at its depot it waits for a target, and goes out to one; anywhere
 * else, out. A follower stays while its leader is in the same building, else goes out.
 */
function decideSquadIndoor(world: World, ctx: Context, sim: Sim): void {
  const { tick, buildings } = world;
  const b = buildings[sim.insideBuilding!]!;
  if (sim.squadLeader !== sim.id) {
    if (world.sims[sim.squadLeader!]!.insideBuilding !== b.id) sim.exitingUntil = tick + exitTicks(world, b);
    return;
  }
  if (b.zombiesInside > 0) return;
  if (sim.answering === b.id) resolveTarget(world, sim);
  if (b.id === sim.depot && squadTarget(world, ctx, sim) === null) return;
  sim.exitingUntil = tick + exitTicks(world, b);
}

function decideOutdoor(world: World, ctx: Context, sim: Sim, mode: Mode): void {
  const { config, buildings, zombies, tick } = world;
  const arch = config.archetypes[sim.archetype];
  const threat = ctx.threat[sim.id]!;
  if (threat > 0) {
    sim.awareAt ??= tick; // seeing one is knowing
    if (sim.sightedAt === null || tick - sim.sightedAt > config.behaviour.avoidHold) noteThreat(world, ctx, sim, mode);
    sim.sightedAt = tick;
  }

  // Talking: closing in on the others, then standing still facing them, until the
  // conversation ends (encounters) or anyone in it sees danger, or this one panics.
  if (sim.gathering !== null) {
    const g = sim.gathering;
    if (ctx.talkAlarm[g] || mode === 'flight' || sim.stand !== null) leaveTalk(sim, tick);
    else {
      const cx = ctx.talkX[g]!, cy = ctx.talkY[g]!;
      steerToward(sim, cx, cy);
      const tc = config.talk;
      sim.gait = Math.hypot(cx - sim.x, cy - sim.y) > tc.closeIn + tc.closeInPer * ctx.talkSize[g]! ? 'walk' : 'still';
      return;
    }
  }

  // Holding ground until the stand is reconsidered (a fight ends sooner if nothing is in sight).
  if (sim.stand !== null) {
    if (tick < sim.standUntil! && (threat > 0 || sim.stand === 'freeze')) return holdStand(world, ctx, sim);
    sim.stand = null;
    sim.standUntil = null;
  }
  if (cornered(world, ctx, sim)) return resolveCornered(world, ctx, sim);
  // Run to exhaustion with the dead in sight and its nerve gone: it gives up.
  const nc = config.nerve;
  if (threat > 0 && sim.stamina <= nc.collapseStamina && breaks(sim, config, ctx.company[sim.id]!)) return takeStand(world, sim, 'freeze', nc.collapseTicks);

  // Backing off from a blocked way, until the hold ends, whatever else would apply:
  // a panicked sim that ran for the same door again, or someone who engages turning
  // back in, made each tick of the hold a reversal. The way out is kept, not re-aimed
  // at every glimpse: only danger ahead turns it.
  if (sim.avoidUntil !== null) {
    if (tick < sim.avoidUntil) {
      sim.gait = 'run';
      if (dangerAhead(ctx, sim) > 0.5) steerAway(ctx, sim);
      return;
    }
    sim.avoidUntil = null;
  }

  // Called up, or in a squad (squads.ts): their own business, not shelter or flight.
  if (sim.muster === 'mobilised') return decideMuster(world, ctx, sim, mode);
  if (sim.squadLeader !== null) return sim.squadLeader === sim.id ? decideLeader(world, ctx, sim) : decideFollower(world, ctx, sim);

  if (mode === 'flight') {
    sim.gait = 'sprint';
    // Not choosing a shelter: running for a door in sight, preferring one that does not
    // lie toward what it is running from — and, once chosen, keeping to it while it is
    // near, unless the danger comes squarely between (wayBlocked picks another).
    // Re-choosing every tick swung the sim between doors as the danger moved.
    let door: Building | null = null;
    if (sim.destinationKind === 'shelter' && sim.destinationBuilding !== null && sim.destination !== null) {
      if (Math.hypot(sim.destination.x - sim.x, sim.destination.y - sim.y) <= config.behaviour.doorSearchRadius) door = buildings[sim.destinationBuilding]!;
    }
    door ??= nearestDoor(world, ctx, sim, 'penalise');
    if (door !== null) {
      if (sim.destinationBuilding !== door.id || sim.destinationKind !== 'shelter') setDestination(sim, door, 'shelter');
      if (headFor(world, ctx, sim, sim.destination!.x, sim.destination!.y)) wayBlocked(world, ctx, sim, mode);
    } else {
      clearDestination(sim);
      sim.destinationKind = null;
      steerAway(ctx, sim);
    }
    return;
  }

  const engages = arch.engageThreshold > 0 && capacity(world, sim) > 0;
  // Police decide as a unit: the danger the most exposed officer nearby sees, and a
  // threshold that rises with numbers. Deciding alone, the officer in front fell back
  // while those behind, not yet seeing it, walked on past.
  const unit = engages && sim.archetype === 'police' ? unitOf(world, ctx, sim) : { threat, size: 1, onCall: responding(sim), cap: 0 };
  // Police responding — to a call, to shots, to trouble — hold their ground longer than a
  // patrol officer would, and a patrol officer alongside them holds with them.
  const base = unit.onCall ? Math.max(arch.engageThreshold, config.dispatch.engageThreshold) : arch.engageThreshold;
  const pc = config.police;
  const engageBelow = unit.size > 1 ? Math.max(base, Math.min(pc.unitMaxThreshold, base * (1 + pc.unitStrength * (unit.size - 1)))) : base;
  const seen = unit.threat;
  const nearest = ctx.nearestZombie[sim.id]!;
  // On a call and outmatched: more zombies in sight than the unit can handle. It radios
  // for SWAT, with what it counted (squads.ts radioForSwat).
  if (unit.onCall && nearest >= 0 && sim.archetype === 'police' && sim.squadLeader === null) {
    const sc = config.swat;
    if (sim.radioedAt === null || tick - sim.radioedAt >= sc.radioCooldown) {
      ctx.zombieHash.query(sim.x, sim.y, ctx.radius[sim.id]!, ctx.ids2);
      if (ctx.ids2.length >= sc.radioMin && ctx.ids2.length > unit.cap * sc.radioRatio) radioForSwat(world, ctx, sim, ctx.ids2.length);
    }
  }
  // Falling back is a decision: on the way to shelter it does not turn to engage again
  // when the danger dips (that dithered at the threshold); it still fights if blocked
  // or cornered, and engages again from the door as a dispatcher.
  if (engages && nearest >= 0 && seen < engageBelow && sim.destinationKind !== 'shelter') {
    const z = zombies[nearest]!;
    const w = sim.weapon!;
    const range = isFirearm(w) ? config.combat.ranged[w].range * 0.8 : config.combat.contactRange;
    const d = Math.hypot(z.x - sim.x, z.y - sim.y);
    steerToward(sim, z.x, z.y);
    sim.gait = d > range ? 'walk' : 'still';
    return;
  }

  if (sim.sortieUntil !== null) {
    // Nothing in reach to engage: wait by the door until the sortie ends. More than it
    // can handle, or nothing left to shoot with: back inside.
    if (tick < sim.sortieUntil && capacity(world, sim) > 0 && threat < arch.engageThreshold) {
      sim.gait = 'still';
      return;
    }
    sim.sortieUntil = null;
    if (sim.shelter !== null) setDestination(sim, buildings[sim.shelter]!, 'shelter');
  }

  // Going off alone, bitten: on to the empty building, or the next one if somebody is
  // in it now; if none is left, it carries on like anyone else.
  if (sim.destinationKind === 'isolate') {
    const b = sim.destinationBuilding === null ? null : buildings[sim.destinationBuilding]!;
    const target = b !== null && visibleFill(b) === 0 ? b : emptyBuilding(world, ctx, sim);
    if (target !== null) {
      if (target !== b) setDestination(sim, target, 'isolate');
      sim.gait = 'walk';
      travel(world, ctx, sim, mode);
      return;
    }
    clearDestination(sim);
    sim.destinationKind = null;
    sim.infectedChoice = 'conceal';
  }

  const nerve = sim.destinationKind === 'scavenge' ? config.roles.scavengerNerve : 0;
  // Shots fired: police drop what they are doing and run for the sound — even on the way
  // back to shelter, unless their unit already sees more than it will stand. Officers who
  // fell back one by one used to scatter to their own shelters; now they converge on the
  // gunfire, where the others are, and stand as a unit.
  if (engages && sim.archetype === 'police' && sim.answering === null && sim.sortieUntil === null) {
    const shot = shotHeard(world, sim);
    const standsTo = Math.max(engageBelow, config.dispatch.engageThreshold);
    if (shot !== null && seen < standsTo) {
      // Already on the way to trouble: keep going (re-aiming at every louder shot re-planned
      // every tick, and halved the simulation's speed).
      if (sim.destinationKind !== 'respond' || sim.destination === null) {
        sim.destination = { x: shot.x, y: shot.y };
        sim.destinationBuilding = null;
        sim.destinationKind = 'respond';
        replan(world, ctx, sim, mode);
      }
      sim.gait = 'run';
      travel(world, ctx, sim, mode);
      return;
    }
  }

  // Walking to a car to drive away in: on to it while it is still free, running if
  // anything is in sight (cars.ts boards it on arrival).
  if (sim.destinationKind === 'car') {
    if (!carStillMine(world, sim)) giveUpCar(world, sim);
    else {
      sim.gait = threat > 0 || mode === 'direct' ? 'run' : 'walk';
      travel(world, ctx, sim, mode);
      return;
    }
  }

  // The rescue's broadcast heard: for its exit, once calm (rescue.ts).
  if (answersRescue(world, sim)) headForExit(world, sim); // (in flight it has already run for a door, above)

  // At a closed exit, whatever brought it there: a way out, shut, with people waiting
  // at it. It joins them — and may try the flank, like anyone who set out to leave —
  // unless it has already given this one up. Not those on duty or in someone's care.
  if (sim.destinationKind !== 'leave' && sim.archetype !== 'police' && sim.crew === null && sim.carriedBy === null && !sim.outsider) {
    const i = atClosedExit(world, sim);
    if (i !== null) {
      const e = world.exits[i]!;
      sim.destinationKind = 'leave';
      sim.destinationBuilding = null;
      sim.destination = { x: e.x, y: e.y };
      sim.crossing = null;
      sim.route = [];
      sim.routeIndex = 0;
    }
  }

  // Leaving the city (exits.ts): on to the way off the map, in a car if one is at hand,
  // running only with danger in sight. Nowhere to shelter on the way.
  if (sim.destinationKind === 'leave' && sim.destination !== null) {
    const i = nearestExit(world, sim.destination.x, sim.destination.y)!;
    const e = world.exits[i]!;
    // Closed by the cordon: stop short of the barrier and wait to be let through, until
    // patience gives out — the trusting wait longest — then try another way, or none.
    if (e.closedAt !== null) {
      // Getting round it: along the kerb to beside the barrier's end, then out (exits.ts).
      if (sim.crossing !== null) {
        const f = flank(world, e, sim.crossing);
        const to = pastBarrier(world, e, sim.x, sim.y) < 0 ? f.beside : f.out;
        sim.gait = threat > 0 ? 'run' : 'walk';
        steerToward(sim, to.x, to.y);
        return;
      }
      const q = queueAt(world, e);
      if (Math.hypot(q.x - sim.x, q.y - sim.y) <= config.cordon.queueRadius) {
        sim.queuedSince ??= tick;
        // At the rescue's exit the wait is for a truck, among soldiers: it does not end (rescue.ts).
        // Elsewhere the dead in sight end it at once: nobody stands in a queue to be caught.
        if (i === world.rescueExit || (threat === 0 && tick - sim.queuedSince < config.cordon.patience * (0.5 + sim.trust))) {
          sim.gait = 'still';
          steerToward(sim, e.x, e.y);
          return;
        }
        sim.queuedSince = null;
        // Patience out: the less trusting try to get round it; the rest give it up.
        if (chance(world.rng, config.cordon.cross * (1 - sim.trust))) {
          sim.crossing = (q.x - sim.x) * -e.dy + (q.y - sim.y) * e.dx > 0 ? -1 : 1; // the side it is already on
          return;
        }
        sim.knownClosed |= 1 << i;
        if (!headForExit(world, sim)) {
          // Every way out it knows of is shut: no longer leaving.
          clearDestination(sim);
          sim.destinationKind = null;
        }
        return;
      }
      // Not there yet: on toward it (the road through is shut, so straight on).
      sim.gait = threat > 0 || mode === 'direct' ? 'run' : 'walk';
      headFor(world, ctx, sim, q.x, q.y);
      return;
    }
    sim.gait = threat > 0 || mode === 'direct' ? 'run' : 'walk';
    if (!considerDriving(world, ctx, sim, mode)) travel(world, ctx, sim, mode);
    return;
  }

  // Those who engage fall back when the danger their unit sees passes what they will
  // stand, or their own shelter threshold, whichever comes first.
  const seeks = engages ? seen >= Math.min(engageBelow, arch.shelterSeekThreshold + nerve) : threat >= arch.shelterSeekThreshold + nerve;
  if (seeks || sim.destinationKind === 'shelter') {
    // On the way home with trouble now in sight: a home still far off is given up for
    // the best shelter nearer to hand.
    const divert =
      seeks && sim.destinationBuilding !== null && sim.destinationBuilding === sim.home && sim.shelter !== sim.home &&
      Math.hypot(sim.destination!.x - sim.x, sim.destination!.y - sim.y) > config.awareness.divertBeyond;
    if (divert) {
      const b = chooseShelter(world, ctx, sim, sim.refusedBy);
      if (b !== null && b.id !== sim.home) setDestination(sim, b, 'shelter');
    } else if (sim.destinationKind !== 'shelter' || sim.destinationBuilding === null) {
      // Commit on choice: home first, unless home turned it away.
      const home = sim.shelter !== null && sim.shelter !== sim.refusedBy ? buildings[sim.shelter]! : null;
      const b = home ?? chooseShelter(world, ctx, sim, sim.refusedBy);
      if (b === null) {
        sim.gait = 'run';
        steerAway(ctx, sim);
        return;
      }
      setDestination(sim, b, 'shelter');
    } else if (sim.awareAt !== null) {
      reconsider(world, ctx, sim);
      if (considerDriving(world, ctx, sim, mode)) {
        sim.gait = threat > 0 || mode === 'direct' ? 'run' : 'walk';
        travel(world, ctx, sim, mode);
        return;
      }
    }
    sim.gait = threat > 0 || mode === 'direct' ? 'run' : 'walk';
    travel(world, ctx, sim, mode);
    return;
  }

  if (sim.destinationKind === 'scavenge' && sim.destinationBuilding !== null) {
    sim.gait = mode === 'direct' ? 'run' : 'walk';
    travel(world, ctx, sim, mode);
    return;
  }

  // Responding: on to the trouble. Once there, what it sees is what that street is
  // like now (an observation, like any other), and it looks again.
  if (sim.destinationKind === 'respond') {
    const dest = sim.destination;
    const arrival = sim.answering !== null ? config.dispatch.sceneRadius : config.awareness.respondArrival;
    if (dest !== null && Math.hypot(dest.x - sim.x, dest.y - sim.y) > arrival) {
      // Their station's police car at the kerb: to it, and in together (dispatch.ts).
      const ride = rideToCall(world, ctx, sim, dest);
      if (ride === 'aboard') return;
      if (ride !== null) {
        sim.gait = 'run';
        headFor(world, ctx, sim, ride.x, ride.y);
        return;
      }
      // Officers sent together arrive together: the one ahead waits for its partner.
      sim.gait = sim.answering === null ? 'run' : aheadOfPartner(world, sim, dest) ? 'still' : 'walk';
      if (sim.gait !== 'still') travel(world, ctx, sim, mode);
      return;
    }
    const street = dest === null ? null : ctx.map.nearestStreet(dest.x, dest.y, config.map.offStreetLookup);
    if (street !== null) noteStreet(world, sim, street, threat);
    clearDestination(sim);
    sim.destinationKind = null;
    // A first responder on the scene: the call is answered; back to the station.
    if (sim.answering !== null) {
      const called = buildings[sim.answering]!;
      called.callAt = null;
      called.dispatchedAt = null;
      sim.answering = null;
      setDestination(sim, buildings[sim.station!]!, 'shelter');
      sim.gait = 'walk';
      travel(world, ctx, sim, mode);
      return;
    }
  }

  // Aware of the outbreak: an objective, not an errand. (Someone who engages and knows
  // of no trouble has none, and keeps patrolling.)
  if (sim.awareAt !== null) {
    const o = chooseObjective(world, ctx, sim);
    if (o !== null) {
      setObjective(sim, o);
      sim.gait = mode === 'direct' ? 'run' : 'walk';
      travel(world, ctx, sim, mode);
      return;
    }
  }

  // Routine: unaware, so nothing in sight to block the way.
  if (sim.destinationBuilding === null || sim.destinationKind !== 'routine') {
    const b = pickRoutineStop(world, sim);
    if (b === null) {
      sim.gait = 'still';
      return;
    }
    setDestination(sim, b, 'routine');
  }
  sim.gait = mode === 'direct' ? 'run' : 'walk';
  travel(world, ctx, sim, mode);
}

/**
 * Panicked, or backing off: the heading leans toward the way the people running
 * around it are going, so a fleeing crowd flows as a current rather than scattering,
 * and someone carried along by it stops recomputing its own way out each tick. Only
 * while running: someone standing to fight or frozen is not carried.
 */
function followCrowd(world: World, ctx: Context, sim: Sim): void {
  if (sim.gait !== 'run' && sim.gait !== 'sprint') return;
  const cx = ctx.crowdX[sim.id]!, cy = ctx.crowdY[sim.id]!;
  const cl = Math.hypot(cx, cy);
  if (cl === 0) return;
  const w = world.config.crowd.crowdAlignment * Math.min(1, cl);
  sim.heading = Math.atan2(Math.sin(sim.heading) + (w * cy) / cl, Math.cos(sim.heading) + (w * cx) / cl);
}

function decideIndoor(world: World, ctx: Context, sim: Sim): void {
  const { config, tick, buildings } = world;
  sim.gait = 'still';
  sim.stamina = Math.min(1, sim.stamina + config.movement.gait.still.stamina);
  if (sim.exitingUntil !== null) return;
  // A squad, a reservist waiting at its depot, or one called up somewhere else (out, and on).
  if (sim.squadLeader !== null) return decideSquadIndoor(world, ctx, sim);
  if (sim.muster === 'waiting') return;
  // The rescue's broadcast heard: out, for its exit, once calm (rescue.ts).
  if (modeOf(sim, config) !== 'flight' && answersRescue(world, sim) && headForExit(world, sim)) {
    sim.exitingUntil = tick + exitTicks(world, buildings[sim.insideBuilding!]!);
    return;
  }
  if (sim.muster === 'mobilised' && sim.insideBuilding !== sim.depot) {
    sim.exitingUntil = tick + exitTicks(world, buildings[sim.insideBuilding!]!);
    return;
  }
  // Heard the news while out on an errand: stay, if this is as good a shelter as it
  // knows, or set out for the objective.
  if (sim.destinationKind === 'routine' && sim.awareAt !== null) {
    const here = buildings[sim.insideBuilding!]!;
    const o = chooseObjective(world, ctx, sim);
    if (o !== null && o.kind !== 'respond' && o.building === here) {
      sim.idleUntil = null;
      sim.shelter = here.id;
      sim.destinationKind = 'shelter';
      alert(world, here);
      return;
    }
    if (o !== null) {
      setObjective(sim, o);
      sim.exitingUntil = tick + exitTicks(world, here);
      return;
    }
  }
  if (sim.destinationKind === 'routine' && sim.idleUntil !== null && tick >= sim.idleUntil) {
    const b = buildings[sim.insideBuilding!]!;
    sim.idleUntil = null;
    sim.exitingUntil = tick + Math.round(b.fortification * config.buildings.exitTicksPerFortification);
    return;
  }
  if (sim.shelter === sim.insideBuilding && sim.id % config.roles.interval === tick % config.roles.interval) evaluateRole(world, ctx, sim);
}

function drainRepathQueue(world: World, ctx: Context): void {
  const { config, tick, sims } = world;
  const queue = world.repathQueue;
  if (queue.length === 0) return;
  queue.sort((a, b) => a - b);
  const take = queue.splice(0, config.pathfinding.repathQueueCap);
  for (const id of take) {
    ctx.queued[id] = 0;
    const sim = sims[id]!;
    sim.nextRepathAt = tick + config.pathfinding.repathCooldown;
    if (!isOutdoorLiving(sim) || sim.destination === null) continue;
    const route = ctx.paths.route(sim, sim.destination.x, sim.destination.y, modeOf(sim, config) === 'informed');
    sim.route = route ?? [];
    sim.routeIndex = 0;
  }
}

/** Where each conversation stands (the middle of those in it) and whether anyone in it sees danger, from the perception snapshot. */
function locateTalks(world: World, ctx: Context): void {
  const { sims } = world;
  ctx.talkX.fill(0, 0, sims.length);
  ctx.talkY.fill(0, 0, sims.length);
  ctx.talkSize.fill(0, 0, sims.length);
  ctx.talkAlarm.fill(0, 0, sims.length);
  for (const s of sims) {
    if (s.gathering === null || !isOutdoorLiving(s)) continue;
    const g = s.gathering;
    ctx.talkX[g]! += s.x;
    ctx.talkY[g]! += s.y;
    ctx.talkSize[g]!++;
    if (ctx.threat[s.id]! > 0) ctx.talkAlarm[g] = 1;
  }
  for (const s of sims) {
    const n = ctx.talkSize[s.id]!;
    if (n === 0) continue;
    ctx.talkX[s.id]! /= n;
    ctx.talkY[s.id]! /= n;
  }
}

export function simDecisions(world: World, ctx: Context): void {
  locateTalks(world, ctx);
  squadPass(world, ctx);
  for (const sim of world.sims) {
    if (sim.condition !== 'healthy' && sim.condition !== 'infected') continue;
    if (sim.car !== null) continue; // in a car: the car decides (cars.ts)
    decideBitten(world, ctx, sim);
    callAmbulance(world, sim);
    // An EMT on a job, or its patient: where the job takes them (emt.ts).
    if (decideEmt(world, ctx, sim) || decidePatient(world, sim)) {
      if (sim.insideBuilding === null && sim.destination !== null) {
        const d = Math.hypot(sim.destination.x - sim.x, sim.destination.y - sim.y);
        if (d < 1) sim.gait = 'still';
        else headFor(world, ctx, sim, sim.destination.x, sim.destination.y);
      }
      continue;
    }
    if (sim.insideBuilding !== null) {
      decideIndoor(world, ctx, sim);
      continue;
    }
    observe(world, ctx, sim);
    const mode = modeOf(sim, world.config);
    decideOutdoor(world, ctx, sim, mode);
    if (sim.gathering === null && (mode !== 'informed' || sim.avoidUntil !== null)) followCrowd(world, ctx, sim);
  }
  drainRepathQueue(world, ctx);
  decideCars(world, ctx);
}
