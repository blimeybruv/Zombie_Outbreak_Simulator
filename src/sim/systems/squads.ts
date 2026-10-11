// Reservists and squads: the only way an armed group forms mid-run. Police are placed
// at the start and spent; reservists are the city organising itself after collapse.
//
//   call-up   a reservist is a civilian until something local calls it up: a turning
//             it sees (panic.ts), or a shelter falling within sight (here). Never
//             general awareness: that would call everyone up at once, at release.
//   depot     called up, it makes for its depot — the armoury nearest home — through
//             whatever is in the way (sims.ts decideMuster), draws a weapon if any are
//             left (building entry, armAtDepot) and waits inside
//   squad     `squads.size` waiting at one depot deploy as a squad (formSquads). A squad
//             is no object: each member carries its leader's id and a slot. Only the
//             leader routes; followers steer for their slots (squadPass computes them)
//   targets   the leader claims a 911 call or an occupied building it knows of, and
//             holds it; at an occupied door its members' summed capacity decides
//             whether they go in (buildings.ts acceptable)
//   losses    the leader falls: the lowest surviving id leads. Below two, the squad
//             dissolves; its members stand down, keeping their weapons
//
// Combat, stamina, infection and panic are everyone's, unchanged. Five firearms are
// the loudest thing on the map: squads draw more than they can handle.

import type { Context } from '../context';
import type { Building, BuildingId, Sim, World } from '../state';
import { chance, nextInt } from '../rng';
import { spawnSim } from '../spawn';
import { isFirearm } from '../state';
import { capacity, isLiving, leaveTalk } from './common';
import { intensityAt } from './stimuli';

const armouryCache = new WeakMap<readonly unknown[], BuildingId[]>();

/**
 * Chooses the armouries among the depots: the one nearest the middle of the map, then
 * each next the depot farthest from those already chosen (ties to the lower id), so the
 * call-up is spread across the city. Called once at setup, before anyone spawns.
 */
export function designateArmouries(world: World): void {
  const { config, buildings } = world;
  if (!config.features.reservists) return;
  const depots = buildings.filter((b) => b.tag === 'depot');
  if (depots.length === 0) return;
  let cx = 0, cy = 0;
  for (const b of buildings) {
    cx += b.entrances[0]!.x;
    cy += b.entrances[0]!.y;
  }
  cx /= buildings.length;
  cy /= buildings.length;
  const door = (b: Building) => b.entrances[0]!;
  const chosen: Building[] = [];
  let first = depots[0]!;
  for (const b of depots) if (Math.hypot(door(b).x - cx, door(b).y - cy) < Math.hypot(door(first).x - cx, door(first).y - cy)) first = b;
  chosen.push(first);
  while (chosen.length < Math.min(config.reservists.armouries, depots.length)) {
    let best: Building | null = null;
    let bestD = -1;
    for (const b of depots) {
      if (chosen.includes(b)) continue;
      let d = Infinity;
      for (const c of chosen) d = Math.min(d, Math.hypot(door(b).x - door(c).x, door(b).y - door(c).y));
      if (d > bestD) {
        bestD = d;
        best = b;
      }
    }
    chosen.push(best!);
  }
  for (const b of chosen) b.weaponStock = config.reservists.weaponStock;
}

/** The armoury nearest a point (lower id on a tie), or null on a map without one. */
export function nearestArmoury(world: World, x: number, y: number): BuildingId | null {
  let ids = armouryCache.get(world.buildings);
  if (!ids) {
    ids = world.buildings.filter((b) => b.weaponStock !== null).map((b) => b.id);
    armouryCache.set(world.buildings, ids);
  }
  let best: BuildingId | null = null;
  let bestD = Infinity;
  for (const id of ids) {
    const e = world.buildings[id]!.entrances[0]!;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/** Calls a reservist in reserve up: it drops what it is doing for the depot (sims.ts decideMuster). */
export function mobilise(world: World, sim: Sim): void {
  if (sim.muster !== 'reserve' || sim.depot === null || !isLiving(sim)) return;
  sim.muster = 'mobilised';
  sim.awareAt ??= world.tick;
  if (sim.gathering !== null) leaveTalk(sim, world.tick);
  sim.role = null;
  sim.sortieUntil = null;
  sim.idleUntil = null;
  sim.shelter = null;
  sim.destinationKind = null;
  sim.destinationBuilding = null;
  sim.destination = null;
  sim.route = [];
}

/** A shelter fell: reservists outdoors who could see its door are called up (those inside are, on the way out: buildings.ts expel). */
export function witnessFall(world: World, ctx: Context, b: Building): void {
  const e = b.entrances[0]!;
  ctx.simHash.query(e.x, e.y, world.config.perception.dayRadius.open, ctx.ids2);
  for (const id of ctx.ids2) {
    const s = world.sims[id]!;
    if (s.muster !== 'reserve' || s.insideBuilding !== null) continue;
    if (Math.hypot(e.x - s.x, e.y - s.y) > ctx.radius[id]! || !ctx.map.lineOfSight(s.x, s.y, e.x, e.y)) continue;
    mobilise(world, s);
  }
}

/** A mobilised reservist reaches its depot: a weapon if any are left, then it waits; none left, it stands down and shelters there. */
export function armAtDepot(world: World, sim: Sim, b: Building): void {
  const rc = world.config.reservists;
  sim.destinationKind = null;
  sim.destinationBuilding = null;
  sim.destination = null;
  if (b.weaponStock !== null && b.weaponStock > 0) {
    b.weaponStock--;
    sim.weapon = rc.weapon;
    sim.ammo = rc.ammo;
    sim.muster = 'waiting';
  } else {
    sim.muster = 'stoodDown';
    sim.shelter = b.id;
    sim.destinationKind = 'shelter';
  }
}

/** Squads form at depots: `squads.size` waiting there, in id order, the lowest leading. They wait inside for a target. */
function formSquads(world: World, ctx: Context): void {
  const { config, tick, buildings, sims } = world;
  const size = config.squads.size;
  for (const b of buildings) {
    if (b.weaponStock === null) continue;
    const waiting = b.sheltered.map((id) => sims[id]!).filter((s) => s.muster === 'waiting' && isLiving(s) && s.insideBuilding === b.id).sort((p, q) => p.id - q.id);
    for (let at = 0; at + size <= waiting.length; at += size) {
      const leader = waiting[at]!;
      for (let i = 0; i < size; i++) {
        const m = waiting[at + i]!;
        m.muster = 'deployed';
        m.squadLeader = leader.id;
        m.squadSlot = i;
      }
      leader.trail = [];
      const e = b.entrances[0]!;
      ctx.events.push({ type: 'squadFormed', tick, sim: leader.id, members: size, x: e.x, y: e.y });
    }
  }
}

/** Below two: what is left of the squad stands down, keeping its weapons. */
function dissolve(world: World, ctx: Context, members: Sim[]): void {
  const last = members[0]!;
  ctx.events.push({ type: 'squadDissolved', tick: world.tick, sim: last.id, members: members.length, x: last.x, y: last.y });
  for (const m of members) {
    m.squadLeader = null;
    m.squadSlot = 0;
    m.muster = 'stoodDown';
    m.answering = null;
    m.answeringSince = null;
    m.trail = [];
    m.diamondUntil = null;
    m.offSlotSince = null;
    m.directUntil = null;
    m.destination = null;
    m.destinationBuilding = null;
    m.destinationKind = null;
  }
}

function rangeOf(world: World, s: Sim): number {
  const cc = world.config.combat;
  return isFirearm(s.weapon) ? cc.ranged[s.weapon].range : cc.contactRange;
}

/**
 * Before anyone decides: squads form at depots; each squad's members are found (in id
 * order), a fallen leader replaced by the lowest surviving id, squads of one dissolved;
 * and for each squad its summed capacity, its formation (diamond while any member has a
 * zombie within reach, held diamondHold ticks; file otherwise), its leader's trail, each
 * follower's slot, and whether the leader should wait for a straggler.
 */
export function squadPass(world: World, ctx: Context): void {
  const { config, tick, sims, zombies } = world;
  const sq = config.squads;
  formSquads(world, ctx);
  const groups: Sim[][] = [];
  const order: number[] = [];
  for (const s of sims) {
    if (s.squadLeader === null) continue;
    if (!isLiving(s)) {
      s.squadLeader = null;
      continue;
    }
    const g = (groups[s.squadLeader] ??= []);
    if (g.length === 0) order.push(s.squadLeader);
    g.push(s);
  }
  for (const lid of order) {
    const g = groups[lid]!;
    if (g.length < 2) {
      dissolve(world, ctx, g);
      continue;
    }
    // The leader is always the lowest id: at forming, and by succession.
    const leader = g[0]!;
    if (leader.id !== lid) {
      for (const m of g) m.squadLeader = leader.id;
      leader.trail = [];
    }
    let cap = 0;
    for (let i = 0; i < g.length; i++) {
      g[i]!.squadSlot = i;
      cap += capacity(world, g[i]!);
    }
    ctx.squadCap[leader.id] = cap;
    ctx.squadLag[leader.id] = 0;
    if (leader.insideBuilding !== null) continue;

    // Engaged: any member outdoors with a zombie within reach.
    let engaged = false;
    for (const m of g) {
      const zid = ctx.nearestZombie[m.id]!;
      if (m.insideBuilding !== null || zid < 0) continue;
      const z = zombies[zid]!;
      if (Math.hypot(z.x - m.x, z.y - m.y) <= rangeOf(world, m) * sq.engageRange) engaged = true;
    }
    if (engaged) {
      if (leader.diamondUntil === null) ctx.events.push({ type: 'squadEngaged', tick, sim: leader.id, members: g.length, x: leader.x, y: leader.y });
      leader.diamondUntil = tick + sq.diamondHold;
    } else if (leader.diamondUntil !== null && tick >= leader.diamondUntil) {
      leader.diamondUntil = null;
    }

    // The leader's trail: a point each fileSpacing metres, as many as there are followers.
    const t = leader.trail;
    const last = t[t.length - 1];
    if (last === undefined || Math.hypot(leader.x - last.x, leader.y - last.y) >= sq.fileSpacing) {
      t.push({ x: leader.x, y: leader.y });
      if (t.length > g.length) t.shift();
    }

    // Slots: in the diamond, around the leader, turned toward the danger it sees (or
    // the way it faces); in file, back along its trail.
    const tx = ctx.threatX[leader.id]!, ty = ctx.threatY[leader.id]!;
    const bearing = tx !== 0 || ty !== 0 ? Math.atan2(ty, tx) : leader.heading;
    for (let i = 1; i < g.length; i++) {
      const m = g[i]!;
      if (leader.diamondUntil !== null) {
        const ring = Math.floor((i - 1) / 4);
        const a = bearing + DIAMOND[(i - 1) % 4]! + (ring * Math.PI) / 4;
        const r = sq.diamondRadius * (1 + ring);
        ctx.slotX[m.id] = leader.x + Math.cos(a) * r;
        ctx.slotY[m.id] = leader.y + Math.sin(a) * r;
      } else {
        const p = t[t.length - i] ?? t[0] ?? leader;
        ctx.slotX[m.id] = p.x;
        ctx.slotY[m.id] = p.y;
      }
      if (m.insideBuilding === null && m.directUntil === null && Math.hypot(ctx.slotX[m.id]! - m.x, ctx.slotY[m.id]! - m.y) > sq.lagRadius) ctx.squadLag[leader.id] = 1;
    }
  }
}

/** Diamond slots, as turns from the danger's bearing: ahead, either side, behind. */
const DIAMOND = [0, Math.PI / 2, -Math.PI / 2, Math.PI];

/** What a squad leader is answering: a building (a 911 call) or a point (gunfire heard). */
export interface SquadTarget {
  x: number;
  y: number;
  building: Building | null;
}

function release(sim: Sim): void {
  sim.answering = null;
  sim.answeringSince = null;
  sim.destination = null;
  sim.destinationBuilding = null;
  sim.destinationKind = null;
}

/** A target dealt with: a call answered (whatever was there is gone), the leader free to look again. */
export function resolveTarget(world: World, sim: Sim): void {
  if (sim.answering !== null) {
    const b = world.buildings[sim.answering]!;
    b.callAt = null;
    b.dispatchedAt = null;
  }
  release(sim);
}

/**
 * The leader's target, held until resolved (sims.ts), judged too strong at the door
 * (refusedBy), or stale; else, every retargetInterval ticks, the nearest 911 call
 * within targetRadius that no other squad holds; failing that, the loudest gunfire
 * heard since it last looked, beyond police.shotIgnoreRadius (not its own squad's).
 * Never thrashing between newer ones: a held target is kept.
 */
export function squadTarget(world: World, sim: Sim): SquadTarget | null {
  const { config, tick, buildings, sims } = world;
  const sq = config.squads;
  if (sim.answeringSince !== null) {
    const stale = tick - sim.answeringSince > sq.staleAfter;
    if (sim.answering !== null) {
      const b = buildings[sim.answering]!;
      if (!stale && b.id !== sim.refusedBy && (b.callAt !== null || b.zombiesInside > 0)) {
        const e = b.entrances[0]!;
        return { x: e.x, y: e.y, building: b };
      }
    } else if (!stale && sim.destination !== null) {
      return { x: sim.destination.x, y: sim.destination.y, building: null };
    }
    release(sim);
  }
  if ((tick + sim.id) % sq.retargetInterval !== 0) return null;

  const held = new Set<number>();
  for (const o of sims) if (o.squadLeader === o.id && o !== sim && o.answering !== null) held.add(o.answering);
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of buildings) {
    if (b.callAt === null || held.has(b.id) || b.id === sim.refusedBy) continue;
    const e = b.entrances[0]!;
    const d = Math.hypot(e.x - sim.x, e.y - sim.y);
    if (d <= sq.targetRadius && d < bestD) {
      bestD = d;
      best = b;
    }
  }
  if (best !== null) {
    sim.answering = best.id;
    sim.answeringSince = tick;
    const e = best.entrances[0]!;
    return { x: e.x, y: e.y, building: best };
  }
  let loudest = 0;
  let shot: { x: number; y: number } | null = null;
  for (const st of world.stimuli) {
    if (tick - st.createdAt > sq.retargetInterval || !isFirearm(st.kind)) continue;
    if (Math.hypot(st.x - sim.x, st.y - sim.y) <= config.police.shotIgnoreRadius) continue;
    const i = intensityAt(st, sim.x, sim.y);
    if (i > loudest) {
      loudest = i;
      shot = { x: st.x, y: st.y };
    }
  }
  if (shot === null) return null;
  sim.answeringSince = tick;
  sim.destination = shot;
  sim.destinationBuilding = null;
  sim.destinationKind = 'respond';
  return { x: shot.x, y: shot.y, building: null };
}

/**
 * Reservists, `reservists.share` of the population, are taken from the residents of
 * buildings across the city (weighted by residents) and tracked from the start: each
 * an ordinary civilian part-way through a routine stop where it stands. Called once
 * at setup, after the residents are placed; with no armoury, nobody is called up, so
 * none are placed.
 */
export function placeReservists(world: World): void {
  const { config, buildings, rng, tick } = world;
  if (nearestArmoury(world, 0, 0) === null) return;
  let left = Math.round(world.scenario.population * config.reservists.share);
  while (left > 0) {
    let total = 0;
    for (const b of buildings) total += b.residents;
    if (total === 0) return;
    let r = nextInt(rng, 0, total - 1);
    const b = buildings.find((x) => (r -= x.residents) < 0)!;
    // A resident becomes tracked: indoors either way, so the counters do not move.
    b.residents--;
    const e = b.entrances[0]!;
    const sim = spawnSim(world, { x: e.x, y: e.y, insideBuilding: b.id, sourceTag: b.tag, from: b.id, initialPanic: 0, destinationKind: 'routine' });
    b.sheltered.push(sim.id);
    if (sim.archetype === 'police') continue; // a cop is police, whatever else: tracked, and not counted
    sim.archetype = 'reservist';
    sim.muster = 'reserve';
    const home = sim.home === null ? e : buildings[sim.home]!.entrances[0]!;
    sim.depot = nearestArmoury(world, home.x, home.y);
    if (chance(rng, config.reservists.pistolShare)) {
      sim.weapon = 'pistol';
      sim.ammo = config.reservists.pistolAmmo;
    }
    sim.destinationBuilding = b.id;
    sim.destination = { x: e.x, y: e.y };
    sim.idleUntil = tick + nextInt(rng, 0, config.routine.idleTicks[1]!);
    sim.gait = 'still';
    left--;
  }
}
