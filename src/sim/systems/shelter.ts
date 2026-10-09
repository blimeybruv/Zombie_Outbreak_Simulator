// The shelter economy: the only cycle in the design. Builders raise fortification
// and consume materials; materials run out and fortification decays; someone goes
// out for more, and the trip is the danger. Also here: shelter desirability, roles,
// migration, garrisons and the cascade outside them.
//
// Roles are assigned individually, never negotiated: each sheltered sim takes the
// role its own situation argues for (step 6). Residents never get positions, but
// fortification is addition, so up to `residentBuilders` of an alerted building's
// residents work as builders; and when the building needs a scavenger and has no
// tracked sim to send, one resident steps out and becomes tracked (step 10).
//
// Panic is not read here (lint-enforced): only the mode derived from it.

import type { Context } from '../context';
import { confidence } from '../derived';
import { functionalProfile } from '../mapgen/generate';
import { remember } from '../memory';
import { chance, nextFloat, nextInt } from '../rng';
import { spawnSim } from '../spawn';
import type { Building, BuildingBelief, BuildingId, Sim, Weapon, World } from '../state';
import { capacity, entranceNearest, exitTicks, isLiving, setDestination } from './common';
import { modeOf } from './panic';

// Door watch

/**
 * What the people inside can see from the door: the same falloff as perceived
 * threat, summed over zombies near any entrance, without line of sight (they look
 * out of the windows). Dormant zombies count at the dormant weight.
 */
export function doorThreat(world: World, ctx: Context, b: Building): number {
  const { config, zombies } = world;
  const r = config.roles.doorWatchRadius;
  // Each zombie counts once, at its nearest entrance; summed in id order.
  const nearest = new Map<number, number>();
  for (const e of b.entrances) {
    ctx.zombieHash.query(e.x, e.y, r, ctx.ids2);
    for (const zid of ctx.ids2) {
      const z = zombies[zid]!;
      const d = Math.hypot(z.x - e.x, z.y - e.y);
      if (d <= r && d < (nearest.get(zid) ?? Infinity)) nearest.set(zid, d);
    }
  }
  let threat = 0;
  for (const zid of [...nearest.keys()].sort((p, q) => p - q)) {
    threat += (1 - nearest.get(zid)! / r) * (zombies[zid]!.state === 'dormant' ? config.perception.dormantThreatWeight : 1);
  }
  return threat > 1 ? 1 : threat;
}

// Desirability

function groupTerm(n: number, peak: number): number {
  return n <= peak ? n / peak : peak / n;
}

/** The fill a sim sees from outside: identical for residents and occupiers. */
export function visibleFill(b: Building): number {
  return b.residents + b.sheltered.length + b.zombiesInside;
}

/**
 * Shelter desirability from what the sim believes (or knows, when `belief` is
 * null and the building is in sight or the sim is inside it). Archetype sets the
 * weights, never the logic.
 */
export function desirability(world: World, sim: Sim, b: Building, belief: BuildingBelief | undefined, distance: number): number {
  const { config, tick } = world;
  const w = config.shelter.weights;
  const m = config.archetypes[sim.archetype].shelterWeights;
  const occupants = belief ? belief.believedOccupants : visibleFill(b);
  const streetBelief = sim.streetMemory.get(b.street);
  const danger = streetBelief ? streetBelief.danger * confidence(streetBelief.observedAt, tick, config) : 0;
  return (
    w.integrity * m.integrity * config.tags[functionalProfile(b.tag, config)].integrity +
    w.fortification * m.fortification * (belief ? belief.fortification : b.fortification) +
    w.streetQuiet * m.streetQuiet * (1 - danger) +
    w.group * m.group * groupTerm(occupants, config.shelter.groupPeak) +
    w.materials * m.materials * Math.min(1, (belief ? belief.materials : b.materials) / config.shelter.materialsScale) -
    w.distance * m.distance * (distance / 1000)
  );
}

/**
 * Shelter selection reads from memory, not from the map: buildings the sim has
 * entered, passed, been told about, or can see now. Ties go to the lower id.
 */
export function chooseShelter(world: World, ctx: Context, sim: Sim, exclude: BuildingId | null): Building | null {
  const { config, buildings } = world;
  const loner = sim.archetype === 'loner';
  let candidates = new Set<BuildingId>(sim.buildingMemory.keys());
  for (const bid of ctx.map.buildingsNear(sim.x, sim.y, ctx.radius[sim.id]!, ctx.buildingIds)) candidates.add(bid);
  // The faithful consider only churches, while they know one that has not turned them away.
  if (sim.church !== null) {
    const churches = [...candidates].filter((id) => buildings[id]!.tag === 'church' && id !== exclude && id !== sim.refusedBy);
    if (churches.length > 0) candidates = new Set(churches);
  }

  let best: Building | null = null;
  let bestScore = -Infinity;
  for (const bid of [...candidates].sort((a, b) => a - b)) {
    if (bid === exclude) continue;
    const b = buildings[bid]!;
    const belief = sim.buildingMemory.get(bid);
    if (loner && (belief ? belief.believedOccupants : visibleFill(b)) > 0) continue;
    const e = entranceNearest(b, sim.x, sim.y);
    const score = desirability(world, sim, b, belief, Math.hypot(e.x - sim.x, e.y - sim.y));
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

// Scavenging

/** The best remembered source of materials: believed stock (up to a load) over distance. */
export function pickScavengeTarget(world: World, sim: Sim, exclude: BuildingId | null): Building | null {
  const { config, buildings } = world;
  const carry = config.buildings.carryCap;
  let best: Building | null = null;
  let bestScore = 0;
  for (const [bid, belief] of [...sim.buildingMemory.entries()].sort((a, b) => a[0] - b[0])) {
    if (bid === exclude || bid === sim.shelter || bid === sim.refusedBy || belief.materials <= 0) continue;
    const b = buildings[bid]!;
    const e = entranceNearest(b, sim.x, sim.y);
    const score = Math.min(carry, belief.materials) / (1 + Math.hypot(e.x - sim.x, e.y - sim.y) / config.roles.scavengeDistanceScale);
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}

/** Whether this building already has someone out for it. Clears a stale record. */
export function scavengerOut(world: World, b: Building): boolean {
  const id = b.scavengerOut;
  if (id === null) return false;
  const s = world.sims[id]!;
  if (isLiving(s) && s.role === 'scavenger' && s.shelter === b.id) return true;
  b.scavengerOut = null;
  return false;
}

function goOut(world: World, sim: Sim, b: Building): void {
  sim.exitingUntil = world.tick + exitTicks(world, b);
}

function startScavenging(world: World, sim: Sim, home: Building, target: Building): void {
  sim.role = 'scavenger';
  sim.roleSince = world.tick;
  home.scavengerOut = sim.id;
  setDestination(sim, target, 'scavenge');
  goOut(world, sim, home);
}

/** Takes what it can carry from a scavenge target, then heads home. Called on entry. */
export function scavenge(world: World, ctx: Context, sim: Sim, b: Building): void {
  const { config } = world;
  const take = Math.min(config.buildings.carryCap - sim.materials, b.materials);
  b.materials -= take;
  sim.materials += take;
  loot(world, ctx, sim, b);
  const home = sim.shelter === null ? null : world.buildings[sim.shelter]!;
  const next = sim.materials === 0 ? pickScavengeTarget(world, sim, b.id) : null;
  if (next !== null) setDestination(sim, next, 'scavenge');
  else if (home !== null) setDestination(sim, home, 'shelter');
  else {
    sim.destinationKind = 'shelter';
    sim.destinationBuilding = null;
    sim.destination = null;
  }
  goOut(world, sim, b);
}

/** Hands over what the sim carries to the shelter it has just entered. */
export function deliver(world: World, ctx: Context, sim: Sim, b: Building): void {
  const { config, tick } = world;
  if (sim.materials > 0) {
    const amount = Math.min(sim.materials, config.buildings.materialsCap - b.materials);
    if (amount > 0) {
      b.materials += amount;
      sim.materials -= amount;
      sim.history.materialsDelivered += amount;
      ctx.events.push({ type: 'materialsDelivered', tick, sim: sim.id, building: b.id, amount });
    }
  }
  if (sim.role === 'scavenger' || sim.role === 'dispatcher') {
    if (sim.shelter !== null && world.buildings[sim.shelter]!.scavengerOut === sim.id) world.buildings[sim.shelter]!.scavengerOut = null;
    sim.role = null;
    sim.roleSince = tick;
    sim.sortieUntil = null;
  }
}

// Loot

const RANGED = new Set<Weapon>(['pistol', 'smg', 'shotgun']);

/** One roll per entry into a tag that holds anything. Materials come from the building's stock, not here. */
export function loot(world: World, ctx: Context, sim: Sim, b: Building): void {
  const { config, rng, tick } = world;
  if (!(b.tag in config.tags)) return; // flavour tags hold nothing useful
  const table = config.tags[functionalProfile(b.tag, config)].loot as Partial<Record<Weapon | 'ammo' | 'materials', number>>;
  const keys = (Object.keys(table) as (keyof typeof table)[]).filter((k) => k !== 'materials');
  if (keys.length === 0 || !chance(rng, config.buildings.lootChance)) return;
  let total = 0;
  for (const k of keys) total += table[k]!;
  let r = nextFloat(rng) * total;
  let found = keys[keys.length - 1]!;
  for (const k of keys) {
    r -= table[k]!;
    if (r < 0) {
      found = k;
      break;
    }
  }
  const rounds = nextInt(rng, config.buildings.lootAmmo[0]!, config.buildings.lootAmmo[1]!);
  if (found === 'ammo') {
    if (sim.weapon !== null && RANGED.has(sim.weapon)) sim.ammo = Math.min(config.combat.ammoCap, sim.ammo + rounds);
    return;
  }
  const weapon = found as Weapon;
  const ammo = RANGED.has(weapon) ? (weapon === sim.weapon ? Math.min(config.combat.ammoCap, sim.ammo + rounds) : rounds) : 0;
  const better = capacity(world, { ...sim, weapon, ammo }) > capacity(world, sim);
  if (weapon === sim.weapon || better) {
    sim.weapon = weapon;
    sim.ammo = ammo;
    if (better) ctx.events.push({ type: 'weaponFound', tick, sim: sim.id, building: b.id, weapon });
  }
}

// Roles and migration (step 6, sheltered sims)

/** Lower is less useful at home: firepower first, then caution. The incautious go out. */
function usefulness(world: World, s: Sim): number {
  return capacity(world, s) + world.config.roles.usefulnessCaution * s.caution;
}

function leastUseful(world: World, b: Building): Sim | null {
  let best: Sim | null = null;
  let bestU = Infinity;
  for (const id of b.sheltered) {
    const s = world.sims[id]!;
    if (!isLiving(s) || s.shelter !== b.id || s.exitingUntil !== null || s.role === 'dispatcher') continue;
    if (modeOf(s, world.config) !== 'informed') continue;
    const u = usefulness(world, s);
    if (u < bestU || (u === bestU && best !== null && s.id < best.id)) {
      bestU = u;
      best = s;
    }
  }
  return best;
}

function needsMaterials(world: World, b: Building): boolean {
  return b.materials === 0 && b.fortification < world.config.roles.scavengeFortificationFloor && b.zombiesInside === 0;
}

/** Room for one person to go out with someone left behind. */
function canSpare(world: World, b: Building): boolean {
  return b.residents + b.sheltered.length >= 1 + world.config.roles.minStayBehind;
}

/** A sheltered sim re-evaluates its shelter and its role. Staggered by id; called from sim decisions. */
export function evaluateRole(world: World, ctx: Context, sim: Sim): void {
  const { config, tick, buildings } = world;
  const rc = config.roles;
  const b = buildings[sim.insideBuilding!]!;
  const calm = modeOf(sim, config) === 'informed';
  if (!calm || b.zombiesInside > 0) {
    if (sim.role !== 'builder' || b.materials === 0) sim.role = null;
    return;
  }

  const door = doorThreat(world, ctx, b);

  // Migration: a better shelter it has heard of, past the hysteresis, off cooldown.
  const mg = config.migration;
  if (sim.lastMigratedAt === null || tick - sim.lastMigratedAt >= mg.cooldown) {
    const here = desirability(world, sim, b, undefined, 0);
    let best: Building | null = null;
    let bestScore = -Infinity;
    for (const [bid, belief] of [...sim.buildingMemory.entries()].sort((x, y) => x[0] - y[0])) {
      if (bid === b.id || bid === sim.refusedBy) continue;
      const other = buildings[bid]!;
      const e = entranceNearest(other, sim.x, sim.y);
      const score = desirability(world, sim, other, belief, Math.hypot(e.x - sim.x, e.y - sim.y));
      if (score > bestScore) {
        bestScore = score;
        best = other;
      }
    }
    const required = mg.baseDelta + mg.fortificationWeight * b.fortification + mg.cautionWeight * sim.caution;
    if (best !== null && bestScore - here > required && door < rc.scavengeMaxDoorThreat) {
      sim.lastMigratedAt = tick;
      sim.shelter = null;
      sim.role = null;
      sim.roleSince = tick;
      setDestination(sim, best, 'shelter');
      goOut(world, sim, b);
      return;
    }
  }

  if (sim.role !== null && tick - sim.roleSince < rc.minTenure) return;

  const arch = config.archetypes[sim.archetype];
  if (arch.engageThreshold > 0 && capacity(world, sim) > 0 && door > 0 && door < arch.engageThreshold) {
    sim.role = 'dispatcher';
    sim.roleSince = tick;
    sim.destinationKind = null;
    sim.destinationBuilding = null;
    sim.destination = null;
    goOut(world, sim, b);
    sim.sortieUntil = sim.exitingUntil! + rc.sortieTicks;
    return;
  }

  if (needsMaterials(world, b) && door < rc.scavengeMaxDoorThreat && canSpare(world, b) && !scavengerOut(world, b) && leastUseful(world, b) === sim) {
    const target = pickScavengeTarget(world, sim, null);
    if (target !== null) {
      startScavenging(world, sim, b, target);
      return;
    }
  }

  const role = b.materials > 0 && b.fortification < 1 ? 'builder' : null;
  if (role !== sim.role) {
    sim.role = role;
    sim.roleSince = tick;
  }
}

// Building side (step 10)

/** Somebody inside now knows. */
export function alert(world: World, b: Building): void {
  b.alertedAt ??= world.tick;
  // Everyone inside hears it, so everyone inside knows there is an outbreak.
  for (const id of b.sheltered) world.sims[id]!.awareAt ??= world.tick;
}

/**
 * The buildings a resident of `b` knows, nearest first. Recomputed on each call: it
 * runs only when a resident is about to step out, and caching it (lazily or at map
 * build) measured no faster over a whole run (scripts/bench.ts).
 */
function neighbourhood(world: World, ctx: Context, b: Building): BuildingId[] {
  const e = b.entrances[0]!;
  const dist = (id: BuildingId) => {
    const o = world.buildings[id]!.entrances[0]!;
    return Math.hypot(o.x - e.x, o.y - e.y);
  };
  const near = ctx.map
    .buildingsNear(e.x, e.y, world.config.roles.residentKnowledgeRadius, ctx.buildingIds)
    .filter((id) => id !== b.id)
    .map((id) => ({ id, d: dist(id) }))
    .sort((p, q) => p.d - q.d || p.id - q.id)
    .map((x) => x.id);
  return near;
}

/** A resident steps out for materials and becomes tracked, knowing the neighbourhood. */
function sendResident(world: World, ctx: Context, b: Building, queued: number): void {
  const { config, tick } = world;
  if (b.residents - queued < 1) return;
  const e = b.entrances[0]!;
  const seed = neighbourhood(world, ctx, b).slice(0, config.memory.buildingCap);
  if (!seed.some((id) => world.buildings[id]!.materials > 0)) return;

  b.residents--;
  const sim = spawnSim(world, { x: e.x, y: e.y, insideBuilding: b.id, sourceTag: b.tag, from: b.id, initialPanic: 0, destinationKind: null, aware: true });
  b.sheltered.push(sim.id);
  sim.shelter = b.id;
  sim.gait = 'still';
  sim.history.buildingsEntered = 1;
  const note = (o: Building, visited: boolean) =>
    remember(sim.buildingMemory, o.id, { believedOccupants: visibleFill(o), materials: o.materials, fortification: o.fortification, observedAt: tick, visited }, config.memory.buildingCap);
  note(b, true);
  for (const id of seed) note(world.buildings[id]!, false);
  const target = pickScavengeTarget(world, sim, null);
  if (target !== null) startScavenging(world, sim, b, target);
}

/** Fortification work and decay, alerting, resident scavengers, garrisons and the cascade. */
/** Unattended fortification decays toward nothing; below the floor it is gone. */
function decay(b: Building, bc: World['config']['buildings']): void {
  if (b.fortification === 0) return;
  b.fortification -= b.fortification * bc.fortificationDecay;
  if (b.fortification < bc.fortificationFloor) b.fortification = 0;
}

export function shelterWork(world: World, ctx: Context, b: Building, queued: number): void {
  const { config, tick } = world;
  const rc = config.roles;
  const living = b.residents + b.sheltered.length;
  const onCycle = b.id % rc.interval === tick % rc.interval;
  const bc = config.buildings;

  // Empty: whoever knew has gone, so the building forgets; a garrison ends (falls, if
  // occupiers are why); barricades left behind decay unattended.
  if (living === 0) {
    b.alertedAt = null;
    if (b.garrisonedAt !== null) {
      if (b.zombiesInside > 0) ctx.events.push({ type: 'shelterFell', tick, building: b.id, sim: null });
      b.garrisonedAt = null;
      b.cascadeAt = null;
    }
    decay(b, bc);
    return;
  }
  // Unaware buildings only watch the door: only alerted ones fortify, send anyone out
  // or become garrisons. Barricades an earlier household left still decay, since
  // nobody here is working on them.
  if (b.alertedAt === null) {
    decay(b, bc);
    if (onCycle && doorThreat(world, ctx, b) > 0) alert(world, b);
    return;
  }

  // Work: tracked builders plus a few residents, while there are materials.
  let crew = 0;
  if (b.zombiesInside === 0) {
    for (const id of b.sheltered) if (world.sims[id]!.role === 'builder') crew++;
    crew += Math.min(Math.max(0, b.residents - queued), bc.residentBuilders);
  }
  if (crew > 0 && b.materials > 0) {
    b.fortification += (1 - b.fortification) * Math.min(1, bc.fortifyRate * crew);
    if ((tick + b.id) % bc.fortifyMaterialTicks === 0) b.materials = Math.max(0, b.materials - crew);
    if (b.breached) b.breached = false;
  } else {
    decay(b, bc);
  }

  // A resident goes out when the building needs materials and nobody tracked is going.
  if (onCycle && needsMaterials(world, b) && canSpare(world, b) && !scavengerOut(world, b)) {
    const candidate = leastUseful(world, b);
    const trackedCanGo = candidate !== null && pickScavengeTarget(world, candidate, null) !== null;
    if (!trackedCanGo && doorThreat(world, ctx, b) < rc.scavengeMaxDoorThreat) sendResident(world, ctx, b, queued);
  }

  // Garrisons form and fall. A garrison is held by the people who live here — residents
  // and tracked sims who have made it home — not by whoever is passing through: three
  // scavengers from three households raiding the same house hold nothing.
  const sc = config.shelter;
  let holders = b.residents;
  for (const id of b.sheltered) if (world.sims[id]!.shelter === b.id) holders++;
  if (b.garrisonedAt === null) {
    if (b.zombiesInside === 0 && holders >= sc.garrisonMin && b.fortification >= sc.garrisonFortification) {
      b.garrisonedAt = tick;
      ctx.events.push({ type: 'shelterEstablished', tick, building: b.id, sim: null });
    }
  } else if (b.zombiesInside > 0) {
    ctx.events.push({ type: 'shelterFell', tick, building: b.id, sim: null });
    b.garrisonedAt = null;
    b.cascadeAt = null;
  } else if (holders === 0) {
    b.garrisonedAt = null; // everyone who held it has gone; visitors do not keep it
    b.cascadeAt = null;
  } else if (b.id % sc.cascadeInterval === tick % sc.cascadeInterval) {
    cascadeWatch(world, ctx, b);
  }
}

/**
 * Above cascade density the crowd outside a garrison becomes self-sustaining:
 * its members stay awake and are drawn to each other rather than to whatever
 * first brought them. Below it, a returning survivor is a near miss.
 */
function cascadeWatch(world: World, ctx: Context, b: Building): void {
  const { config, tick, zombies } = world;
  const zc = config.zombie;
  const crowd: number[] = [];
  for (const e of b.entrances) {
    ctx.zombieHash.query(e.x, e.y, zc.cascadeRadius, ctx.ids2);
    for (const zid of ctx.ids2) {
      const z = zombies[zid]!;
      if (z.state !== 'active' && z.state !== 'wandering') continue;
      if (Math.hypot(z.x - e.x, z.y - e.y) > zc.cascadeRadius || crowd.includes(zid)) continue;
      crowd.push(zid);
    }
  }
  crowd.sort((p, q) => p - q);
  if (crowd.length < zc.cascadeCount) {
    b.cascadeAt = null;
    return;
  }
  if (b.cascadeAt === null) {
    b.cascadeAt = tick;
    ctx.events.push({ type: 'cascadeCrossed', tick, building: b.id, sim: null });
  }
  let cx = 0;
  let cy = 0;
  for (const zid of crowd) {
    cx += zombies[zid]!.x;
    cy += zombies[zid]!.y;
  }
  cx /= crowd.length;
  cy /= crowd.length;
  for (const zid of crowd) {
    const z = zombies[zid]!;
    z.state = 'active';
    z.stateUntil = null;
    z.heardAt = tick;
    if (z.target === null) {
      if (z.heardPoint === null) z.heardPoint = { x: cx, y: cy };
      else {
        z.heardPoint.x = cx;
        z.heardPoint.y = cy;
      }
    }
  }
}
