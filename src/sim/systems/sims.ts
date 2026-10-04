// Tick step 6: sim decisions. Writes beliefs and intent (heading, gait,
// destination, route), never position.
//
// Order of concerns per outdoor sim:
//   observe   write the current street's danger and nearby buildings to memory
//   flight    panicked: no routing; run for the nearest door, else away from threat
//   engage    police and reckless approach zombies while threat is under their threshold
//   shelter   threat over the archetype's threshold (or already heading in): route to the best known building
//   avoid     some threat, under the threshold: step away from it
//   routine   unaware: walk to a building, idle inside, pick another
// Indoor sims tick cheaply: stamina, and leaving when a routine stop is over.

import { isOutdoorLiving, type Context } from '../context';
import { confidence } from '../derived';
import { functionalProfile } from '../mapgen/generate';
import { remember } from '../memory';
import { sharedNode } from '../pathfinding';
import { nextFloat, nextInt } from '../rng';
import type { Building, BuildingId, Sim, StreetId, World } from '../state';
import { modeOf, type Mode } from './panic';

export function entranceNearest(b: Building, x: number, y: number): { x: number; y: number } {
  let best = b.entrances[0]!;
  let bestD = Infinity;
  for (const e of b.entrances) {
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

export function capacity(world: World, sim: Sim): number {
  const { combat } = world.config;
  const w = sim.weapon;
  if (w === null) return 0;
  if (w === 'pistol' || w === 'smg' || w === 'shotgun') return Math.floor(sim.ammo * combat.ranged[w].baseKill);
  return combat.melee[w].capacity;
}

function setDestination(sim: Sim, b: Building, kind: Sim['destinationKind']): void {
  const e = entranceNearest(b, sim.x, sim.y);
  sim.destination = { x: e.x, y: e.y };
  sim.destinationBuilding = b.id;
  sim.destinationKind = kind;
  sim.route = [];
  sim.routeIndex = 0;
}

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

function groupTerm(n: number, peak: number): number {
  return n <= peak ? n / peak : peak / n;
}

function chooseShelter(world: World, ctx: Context, sim: Sim, exclude: BuildingId | null): Building | null {
  const { config, tick, buildings } = world;
  const w = config.shelter.weights;
  const m = config.archetypes[sim.archetype].shelterWeights;
  const loner = sim.archetype === 'loner';
  const candidates = new Set<BuildingId>(sim.buildingMemory.keys());
  for (const bid of ctx.map.buildingsNear(sim.x, sim.y, ctx.radius[sim.id]!, ctx.buildingIds)) candidates.add(bid);

  let best: Building | null = null;
  let bestScore = -Infinity;
  for (const bid of [...candidates].sort((a, b) => a - b)) {
    if (bid === exclude) continue;
    const b = buildings[bid]!;
    const belief = sim.buildingMemory.get(bid);
    const occupants = belief ? belief.believedOccupants : b.residents + b.sheltered.length + b.zombiesInside;
    if (loner && occupants > 0) continue;
    const streetBelief = sim.streetMemory.get(b.street);
    const danger = streetBelief ? streetBelief.danger * confidence(streetBelief.observedAt, tick, config) : 0;
    const e = entranceNearest(b, sim.x, sim.y);
    const dist = Math.hypot(e.x - sim.x, e.y - sim.y);
    const score =
      w.integrity * m.integrity * config.tags[functionalProfile(b.tag, config)].integrity +
      w.fortification * m.fortification * (belief ? belief.fortification : b.fortification) +
      w.streetQuiet * m.streetQuiet * (1 - danger) +
      w.group * m.group * groupTerm(occupants, config.shelter.groupPeak) +
      w.materials * m.materials * Math.min(1, (belief ? belief.materials : b.materials) / config.shelter.materialsScale) -
      w.distance * m.distance * (dist / 1000);
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  if (best) return best;
  const near = ctx.map.buildingsNear(sim.x, sim.y, config.behaviour.shelterFallbackRadius, ctx.buildingIds);
  const fallback = near.find((id) => id !== exclude);
  return fallback === undefined ? null : buildings[fallback]!;
}

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
      sim.destination = null;
      sim.destinationBuilding = null;
      sim.route = [];
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

  const seeks = threat >= arch.shelterSeekThreshold || (engages && threat >= arch.engageThreshold);
  if (seeks || sim.destinationKind === 'shelter') {
    if (sim.destinationKind !== 'shelter' || sim.destinationBuilding === null) {
      const b = chooseShelter(world, ctx, sim, null);
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

  if (threat > 0) {
    sim.gait = sim.archetype === 'civilian' || sim.archetype === 'reckless' ? 'run' : 'sneak';
    steerAway(ctx, sim);
    return;
  }

  // Routine.
  if (sim.destinationBuilding === null || sim.destinationKind !== 'routine') {
    const b = pickRoutineStop(world, sim);
    if (b === null) {
      sim.gait = 'still';
      return;
    }
    setDestination(sim, b, 'routine');
  }
  sim.gait = mode === 'direct' ? 'run' : 'walk';
  followRoute(world, ctx, sim);
}

function decideIndoor(world: World, sim: Sim): void {
  const { config, tick, buildings } = world;
  sim.gait = 'still';
  sim.stamina = Math.min(1, sim.stamina + config.movement.gait.still.stamina);
  if (sim.exitingUntil !== null) return;
  if (sim.destinationKind === 'routine' && sim.idleUntil !== null && tick >= sim.idleUntil) {
    const b = buildings[sim.insideBuilding!]!;
    sim.idleUntil = null;
    sim.exitingUntil = tick + Math.round(b.fortification * config.buildings.exitTicksPerFortification);
  }
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
      decideIndoor(world, sim);
      continue;
    }
    observe(world, ctx, sim);
    decideOutdoor(world, ctx, sim, modeOf(sim, world.config));
  }
  drainRepathQueue(world, ctx);
}
