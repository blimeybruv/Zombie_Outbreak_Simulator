// Tick step 6: sim decisions. Writes beliefs and intent (heading, gait,
// destination, route), never position.
//
// Order of concerns per outdoor sim:
//   observe   write the current street's danger and nearby buildings to memory
//   flight    panicked: no routing; run for the nearest door, else away from threat
//   engage    police and reckless approach zombies while threat is under their threshold
//   sortie    a dispatcher holds near its door until the sortie ends, then goes back in
//   shelter   threat over the archetype's threshold (or already heading in): home if it
//             has one (commit on choice), else the best known building
//   avoid     some threat, under the threshold: step away from it
//   scavenge  on a trip for materials: on to the target, pushing past a little danger
//   routine   unaware: walk to a building, idle inside, pick another
// Indoor sims tick cheaply: stamina, leaving when a routine stop is over, and the
// shelter economy's role and migration check on a staggered cycle (shelter.ts).

import { isOutdoorLiving, type Context } from '../context';
import { functionalProfile } from '../mapgen/generate';
import { remember } from '../memory';
import { sharedNode } from '../pathfinding';
import { nextFloat, nextInt } from '../rng';
import type { Building, Sim, StreetId, World } from '../state';
import { capacity, clearDestination, entranceNearest, setDestination } from './common';
import { modeOf, type Mode } from './panic';
import { emitStimulus } from './stimuli';
import { chooseShelter, evaluateRole } from './shelter';

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

/**
 * The next routine stop. `ahead`, if given, is the heading the sim is fleeing along:
 * stops behind it — back toward what it fled — weigh `scaredBehindWeight`.
 */
function pickRoutineStop(world: World, sim: Sim, ahead: number | null = null): Building | null {
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
    const behind = ahead !== null && Math.cos(ahead) * (e.x - sim.x) + Math.sin(ahead) * (e.y - sim.y) < 0;
    const w = (match * (behind ? bc.scaredBehindWeight : 1)) / (1 + Math.hypot(e.x - sim.x, e.y - sim.y) / bc.routineDistanceScale);
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

/**
 * A fresh sighting: the sim writes the street the zombie is on into memory as
 * dangerous — an observation, like any other — shouts a warning about it, and, if it is going somewhere
 * other than a routine stop, plans its way there again at once with that in mind.
 * Danger seen directly ahead does not wait its turn in the repath queue. Without
 * this the route still ran through the zombie, and the sim walked back into it as
 * soon as it stopped avoiding: flee, resume, approach, flee.
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
  if (sim.destination !== null && sim.destinationKind !== 'routine' && mode === 'informed') {
    sim.route = ctx.paths.route(sim, sim.destination.x, sim.destination.y, true) ?? [];
    sim.routeIndex = 0;
    sim.nextRepathAt = tick + config.pathfinding.repathCooldown;
  }
}

function steerToward(sim: Sim, x: number, y: number): void {
  const dx = x - sim.x;
  const dy = y - sim.y;
  if (dx !== 0 || dy !== 0) sim.heading = Math.atan2(dy, dx);
}

function steerAway(ctx: Context, sim: Sim): void {
  const tx = ctx.threatX[sim.id]!;
  const ty = ctx.threatY[sim.id]!;
  if (tx !== 0 || ty !== 0) sim.heading = Math.atan2(-ty, -tx);
}

/** Follows the cached route; queues a repath when there is none. */
function followRoute(world: World, ctx: Context, sim: Sim): void {
  if (sim.destination === null) return;
  const { config, tick, repathQueue, nodes } = world;
  if (sim.route.length === 0) {
    if (!ctx.queued[sim.id] && tick >= sim.nextRepathAt) {
      ctx.queued[sim.id] = 1;
      repathQueue.push(sim.id);
    }
    steerToward(sim, sim.destination.x, sim.destination.y);
    return;
  }
  for (;;) {
    const i = sim.routeIndex;
    if (i >= sim.route.length - 1) {
      steerToward(sim, sim.destination.x, sim.destination.y);
      return;
    }
    const node = sharedNode(world, sim.route[i]!, sim.route[i + 1]!);
    if (node === null) {
      sim.route = [];
      return;
    }
    const n = nodes[node]!;
    if (Math.hypot(n.x - sim.x, n.y - sim.y) <= config.behaviour.waypointRadius) {
      sim.routeIndex++;
      continue;
    }
    steerToward(sim, n.x, n.y);
    return;
  }
}

function decideOutdoor(world: World, ctx: Context, sim: Sim, mode: Mode): void {
  const { config, buildings, zombies } = world;
  const arch = config.archetypes[sim.archetype];
  const threat = ctx.threat[sim.id]!;

  if (mode === 'flight') {
    sim.gait = 'sprint';
    // Not choosing a shelter: running for the nearest door in sight.
    let door: Building | null = null;
    let doorD = Infinity;
    for (const bid of ctx.map.buildingsNear(sim.x, sim.y, config.behaviour.doorSearchRadius, ctx.buildingIds)) {
      if (bid === sim.refusedBy) continue;
      const b = buildings[bid]!;
      const e = entranceNearest(b, sim.x, sim.y);
      const d = Math.hypot(e.x - sim.x, e.y - sim.y);
      if (d < doorD) {
        doorD = d;
        door = b;
      }
    }
    if (door !== null) {
      if (sim.destinationBuilding !== door.id) setDestination(sim, door, 'shelter');
      steerToward(sim, sim.destination!.x, sim.destination!.y);
    } else {
      clearDestination(sim);
      steerAway(ctx, sim);
    }
    return;
  }

  const engages = arch.engageThreshold > 0 && capacity(world, sim) > 0;
  const nearest = ctx.nearestZombie[sim.id]!;
  if (engages && nearest >= 0 && threat < arch.engageThreshold) {
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
    if (world.tick < sim.sortieUntil && capacity(world, sim) > 0 && threat < arch.engageThreshold) {
      sim.gait = 'still';
      return;
    }
    sim.sortieUntil = null;
    if (sim.shelter !== null) setDestination(sim, buildings[sim.shelter]!, 'shelter');
  }

  const nerve = sim.destinationKind === 'scavenge' ? config.roles.scavengerNerve : 0;
  const seeks = threat >= arch.shelterSeekThreshold + nerve || (engages && threat >= arch.engageThreshold);
  if (seeks || sim.destinationKind === 'shelter') {
    if (sim.destinationKind !== 'shelter' || sim.destinationBuilding === null) {
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
    followRoute(world, ctx, sim);
    return;
  }

  if (threat > 0 || (sim.avoidUntil !== null && world.tick < sim.avoidUntil)) {
    sim.gait = sim.archetype === 'civilian' || sim.archetype === 'reckless' ? 'run' : 'sneak';
    if (threat > 0) {
      if (sim.avoidUntil === null) noteThreat(world, ctx, sim, mode); // a new sighting, not one already being avoided
      sim.avoidUntil = world.tick + config.behaviour.avoidHold;
      steerAway(ctx, sim);
    } // else: out of sight for now, keep going the way it was going
    return;
  }
  // Just stopped avoiding: a walker on a routine does not go back the way it fled.
  const scared = sim.avoidUntil !== null;
  sim.avoidUntil = null;
  if (scared && sim.destinationKind === 'routine') clearDestination(sim);

  if (sim.destinationKind === 'scavenge' && sim.destinationBuilding !== null) {
    sim.gait = mode === 'direct' ? 'run' : 'walk';
    followRoute(world, ctx, sim);
    return;
  }

  // Routine.
  if (sim.destinationBuilding === null || sim.destinationKind !== 'routine') {
    const b = pickRoutineStop(world, sim, scared ? sim.heading : null);
    if (b === null) {
      sim.gait = 'still';
      return;
    }
    setDestination(sim, b, 'routine');
  }
  sim.gait = mode === 'direct' ? 'run' : 'walk';
  followRoute(world, ctx, sim);
}

function decideIndoor(world: World, ctx: Context, sim: Sim): void {
  const { config, tick, buildings } = world;
  sim.gait = 'still';
  sim.stamina = Math.min(1, sim.stamina + config.movement.gait.still.stamina);
  if (sim.exitingUntil !== null) return;
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
    if (sim.insideBuilding !== null) {
      decideIndoor(world, ctx, sim);
      continue;
    }
    observe(world, ctx, sim);
    decideOutdoor(world, ctx, sim, modeOf(sim, world.config));
  }
  drainRepathQueue(world, ctx);
}
