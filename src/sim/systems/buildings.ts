// Tick step 10: building processes. Arrivals and admission, exits and expulsion,
// release and breach queues, breach rolls, and occupier spill. One of three files
// allowed to read `panic` (expulsion of tracked sims).
//
// Milestone 2 scope: no fortification work, materials or roles (milestone 4), and
// no contest inside an occupied building — a sim who walks into one meets the
// occupiers at the door, takes one contact roll, and is turned away while the
// occupation spills onto the street.

import { breachChance } from '../breach';
import type { Context } from '../context';
import { transfer, simLeaf } from '../counters';
import { functionalProfile } from '../mapgen/generate';
import { remember } from '../memory';
import { chance, nextInt } from '../rng';
import { spawnSim, spawnZombie } from '../spawn';
import type { Building, Sim, World } from '../state';
import { bite } from './combat';
import { updateRelease } from './release';
import { entranceNearest } from './sims';

const OUTSIDE = 1.5; // m beyond the outline where people and zombies reappear

/** A point just outside one of a building's entrances. */
function outsideOf(ctx: Context, b: Building, e: { x: number; y: number }): { x: number; y: number } {
  return ctx.map.outside(b.id, Math.max(0, b.entrances.indexOf(e)), OUTSIDE);
}

function queued(b: Building): number {
  return b.pendingRelease + b.pendingExpel + b.pendingTurn + b.pendingDie;
}

function leave(world: World, ctx: Context, sim: Sim, b: Building): void {
  const from = simLeaf(sim);
  b.sheltered = b.sheltered.filter((id) => id !== sim.id);
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

/** Expels a tracked sim at once, frightened. */
function expel(world: World, ctx: Context, sim: Sim, b: Building): void {
  leave(world, ctx, sim, b);
  sim.panic = Math.max(sim.panic, world.config.behaviour.expelledPanic);
  sim.destinationKind = 'shelter';
  sim.destinationBuilding = null;
  sim.destination = null;
}

/**
 * A zombie is now inside (a breach, or someone turning indoors). Remaining
 * residents are queued to turn, die or flee; tracked sims inside take one contact
 * roll each and are driven out.
 */
export function occupierAppeared(world: World, ctx: Context, b: Building): void {
  const { config, tick } = world;
  b.breached = true;
  b.occupiedAt ??= tick;
  const available = b.residents - queued(b);
  if (available > 0) {
    const split = config.buildings.breach.split;
    const turn = Math.round(available * split.turn);
    const die = Math.min(available - turn, Math.round(available * split.die));
    b.pendingTurn += turn;
    b.pendingDie += die;
    b.pendingExpel += available - turn - die;
  }
  for (const id of [...b.sheltered]) {
    const sim = world.sims[id]!;
    if (chance(world.rng, config.combat.zombieAttack.baseInfection)) bite(world, ctx, sim);
    expel(world, ctx, sim, b);
  }
  ctx.events.push({ type: 'buildingBreached', tick, building: b.id, sim: null });
}

function tryEnter(world: World, ctx: Context, sim: Sim, b: Building): void {
  const { config, tick } = world;
  if (b.zombiesInside > 0) {
    // Entry commits: the occupiers are discovered at the door.
    b.pendingSpill = Math.max(b.pendingSpill, b.zombiesInside);
    if (chance(world.rng, config.combat.zombieAttack.baseInfection)) bite(world, ctx, sim);
    remember(sim.streetMemory, b.street, { danger: 1, observedAt: tick, visited: sim.streetMemory.get(b.street)?.visited ?? false }, config.memory.streetCap);
    sim.refusedBy = b.id;
    sim.destinationBuilding = null;
    sim.destination = null;
    sim.route = [];
    return;
  }
  if (b.sheltered.some((id) => world.sims[id]!.knownInfected.has(sim.id))) {
    sim.refusedBy = b.id;
    sim.destinationBuilding = null;
    sim.destination = null;
    sim.route = [];
    sim.nextRepathAt = tick + config.pathfinding.repathCooldown;
    return;
  }
  const from = simLeaf(sim);
  sim.insideBuilding = b.id;
  sim.street = null;
  const e = entranceNearest(b, sim.x, sim.y);
  sim.x = e.x;
  sim.y = e.y;
  b.sheltered.push(sim.id);
  sim.route = [];
  sim.gait = 'still';
  // Reaching a door ends the flight. Without this, someone who ran in panicked would
  // be expelled by that same panic on the next tick and bounce in and out of the door.
  sim.panic = Math.min(sim.panic, config.panic.expelThreshold - 0.01);
  const belief = sim.buildingMemory.get(b.id);
  if (!belief?.visited) sim.history.buildingsEntered++;
  remember(
    sim.buildingMemory,
    b.id,
    { believedOccupants: b.residents + b.sheltered.length + b.zombiesInside, materials: b.materials, fortification: b.fortification, observedAt: tick, visited: true },
    config.memory.buildingCap,
  );
  if (sim.destinationKind === 'routine') {
    sim.idleUntil = tick + nextInt(world.rng, config.routine.idleTicks[0]!, config.routine.idleTicks[1]!);
  } else {
    sim.shelter = b.id;
  }
  const to = simLeaf(sim);
  if (from !== null && to !== null && from !== to) transfer(world, from, to);
}

function arrivals(world: World, ctx: Context): void {
  const radius = world.config.behaviour.arrivalRadius;
  const count = world.sims.length;
  for (let i = 0; i < count; i++) {
    const sim = world.sims[i]!;
    if ((sim.condition !== 'healthy' && sim.condition !== 'infected') || sim.insideBuilding !== null) continue;
    if (sim.destinationBuilding === null || sim.destination === null) continue;
    // The destination is the entrance chosen when the building was.
    if (Math.hypot(sim.destination.x - sim.x, sim.destination.y - sim.y) > radius) continue;
    tryEnter(world, ctx, sim, world.buildings[sim.destinationBuilding]!);
  }
}

function exits(world: World, ctx: Context): void {
  const { tick, config } = world;
  const count = world.sims.length;
  for (let i = 0; i < count; i++) {
    const sim = world.sims[i]!;
    if (sim.insideBuilding === null || (sim.condition !== 'healthy' && sim.condition !== 'infected')) continue;
    const b = world.buildings[sim.insideBuilding]!;
    if (sim.panic > config.panic.expelThreshold) expel(world, ctx, sim, b);
    else if (sim.exitingUntil !== null && tick >= sim.exitingUntil) leave(world, ctx, sim, b);
  }
}

/** Gunfire this tick near a building drives a share of its residents out. */
function noiseExpulsion(world: World, ctx: Context): void {
  const { config, tick } = world;
  const r = config.buildings.spill.alertRadius;
  const hit = new Set<number>();
  for (const s of world.stimuli) {
    if (s.createdAt !== tick) continue;
    for (const bid of ctx.map.buildingsNear(s.x, s.y, r, ctx.buildingIds)) hit.add(bid);
  }
  for (const bid of [...hit].sort((a, b) => a - b)) {
    const b = world.buildings[bid]!;
    const available = b.residents - queued(b);
    if (available > 0) b.pendingExpel += Math.floor(available * config.buildings.residentExpelShare);
  }
}

/** Buildings with an awake zombie near their footprint: the only ones a breach roll can concern. */
function breachCandidates(world: World, ctx: Context): number[] {
  const { config, tick } = world;
  const br = config.buildings.breach;
  const found = new Set<number>();
  for (const z of world.zombies) {
    if (z.state !== 'active' && z.state !== 'wandering') continue;
    for (const bid of ctx.map.buildingsNear(z.x, z.y, br.entranceRadius, ctx.buildingIds)) {
      if (bid % br.interval === tick % br.interval) found.add(bid);
    }
  }
  return [...found].sort((a, b) => a - b);
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
    spawnSim(world, { ...p, insideBuilding: null, sourceTag: b.tag, initialPanic: config.behaviour.expelledPanic, destinationKind: 'shelter' });
    transfer(world, 'unturned.indoors', 'unturned.outdoors');
  }

  for (let n = 0; n < config.release.perBuildingPerTick && b.pendingRelease > 0; n++) {
    b.pendingRelease--;
    b.residents--;
    const p = door();
    spawnSim(world, { ...p, insideBuilding: null, sourceTag: b.tag, initialPanic: 0, destinationKind: 'routine' });
    transfer(world, 'unturned.indoors', 'unturned.outdoors');
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
    const z = world.zombies.find((o) => o.state === 'occupying' && o.insideBuilding === b.id);
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

export function buildingProcesses(world: World, ctx: Context): void {
  updateRelease(world);
  arrivals(world, ctx);
  exits(world, ctx);
  noiseExpulsion(world, ctx);
  for (const bid of breachCandidates(world, ctx)) breachRolls(world, ctx, world.buildings[bid]!);
  for (const b of world.buildings) {
    if (b.pendingTurn + b.pendingDie + b.pendingExpel + b.pendingRelease > 0) drainQueues(world, ctx, b);
    if (b.zombiesInside > 0) spill(world, ctx, b);
  }
}
