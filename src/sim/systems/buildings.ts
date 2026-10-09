// Tick step 10: building processes. Arrivals and admission, exits and expulsion,
// release and breach queues, breach rolls, contests inside occupations, occupier
// spill, and the shelter economy's building side (shelter.ts). One of three files
// allowed to read `panic` (expulsion of tracked sims).

import { breachChance } from '../breach';
import type { Context } from '../context';
import { transfer, simLeaf } from '../counters';
import { functionalProfile } from '../mapgen/generate';
import { remember } from '../memory';
import { chance, nextInt } from '../rng';
import { spawnSim, spawnZombie } from '../spawn';
import type { Building, Sim, World } from '../state';
import { bite, destroyZombie, killSim } from './combat';
import { capacity, entranceNearest, exitTicks, isLiving } from './common';
import { merge } from './encounters';
import { modeOf } from './panic';
import { updateRelease } from './release';
import { dispatchCalls, placeCall } from './dispatch';
import { alert, deliver, scavenge, shelterWork, visibleFill } from './shelter';
import { emitStimulus } from './stimuli';

const OUTSIDE = 1.5; // m beyond the outline where people and zombies reappear

/** A point just outside one of a building's entrances. */
function outsideOf(ctx: Context, b: Building, e: { x: number; y: number }): { x: number; y: number } {
  return ctx.map.outside(b.id, Math.max(0, b.entrances.indexOf(e)), OUTSIDE);
}

function queued(b: Building): number {
  return b.pendingRelease + b.pendingExpel + b.pendingTurn + b.pendingDie;
}

function removeSheltered(b: Building, sim: Sim): void {
  b.sheltered = b.sheltered.filter((id) => id !== sim.id);
}

function leave(world: World, ctx: Context, sim: Sim, b: Building): void {
  const from = simLeaf(sim);
  removeSheltered(b, sim);
  const p = outsideOf(ctx, b, entranceNearest(b, sim.x, sim.y));
  sim.x = p.x;
  sim.y = p.y;
  sim.insideBuilding = null;
  sim.exitingUntil = null;
  sim.idleUntil = null;
  if (sim.destinationKind === 'routine') {
    sim.destinationBuilding = null;
    sim.destination = null;
  }
  sim.route = [];
  const to = simLeaf(sim);
  if (from !== null && to !== null && from !== to) transfer(world, from, to);
}

/** Leaves frightened. A shelter that has fallen is no longer home. */
function expel(world: World, ctx: Context, sim: Sim, b: Building): void {
  const fell = b.zombiesInside > 0;
  leave(world, ctx, sim, b);
  sim.panic = Math.max(sim.panic, world.config.behaviour.expelledPanic);
  sim.destinationKind = 'shelter';
  sim.destinationBuilding = null;
  sim.destination = null;
  sim.role = null;
  sim.sortieUntil = null;
  if (fell) {
    if (sim.shelter === b.id) sim.shelter = null;
    sim.refusedBy = b.id;
  }
}

/** Whether a sim inside an occupation judges the odds acceptable. Archetype sets the ratio. */
function acceptable(world: World, sim: Sim, b: Building): boolean {
  const ratio = world.config.archetypes[sim.archetype].contestRatio;
  const cap = capacity(world, sim);
  return ratio !== null && cap > 0 && cap >= b.zombiesInside * ratio;
}

/** One occupier attack on a sim inside, with the usual outcome table. */
function occupierStrike(world: World, ctx: Context, b: Building, sim: Sim): void {
  const { config } = world;
  if (!chance(world.rng, config.combat.zombieAttack.baseInfection)) {
    sim.history.nearMisses++;
    return;
  }
  const table = config.combat.releasedChanceByContact;
  if (chance(world.rng, table[Math.min(b.zombiesInside, table.length) - 1]!)) {
    bite(world, ctx, sim);
  } else {
    killSim(world, ctx, sim, 'fedOn');
    removeSheltered(b, sim);
  }
}

/**
 * A zombie is now inside (a breach, or someone turning indoors). Remaining
 * residents are queued to turn, die or flee. Tracked sims who like the odds stay
 * and contest; the rest start for the door, which takes as long as the
 * barricades they built make it take.
 */
export function occupierAppeared(world: World, ctx: Context, b: Building): void {
  const { config, tick } = world;
  b.breached = true;
  b.occupiedAt ??= tick;
  alert(world, b);
  const available = b.residents - queued(b);
  if (available > 0) {
    const split = config.buildings.breach.split;
    const turn = Math.round(available * split.turn);
    const die = Math.min(available - turn, Math.round(available * split.die));
    b.pendingTurn += turn;
    b.pendingDie += die;
    b.pendingExpel += available - turn - die;
  }
  for (const id of [...b.sheltered].sort((p, q) => p - q)) {
    const sim = world.sims[id]!;
    if (!isLiving(sim) || sim.exitingUntil !== null) continue;
    if (modeOf(sim, config) === 'flight' || acceptable(world, sim, b)) {
      ctx.events.push({ type: 'occupationContested', tick, building: b.id, sim: sim.id });
    } else {
      sim.exitingUntil = tick + exitTicks(world, b);
    }
  }
  ctx.events.push({ type: 'buildingBreached', tick, building: b.id, sim: null });
}

function turnAway(world: World, sim: Sim, b: Building): void {
  sim.refusedBy = b.id;
  if (sim.shelter === b.id) sim.shelter = null;
  sim.destinationBuilding = null;
  sim.destination = null;
  sim.route = [];
  sim.nextRepathAt = world.tick + world.config.pathfinding.repathCooldown;
}

function tryEnter(world: World, ctx: Context, sim: Sim, b: Building): void {
  const { config, tick } = world;
  let contesting = false;
  if (b.zombiesInside > 0) {
    // Entry commits: the occupiers are discovered at the door. A panicked sim
    // entered blind and fights on reflex; others fight only if the odds suit them.
    if (modeOf(sim, config) === 'flight' || acceptable(world, sim, b)) {
      contesting = true;
      ctx.events.push({ type: 'occupationContested', tick, building: b.id, sim: sim.id });
    } else {
      b.pendingSpill = Math.max(b.pendingSpill, b.zombiesInside);
      occupierStrike(world, ctx, b, sim);
      remember(sim.streetMemory, b.street, { danger: 1, observedAt: tick, visited: sim.streetMemory.get(b.street)?.visited ?? false }, config.memory.streetCap);
      turnAway(world, sim, b);
      return;
    }
  } else if (b.sheltered.some((id) => world.sims[id]!.knownInfected.has(sim.id))) {
    turnAway(world, sim, b);
    return;
  }
  const from = simLeaf(sim);
  sim.insideBuilding = b.id;
  sim.street = null;
  if (b.alertedAt !== null) sim.awareAt ??= tick; // the house knows, and says so
  const e = entranceNearest(b, sim.x, sim.y);
  sim.x = e.x;
  sim.y = e.y;
  if (!contesting) {
    // Reaching a door ends the flight. Without this, someone who ran in panicked would
    // be expelled by that same panic on the next tick and bounce in and out of the door.
    sim.panic = Math.min(sim.panic, config.panic.expelThreshold - 0.01);
  }
  // News travels indoors too: whoever is already inside hears what the newcomer knows.
  for (const id of b.sheltered) {
    const other = world.sims[id]!;
    if (isLiving(other)) merge(world, sim, other);
  }
  b.sheltered.push(sim.id);
  sim.route = [];
  sim.gait = 'still';
  const belief = sim.buildingMemory.get(b.id);
  if (!belief?.visited) sim.history.buildingsEntered++;
  remember(
    sim.buildingMemory,
    b.id,
    { believedOccupants: visibleFill(b), materials: b.materials, fortification: b.fortification, observedAt: tick, visited: true },
    config.memory.buildingCap,
  );
  const to = simLeaf(sim);
  if (from !== null && to !== null && from !== to) transfer(world, from, to);
  if (!contesting) placeCall(world, sim, b);

  if (sim.destinationKind === 'routine') {
    sim.idleUntil = tick + nextInt(world.rng, config.routine.idleTicks[0]!, config.routine.idleTicks[1]!);
  } else if (sim.destinationKind === 'scavenge' && !contesting) {
    scavenge(world, ctx, sim, b);
  } else if (sim.destinationKind === 'isolate') {
    // Alone, to wait for it: no shelter taken, nobody told.
  } else {
    // Seeking shelter (or coming home): this is home now. A frightened arrival tells the house.
    sim.shelter = b.id;
    sim.destinationKind = 'shelter';
    alert(world, b);
    deliver(world, ctx, sim, b);
  }
}

function arrivals(world: World, ctx: Context): void {
  const radius = world.config.behaviour.arrivalRadius;
  const count = world.sims.length;
  for (let i = 0; i < count; i++) {
    const sim = world.sims[i]!;
    if (!isLiving(sim) || sim.insideBuilding !== null) continue;
    if (sim.destinationBuilding === null || sim.destination === null) continue;
    // The destination is the entrance chosen when the building was.
    if (Math.hypot(sim.destination.x - sim.x, sim.destination.y - sim.y) > radius) continue;
    tryEnter(world, ctx, sim, world.buildings[sim.destinationBuilding]!);
  }
}

/**
 * Leaving takes the exit time fortification sets, panicked or not: barricades cut
 * both ways. Walking out past occupiers costs one contact roll.
 */
function exits(world: World, ctx: Context): void {
  const { tick, config } = world;
  const count = world.sims.length;
  for (let i = 0; i < count; i++) {
    const sim = world.sims[i]!;
    if (sim.insideBuilding === null || !isLiving(sim)) continue;
    const b = world.buildings[sim.insideBuilding]!;
    const panicked = sim.panic > config.panic.expelThreshold;
    if (panicked && sim.exitingUntil === null) sim.exitingUntil = tick + exitTicks(world, b);
    if (sim.exitingUntil === null || tick < sim.exitingUntil) continue;
    if (b.zombiesInside > 0) {
      occupierStrike(world, ctx, b, sim);
      if (isLiving(sim)) expel(world, ctx, sim, b);
    } else if (panicked) {
      expel(world, ctx, sim, b);
    } else {
      leave(world, ctx, sim, b);
    }
  }
}

/**
 * Noise this tick near a building tells the people inside; gunfire also drives a
 * share of its residents out. A shouted warning alerts them, but nobody runs out
 * into the street toward it.
 */
function noiseExpulsion(world: World, ctx: Context): void {
  const { config, tick } = world;
  const r = config.buildings.spill.alertRadius;
  const heard = new Map<number, boolean>(); // building → heard gunfire
  for (const s of world.stimuli) {
    if (s.createdAt !== tick) continue;
    // (A building's own defence alerts it, but does not drive its own people out.)
    for (const bid of ctx.map.buildingsNear(s.x, s.y, r, ctx.buildingIds)) heard.set(bid, (heard.get(bid) ?? false) || (s.kind !== 'shout' && s.from !== bid));
  }
  for (const bid of [...heard.keys()].sort((a, b) => a - b)) {
    const b = world.buildings[bid]!;
    if (b.residents + b.sheltered.length > 0) alert(world, b);
    if (!heard.get(bid)) continue;
    const available = b.residents - queued(b);
    if (available > 0) b.pendingExpel += Math.floor(available * config.buildings.residentExpelShare);
  }
}

/**
 * Buildings on this tick's breach cycle with living inside and no occupiers: the only
 * ones a breach roll can concern. Each checks its own entrances (breachRolls), which
 * is a tenth of the buildings rather than a lookup per awake zombie.
 */
function breachCandidates(world: World): number[] {
  const { buildings, tick } = world;
  const interval = world.config.buildings.breach.interval;
  const found: number[] = [];
  for (let id = tick % interval; id < buildings.length; id += interval) {
    const b = buildings[id]!;
    if (b.zombiesInside === 0 && b.residents + b.sheltered.length > 0) found.push(id);
  }
  return found;
}

function breachRolls(world: World, ctx: Context, b: Building): void {
  const { config, tick, zombies } = world;
  const br = config.buildings.breach;
  if (b.id % br.interval !== tick % br.interval) return;
  if (b.zombiesInside > 0 || b.residents + b.sheltered.length === 0) return;
  const integrity = config.tags[functionalProfile(b.tag, config)].integrity;
  const p = breachChance(integrity, b.fortification, config);
  const seen = new Set<number>();
  const rollers: number[] = [];
  for (const e of b.entrances) {
    ctx.zombieHash.query(e.x, e.y, br.entranceRadius + 3, ctx.ids2);
    for (const zid of ctx.ids2) {
      const z = zombies[zid]!;
      if ((z.state !== 'active' && z.state !== 'wandering') || seen.has(zid)) continue;
      if (Math.hypot(z.x - e.x, z.y - e.y) > br.entranceRadius) continue;
      seen.add(zid);
      rollers.push(zid);
    }
  }
  rollers.sort((a, c) => a - c);
  for (const zid of rollers.slice(0, br.maxRolls)) {
    if (!chance(world.rng, p)) continue;
    const z = zombies[zid]!;
    z.state = 'occupying';
    z.insideBuilding = b.id;
    z.target = null;
    z.heardPoint = null;
    b.zombiesInside++;
    transfer(world, 'turned.outdoors', 'turned.occupying');
    occupierAppeared(world, ctx, b);
    return;
  }
}

function drainQueues(world: World, ctx: Context, b: Building): void {
  if (b.pendingTurn + b.pendingDie + b.pendingExpel + b.pendingRelease === 0) return;
  const { config, tick } = world;
  const bc = config.buildings;
  let k = 0;
  const door = () => outsideOf(ctx, b, b.entrances[k++ % b.entrances.length]!);
  const centre = { x: (ctx.map.bMinX[b.id]! + ctx.map.bMaxX[b.id]!) / 2, y: (ctx.map.bMinY[b.id]! + ctx.map.bMaxY[b.id]!) / 2 };

  let resolve = bc.breach.resolvePerTick;
  while (resolve > 0 && (b.pendingTurn > 0 || b.pendingDie > 0)) {
    resolve--;
    b.residents--;
    if (b.pendingTurn >= b.pendingDie && b.pendingTurn > 0) {
      b.pendingTurn--;
      const z = spawnZombie(world, centre.x, centre.y, 'occupying', b.id, null);
      b.zombiesInside++;
      b.occupiedAt ??= tick;
      transfer(world, 'unturned.indoors', 'turned.occupying');
      world.lastConversionAt = tick;
      ctx.events.push({ type: 'simTurned', tick, sim: null, zombie: z.id, x: centre.x, y: centre.y });
    } else {
      b.pendingDie--;
      world.residentDeaths++;
      transfer(world, 'unturned.indoors', 'unturned.dead');
      ctx.events.push({ type: 'simDied', tick, sim: null, cause: 'breach', x: centre.x, y: centre.y });
    }
  }

  for (let n = 0; n < bc.expelPerTick && b.pendingExpel > 0; n++) {
    b.pendingExpel--;
    b.residents--;
    const p = door();
    spawnSim(world, { ...p, insideBuilding: null, sourceTag: b.tag, from: b.id, initialPanic: config.behaviour.expelledPanic, destinationKind: 'shelter', aware: true });
    transfer(world, 'unturned.indoors', 'unturned.outdoors');
  }

  for (let n = 0; n < config.release.perBuildingPerTick && b.pendingRelease > 0; n++) {
    b.pendingRelease--;
    b.residents--;
    const p = door();
    spawnSim(world, { ...p, insideBuilding: null, sourceTag: b.tag, from: b.id, initialPanic: 0, destinationKind: 'routine' });
    transfer(world, 'unturned.indoors', 'unturned.outdoors');
  }
}

/** The first occupier record inside a building (lowest id). */
function occupier(world: World, b: Building) {
  return world.zombies.find((o) => o.state === 'occupying' && o.insideBuilding === b.id) ?? null;
}

/**
 * Sims inside an occupation fight it under the ordinary weapon rules, against the
 * occupiers as a count; the occupiers strike back on their own cooldown. Gunfire is
 * muffled by the walls but still heard. Clearing the last occupier takes the building.
 */
function contest(world: World, ctx: Context, b: Building): void {
  const { config, tick } = world;
  const cc = config.combat;
  const door = b.entrances[0]!;
  const inside = [...b.sheltered].sort((p, q) => p - q);
  let lastKiller: Sim | null = null;

  for (const id of inside) {
    if (b.zombiesInside === 0) break;
    const sim = world.sims[id]!;
    if (!isLiving(sim) || sim.insideBuilding !== b.id || sim.exitingUntil !== null) continue;
    if (modeOf(sim, config) !== 'flight' && !acceptable(world, sim, b)) {
      sim.exitingUntil = tick + exitTicks(world, b); // the odds turned: withdraw
      continue;
    }
    if (tick < sim.nextAttackAt) continue;

    const w = sim.weapon;
    const ranged = w === 'pistol' || w === 'smg' || w === 'shotgun' ? cc.ranged[w] : null;
    let shots = 1;
    let p: number;
    if (ranged !== null && sim.ammo >= ranged.ammoPerAttack) {
      p = ranged.baseKill * (1 - (cc.rangedFalloff * cc.contactRange) / ranged.range);
      shots = ranged.targets;
      sim.ammo -= ranged.ammoPerAttack;
      sim.nextAttackAt = tick + ranged.cooldown;
      emitStimulus(world, door.x, door.y, w!, ranged.noise, true);
    } else {
      const melee = w === 'knife' || w === 'club' || w === 'sledgehammer' ? cc.melee[w] : cc.melee.unarmed;
      p = melee.baseKill;
      sim.nextAttackAt = tick + melee.cooldown;
      if (w !== null && melee.noise > 0) emitStimulus(world, door.x, door.y, w, melee.noise, true);
      if (!chance(world.rng, p)) {
        if (chance(world.rng, melee.infectionOnMiss)) bite(world, ctx, sim);
        continue;
      }
      p = 1;
    }
    for (let n = 0; n < shots && b.zombiesInside > 0; n++) {
      if (!chance(world.rng, p)) continue;
      const z = occupier(world, b)!;
      destroyZombie(world, z, sim);
      b.zombiesInside--;
      lastKiller = sim;
      ctx.events.push({ type: 'zombieDestroyed', tick, zombie: z.id, by: sim.id, x: door.x, y: door.y });
    }
  }

  if (b.zombiesInside > 0 && (tick + b.id) % cc.zombieAttack.cooldown === 0) {
    for (const id of inside) {
      const sim = world.sims[id]!;
      if (isLiving(sim) && sim.insideBuilding === b.id) occupierStrike(world, ctx, b, sim);
    }
  }

  if (b.zombiesInside === 0) {
    b.occupiedAt = null;
    b.pendingSpill = 0;
    ctx.events.push({ type: 'buildingRetaken', tick, building: b.id, sim: lastKiller?.id ?? null });
  }
}

function spill(world: World, ctx: Context, b: Building): void {
  const { config, tick } = world;
  const sp = config.buildings.spill;
  if (b.zombiesInside === 0) return;

  if (b.pendingSpill === 0 && b.id % sp.interval === tick % sp.interval) {
    const e = b.entrances[0]!;
    const alerted = world.stimuli.some((s) => tick - s.createdAt < sp.interval && Math.hypot(s.x - e.x, s.y - e.y) <= sp.alertRadius);
    ctx.zombieHash.query(e.x, e.y, sp.densityRadius, ctx.ids2);
    if (alerted || ctx.ids2.length < sp.densityThreshold) b.pendingSpill = b.zombiesInside;
  }

  for (let n = 0; n < sp.perTick && b.pendingSpill > 0 && b.zombiesInside > 0; n++) {
    const z = occupier(world, b);
    if (!z) break;
    const p = outsideOf(ctx, b, b.entrances[n % b.entrances.length]!);
    z.state = 'active';
    z.insideBuilding = null;
    z.x = p.x;
    z.y = p.y;
    z.heardAt = tick;
    b.zombiesInside--;
    b.pendingSpill--;
    transfer(world, 'turned.occupying', 'turned.outdoors');
  }
  if (b.zombiesInside === 0) {
    b.occupiedAt = null;
    b.pendingSpill = 0;
  }
}

/** `probe` marks sub-stage boundaries for a profiler; the simulation never reads a clock. */
export function buildingProcesses(world: World, ctx: Context, probe: (stage: string) => void = () => {}): void {
  updateRelease(world);
  arrivals(world, ctx);
  probe('buildings.arrivals');
  exits(world, ctx);
  probe('buildings.exits');
  noiseExpulsion(world, ctx);
  probe('buildings.noise');
  dispatchCalls(world, ctx);
  for (const bid of breachCandidates(world)) breachRolls(world, ctx, world.buildings[bid]!);
  probe('buildings.breach');
  for (const b of world.buildings) {
    if (queued(b) > 0) drainQueues(world, ctx, b);
    if (b.zombiesInside > 0) {
      // Occupiers engaged with someone inside stay put; otherwise they may spill.
      if (b.sheltered.length > 0) contest(world, ctx, b);
      else spill(world, ctx, b);
    }
    shelterWork(world, ctx, b, queued(b));
  }
}
