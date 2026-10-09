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
import { remember } from '../memory';
import { sharedNode } from '../pathfinding';
import { nextFloat, nextInt } from '../rng';
import type { Building, Sim, Stand, StreetId, World } from '../state';
import { chooseObjective, setObjective } from './awareness';
import { decideBitten, emptyBuilding } from './bitten';
import { capacity, clearDestination, entranceNearest, exitTicks, setDestination } from './common';
import { modeOf, type Mode } from './panic';
import { emitStimulus } from './stimuli';
import { alert, chooseShelter, evaluateRole, visibleFill } from './shelter';

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
    if (prev) {
      prev.danger = ctx.threat[sim.id]!;
      prev.observedAt = tick;
      prev.visited = true;
    } else {
      remember(sim.streetMemory, street as StreetId, { danger: ctx.threat[sim.id]!, observedAt: tick, visited: true }, config.memory.streetCap);
    }
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
  let r = nextFloat(rng) * total;
  for (const p of picks) {
    r -= p.w;
    if (r < 0) return p.b;
  }
  return picks[picks.length - 1]?.b ?? null;
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
  const { config, tick, zombies } = world;
  const zid = ctx.nearestZombie[sim.id]!;
  if (zid < 0) return;
  const z = zombies[zid]!;
  const street = ctx.map.nearestStreet(z.x, z.y, config.map.offStreetLookup);
  if (street !== null) {
    const danger = ctx.threat[sim.id]!;
    // ...and shouts it to whoever is near (heard in the encounters step). The shout is
    // a noise like any other: the dead hear it too.
    ctx.warnings.push({ from: sim.id, x: sim.x, y: sim.y, street, danger });
    emitStimulus(world, sim.x, sim.y, 'shout', config.encounters.warnRadius, false, config.behaviour.shoutIntensity);
    const belief = sim.streetMemory.get(street);
    if (belief) {
      belief.danger = danger;
      belief.observedAt = tick;
    } else {
      remember(sim.streetMemory, street, { danger, observedAt: tick, visited: false }, config.memory.streetCap);
    }
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
 * No way out: danger enough, and either on several sides (threatFocus under
 * `cornered.spread`) or with no walkable ground a few metres along the way away
 * from it — a wall, the river, a building.
 */
function cornered(world: World, ctx: Context, sim: Sim): boolean {
  const cc = world.config.cornered;
  if (ctx.threat[sim.id]! < cc.threat) return false;
  if (ctx.threatFocus[sim.id]! < cc.spread) return true;
  const tx = ctx.threatX[sim.id]!, ty = ctx.threatY[sim.id]!;
  const tl = Math.hypot(tx, ty);
  return tl > 0 && !ctx.map.walkable(sim.x - (tx / tl) * cc.probe, sim.y - (ty / tl) * cc.probe);
}

function takeStand(world: World, sim: Sim, stand: Stand): void {
  const cc = world.config.cornered;
  sim.stand = stand;
  sim.standUntil = world.tick + (stand === 'fight' ? cc.fightTicks : cc.freezeTicks);
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
  if (cap > 0) {
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

function decideOutdoor(world: World, ctx: Context, sim: Sim, mode: Mode): void {
  const { config, buildings, zombies, tick } = world;
  const arch = config.archetypes[sim.archetype];
  const threat = ctx.threat[sim.id]!;
  if (threat > 0) {
    sim.awareAt ??= tick; // seeing one is knowing
    if (sim.sightedAt === null || tick - sim.sightedAt > config.behaviour.avoidHold) noteThreat(world, ctx, sim, mode);
    sim.sightedAt = tick;
  }

  // Holding ground until the stand is reconsidered (a fight ends sooner if nothing is in sight).
  if (sim.stand !== null) {
    if (tick < sim.standUntil! && (threat > 0 || sim.stand === 'freeze')) return holdStand(world, ctx, sim);
    sim.stand = null;
    sim.standUntil = null;
  }
  if (cornered(world, ctx, sim)) return resolveCornered(world, ctx, sim);

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
      steerAway(ctx, sim);
    }
    return;
  }

  const engages = arch.engageThreshold > 0 && capacity(world, sim) > 0;
  const nearest = ctx.nearestZombie[sim.id]!;
  // Falling back is a decision: on the way to shelter it does not turn to engage again
  // when the danger dips (that dithered at the threshold); it still fights if blocked
  // or cornered, and engages again from the door as a dispatcher.
  if (engages && nearest >= 0 && threat < arch.engageThreshold && sim.destinationKind !== 'shelter') {
    const z = zombies[nearest]!;
    const w = sim.weapon!;
    const range = w === 'pistol' || w === 'smg' || w === 'shotgun' ? config.combat.ranged[w].range * 0.8 : config.combat.contactRange;
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
  const seeks = threat >= arch.shelterSeekThreshold + nerve || (engages && threat >= arch.engageThreshold);
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
    if (dest !== null && Math.hypot(dest.x - sim.x, dest.y - sim.y) > config.awareness.respondArrival) {
      sim.gait = 'walk';
      travel(world, ctx, sim, mode);
      return;
    }
    const street = dest === null ? null : ctx.map.nearestStreet(dest.x, dest.y, config.map.offStreetLookup);
    if (street !== null) remember(sim.streetMemory, street, { danger: threat, observedAt: tick, visited: sim.streetMemory.get(street)?.visited ?? false }, config.memory.streetCap);
    clearDestination(sim);
    sim.destinationKind = null;
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

function decideIndoor(world: World, ctx: Context, sim: Sim): void {
  const { config, tick, buildings } = world;
  sim.gait = 'still';
  sim.stamina = Math.min(1, sim.stamina + config.movement.gait.still.stamina);
  if (sim.exitingUntil !== null) return;
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

export function simDecisions(world: World, ctx: Context): void {
  for (const sim of world.sims) {
    if (sim.condition !== 'healthy' && sim.condition !== 'infected') continue;
    decideBitten(world, ctx, sim);
    if (sim.insideBuilding !== null) {
      decideIndoor(world, ctx, sim);
      continue;
    }
    observe(world, ctx, sim);
    decideOutdoor(world, ctx, sim, modeOf(sim, world.config));
  }
  drainRepathQueue(world, ctx);
}
