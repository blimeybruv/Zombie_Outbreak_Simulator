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

import type { Config } from '../../../config';
import { isOutdoorLiving, type Context } from '../../context';
import { functionalProfile } from '../../mapgen/generate';
import { noteStreet, remember } from '../../navigation/memory';
import { dangerAhead, followRoute, headFor, steerAway, steerToward } from './steering';
import { chance, nextFloat, nextInt } from '../../lib/rng';
import type { Building, Sim, Stand, StreetId, World } from '../../state';
import { isFirearm } from '../../state';
import { chooseObjective, reconsider, setObjective } from './awareness';
import { decideBitten, emptyBuilding } from './bitten';
import { outOfAmmo } from '../fighting/arms';
import { capacity, clearDestination, entranceNearest, exitTicks, isLiving, leaveTalk, setDestination } from '../shared/common';
import { carStillMine, considerDriving, giveUpCar } from '../services/cars';
import { decideCars } from '../services/driving';
import { breaks, modeOf, type Mode } from './panic';
import { emitStimulus, intensityAt } from '../shared/stimuli';
import { alert, chooseShelter, evaluateRole, visibleFill } from '../buildings/shelter';
import { radioForSwat, resolveTarget, squadPass, squadTarget, swatVan } from '../services/squads';
import { callAmbulance, decideEmt, decidePatient } from '../services/emt';
import { rideToCall } from '../services/dispatch';
import { barrierAt, barrierNear, cordonShot, flank, holdsFire, nearBarrier, pastBarrier, shut } from '../outside/cordon';
import { answersRescue, queueSlot, reachesQueue, tentsAt } from '../outside/rescue';
import { headForExit, nearestExit } from '../outside/exits';

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
    // Not the cordon's: its soldiers firing at the barrier drew officers into their aimed fire.
    if (cordonShot(world, st.x, st.y)) continue;
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
function nearestDoor(world: World, ctx: Context, sim: Sim, toward: 'any' | 'penalise' | 'exclude', skip: number | null = null, skipToo: number | null = null): Building | null {
  const { config, buildings } = world;
  let door: Building | null = null;
  let doorD = Infinity;
  for (const bid of ctx.map.buildingsNear(sim.x, sim.y, config.behaviour.doorSearchRadius, ctx.buildingIds)) {
    if (bid === sim.refusedBy || bid === skip || bid === skipToo) continue;
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
  // Its nerve gone, it does nothing at all: shock, not hiding. But not again straight
  // after a freeze: out of it, it runs. Re-freezing whenever a freeze ran out, a crowd
  // with one zombie among them stood and froze by turns while it bit each in turn.
  const thawing = sim.thawedAt !== null && world.tick - sim.thawedAt < world.config.cornered.refreeze;
  if (!thawing && breaks(sim, world.config, ctx.company[sim.id]!)) return takeStand(world, sim, 'freeze');
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
/** A small integer hash: deterministic variety without a draw from the run's stream. */
/** Mixed with a conversation's id for the distance its people keep. */
const TALK_SPACING = 0x7a1c;

/** The distance the people of conversation `g` keep from one another (m). */
export function talkSpacing(config: Config, g: number): number {
  const [lo, hi] = config.talk.spacing;
  return lo! + (hi! - lo!) * mix(g, TALK_SPACING);
}

function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/**
 * A cordon soldier at its place with nothing in sight: at ease, not frozen. It stays
 * where it stands and, each period (out of step with the others), either holds still or
 * turns slowly to look somewhere new, to one side or the other of facing back into the
 * city. Anything in sight ends it (true when it acted).
 */
function atEase(world: World, ctx: Context, sim: Sim): boolean {
  if (ctx.threat[sim.id]! > 0 || ctx.nearestZombie[sim.id]! >= 0) return false;
  const ae = world.config.cordon.atEase;
  sim.gait = 'still';
  const period = Math.floor((world.tick + sim.id * 37) / ae.period);
  if (mix(sim.id, period) < ae.still) return true; // this while, it just stands
  const half = world.config.map.size / 2;
  const inward = Math.atan2(half - sim.y, half - sim.x);
  const look = inward + (mix(period, sim.id + 1) - 0.5) * 2 * ae.sweep;
  let turn = look - sim.heading;
  turn = Math.atan2(Math.sin(turn), Math.cos(turn));
  sim.heading += Math.max(-ae.turn, Math.min(ae.turn, turn));
  return true;
}

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
    } else if (!atEase(world, ctx, sim)) {
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
  // A cordon squad holding its post: each at ease about its own place in the line.
  if (leader.post !== null && sim.directUntil === null && d <= sq.slotStill && atEase(world, ctx, sim)) return;
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

const stationCache = new WeakMap<World, Building[]>();
/** The map's police stations, found once per world. */
function policeStations(world: World): Building[] {
  let list = stationCache.get(world);
  if (!list) stationCache.set(world, (list = world.buildings.filter((b) => b.tag === 'policeStation')));
  return list;
}

/**
 * Where an officer run dry can rearm: its station, else the nearest police station, so
 * long as it is not overrun and still holds rounds for its weapon (an officer knows its
 * station's armory; one walking to an empty one would come back out and go again). Null
 * with none: it goes on unarmed.
 */
function policeStationFor(world: World, sim: Sim): Building | null {
  const usable = (b: Building) => b.zombiesInside === 0 && b.stock.some((a) => a.item === 'ammo' || a.item === sim.weapon);
  const own = sim.station === null ? null : world.buildings[sim.station]!;
  if (own !== null && usable(own)) return own;
  let best: Building | null = null, bestD = Infinity;
  for (const b of policeStations(world)) {
    if (!usable(b)) continue;
    const e = b.entrances[0]!;
    const d = Math.hypot(e.x - sim.x, e.y - sim.y);
    if (d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
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
      const tc = config.talk;
      // The conversation's distance, and the nearest other in it (start-of-tick positions).
      const own = talkSpacing(config, g);
      ctx.simHash.query(sim.x, sim.y, own + tc.spacingSlack, ctx.ids2);
      let near = Infinity, nx = 0, ny = 0, nid = -1;
      for (const id of ctx.ids2) {
        const o = world.sims[id]!;
        if (id === sim.id || o.gathering !== g || o.insideBuilding !== null) continue;
        const d = Math.hypot(o.x - sim.x, o.y - sim.y);
        if (d < near) [near, nx, ny, nid] = [d, o.x, o.y, id];
      }
      // Of two adjusting to each other, the higher id moves and the lower holds: both
      // moving closed or opened the gap twice as fast, overshot, and swung back.
      const yields = nid < sim.id;
      if (near < own * tc.backOff) {
        if (!yields) {
          steerToward(sim, cx, cy);
          sim.gait = 'still';
          return;
        }
        // Too close: a step back from them, then face the conversation again.
        if (near > 0) steerToward(sim, 2 * sim.x - nx, 2 * sim.y - ny);
        else sim.heading = mix(sim.id, tick) * 2 * Math.PI;
        sim.gait = 'sneak';
        return;
      }
      steerToward(sim, cx, cy);
      // Walks in while outside the circle its people would stand on, that distance apart.
      const n = ctx.talkSize[g]!;
      const ring = n <= 2 ? own / 2 : own / (2 * Math.sin(Math.PI / n));
      // A walk from afar, a half step for the last metres: a full step overshot a gap of one.
      const out = Math.hypot(cx - sim.x, cy - sim.y) - ring;
      sim.gait = out <= 0 || near <= own + tc.spacingSlack ? 'still' : out > tc.shuffleWithin ? 'walk' : yields || nid < 0 ? 'sneak' : 'still';
      return;
    }
  }

  // Holding ground until the stand is reconsidered (a fight ends sooner if nothing is in sight).
  if (sim.stand !== null) {
    if (tick < sim.standUntil! && (threat > 0 || sim.stand === 'freeze')) return holdStand(world, ctx, sim);
    if (sim.stand === 'freeze') sim.thawedAt = tick;
    sim.stand = null;
    sim.standUntil = null;
  }
  if (cornered(world, ctx, sim)) return resolveCornered(world, ctx, sim);
  // Run to exhaustion with the dead in sight and its nerve gone: it gives up — but not
  // again straight after a freeze. A crowd sprinting from the dead ran itself out in
  // half a minute, gave up for two, got just enough breath back to sprint again, and
  // gave up again: frozen by turns, bitten one by one.
  const nc = config.nerve;
  const thawing = sim.thawedAt !== null && tick - sim.thawedAt < config.cornered.refreeze;
  if (threat > 0 && !thawing && sim.stamina <= nc.collapseStamina && breaks(sim, config, ctx.company[sim.id]!)) return takeStand(world, sim, 'freeze', nc.collapseTicks);

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
    // Fired on at a barrier: it runs from the guns, back the way it came. Running from the dead as anywhere else, with no door out on the
    // road, the frightened sprinted straight into the soldiers' aimed fire.
    // Going round it already, it keeps going, at a sprint: panic does not undo the choice.
    if (sim.crossing !== null && sim.destinationKind === 'leave' && sim.destination !== null) {
      const e = world.exits[nearestExit(world, sim.destination.x, sim.destination.y)!]!;
      const f = flank(world, e, sim.crossing);
      const to = pastBarrier(world, e, sim.x, sim.y) < 0 ? f.beside : f.out;
      steerToward(sim, to.x, to.y);
      return;
    }
    if (sim.crossing === null && sim.firedOnAt !== null && tick - sim.firedOnAt <= config.cordon.warnEvery) {
      const e = barrierNear(world, sim);
      if (e !== null) {
        const b = barrierAt(world, e);
        steerToward(sim, b.x - e.dx * 2 * config.cordon.warnRadius, b.y - e.dy * 2 * config.cordon.warnRadius);
        return;
      }
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
      if (headFor(world, ctx, sim, sim.destination!.x, sim.destination!.y)) wayBlocked(world, ctx, sim, mode);
    } else {
      clearDestination(sim);
      sim.destinationKind = null;
      steerAway(ctx, sim);
    }
    return;
  }

  // An officer run dry: back to its station (or the nearest) to take what rounds it still
  // holds (buildings.ts restock), giving up any call. A station overrun is no help.
  if (sim.archetype === 'police' && sim.squadLeader === null && outOfAmmo(world, sim)) {
    const station = policeStationFor(world, sim);
    if (station !== null) {
      sim.answering = null;
      if (sim.destinationBuilding !== station.id || sim.destinationKind !== 'shelter') setDestination(sim, station, 'shelter');
      sim.gait = threat > 0 || mode !== 'informed' ? 'run' : 'walk';
      travel(world, ctx, sim, mode);
      return;
    }
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
  const nearest = ctx.nearestZombie[sim.id]!;
  // Few enough of the dead in sight for what it carries: it stands, however near they are.
  let few = false;
  if (engages && nearest >= 0 && sim.archetype === 'police') {
    ctx.zombieHash.query(sim.x, sim.y, ctx.radius[sim.id]!, ctx.ids2);
    const cap = unit.size > 1 ? unit.cap : capacity(world, sim);
    few = ctx.ids2.length <= cap * pc.standRatio;
  }
  const seen = few ? 0 : unit.threat;
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
  // or cornered, and engages again from the door as a dispatcher. Unless the dead in
  // sight are few for what the unit carries: then there is nothing to dither over.
  if (engages && nearest >= 0 && seen < engageBelow && (sim.destinationKind !== 'shelter' || few)) {
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

  // At the rescue's queue, whatever brought it there: it joins those waiting for a truck,
  // unless on duty or in someone's care.
  if (sim.destinationKind !== 'leave' && sim.archetype !== 'police' && sim.crew === null && sim.carriedBy === null && !sim.outsider && reachesQueue(world, ctx, sim)) {
    headForExit(world, sim);
  }

  // Leaving the city (exits.ts): on to the way off the map, in a car if one is at hand,
  // running only with danger in sight. Nowhere to shelter on the way.
  if (sim.destinationKind === 'leave' && sim.destination !== null) {
    const i = nearestExit(world, sim.destination.x, sim.destination.y)!;
    const e = world.exits[i]!;
    if (shut(e)) {
      // Pressing on round it: along the kerb to beside the barrier's end, then out (exits.ts).
      if (sim.crossing !== null) {
        const f = flank(world, e, sim.crossing);
        const to = pastBarrier(world, e, sim.x, sim.y) < 0 ? f.beside : f.out;
        sim.gait = threat > 0 || sim.firedOnAt !== null ? 'run' : 'walk';
        steerToward(sim, to.x, to.y);
        return;
      }
      // The rescue's exit, once the rescue has come: in the queue, each in its own place in
      // the rows behind the cordon line, moving up as the front is let through, and the
      // wait does not end; let through, on to its tent (rescue.ts). Pressing on the barrier
      // instead, the waiting crowded its end and stood on one another.
      if (holdsFire(world, i)) {
        if (sim.tent !== null) {
          const t = tentsAt(world, e)[sim.tent]!;
          sim.gait = 'walk';
          steerToward(sim, t.doorX, t.doorY);
          return;
        }
        if (sim.queuedSince === null && reachesQueue(world, ctx, sim)) sim.queuedSince = tick;
        const rank = ctx.queueRank[sim.id]!;
        if (sim.queuedSince !== null && rank >= 0) {
          const p = queueSlot(world, e, rank);
          if (Math.hypot(p.x - sim.x, p.y - sim.y) <= config.rescue.tents.reach / 2) {
            sim.gait = 'still';
            steerToward(sim, e.x, e.y);
          } else {
            sim.gait = 'walk';
            steerToward(sim, p.x, p.y);
          }
          return;
        }
      } else if (sim.firedOnAt !== null && tick - sim.firedOnAt <= config.cordon.warnEvery && nearBarrier(world, e, sim.x, sim.y)) {
        // Warned off: shots over its head. The less trusting press on round the barrier
        // under fire; the rest give this way out up, for another or for none.
        if (chance(world.rng, config.cordon.defy * (1 - sim.trust))) {
          const b = barrierAt(world, e);
          sim.crossing = (b.x - sim.x) * -e.dy + (b.y - sim.y) * e.dx > 0 ? -1 : 1; // the side it is already on
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
      // Not there yet, or not yet warned: on toward it by the streets, the way it would go
      // out — the route runs down the exit's road. Straight for the barrier, anyone not
      // already on that road walked into the empty ground beside it and stayed there.
      sim.gait = threat > 0 || mode === 'direct' ? 'run' : 'walk';
      travel(world, ctx, sim, mode);
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

/** Places in the rescue's queue, from the snapshot of who stands in it: in the order they joined, the lower id first on a tie. */
function rankQueue(world: World, ctx: Context): void {
  ctx.queueRank.fill(-1, 0, world.sims.length);
  ctx.queueLength = 0;
  if (world.rescueExit === null) return;
  const waiting = world.sims.filter((s) => s.queuedSince !== null && s.tent === null && s.destinationKind === 'leave' && isOutdoorLiving(s) && s.car === null);
  waiting.sort((a, b) => a.queuedSince! - b.queuedSince! || a.id - b.id);
  waiting.forEach((s, k) => (ctx.queueRank[s.id] = k));
  ctx.queueLength = waiting.length;
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
  rankQueue(world, ctx);
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
