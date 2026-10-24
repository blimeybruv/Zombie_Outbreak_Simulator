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
//   targets   once the checkpoints are ordered (traffic.ts), the leader claims the
//             nearest checkpoint no other reservist squad has, fallen or not, takes a
//             HMMWV from the armoury's lot and drives there, and holds it as the
//             traffic police do; with every checkpoint taken, it waits at the armoury
//   losses    the leader falls: the lowest surviving id leads. Below two, the squad
//             dissolves; its members stand down, keeping their weapons
//
// Combat, stamina, infection and panic are everyone's, unchanged. Five firearms are
// the loudest thing on the map: squads draw more than they can handle.

import type { Context } from '../../context';
import type { Building, BuildingId, Sim, World } from '../../state';
import { chance, nextFloat } from '../../lib/rng';
import { makePolice, spawnSim, takeStaff } from '../../spawn';
import { isFirearm } from '../../state';
import { outOfAmmo, restock } from '../fighting/arms';
import { capacity, isLiving, leaveTalk } from '../shared/common';
import { boardSquad, parkVan } from './cars';
import { parkingSpot } from './traffic';
import { nearestExit } from '../outside/exits';

const armouryCache = new WeakMap<readonly unknown[], BuildingId[]>();

/**
 * Up to `count` of `among`, spread across the city: the one nearest the middle of the
 * map, then each next the one farthest from those already chosen (ties to the lower id).
 */
function spread(world: World, among: Building[], count: number): Building[] {
  const { buildings } = world;
  if (among.length === 0) return [];
  const depots = among;
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
  while (chosen.length < Math.min(count, depots.length)) {
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
  return chosen;
}

/** Chooses the armouries among the depots, spread across the city. Called once at setup, before anyone spawns. */
export function designateArmouries(world: World): void {
  const { config, buildings } = world;
  if (!config.features.reservists) return;
  // Depots with a yard first (map generation gives the first one with room a yard, for
  // the armoury's HMMWVs); then the rest, spread across the map.
  const depots = buildings.filter((b) => b.tag === 'depot');
  const yarded = depots.filter((b) => world.lots.some((l) => l.home === b.id));
  const chosen = spread(world, yarded, config.reservists.armouries);
  if (chosen.length < config.reservists.armouries) chosen.push(...spread(world, depots.filter((b) => !chosen.includes(b)), config.reservists.armouries - chosen.length));
  for (const b of chosen) b.weaponStock = config.reservists.weaponStock;
}

/** The armouries' HMMWVs, `reservists.hmmwvs` in each one's lot (or at its kerb). Called once at setup, with the parked cars placed. */
export function parkHmmwvs(world: World, ctx: Context): void {
  if (!world.config.features.reservists || !world.config.features.cars) return;
  for (const b of world.buildings) {
    if (b.weaponStock === null) continue;
    for (let n = 0; n < world.config.reservists.hmmwvs; n++) parkVan(world, ctx, b, 'hmmwv');
  }
}

/**
 * SWAT: a squad garrisoned at each of `swat.stations` police stations, spread across the
 * city, from the start: police, taken from the station's residents, with a van at the
 * kerb. Called once at setup, after the first responders and the parked cars.
 */
export function placeSwat(world: World, ctx: Context): void {
  const { config, buildings } = world;
  if (!config.features.swat) return;
  const size = config.squads.size;
  const stations = buildings.filter((b) => b.tag === 'policeStation');
  for (const b of spread(world, stations, config.swat.stations)) {
    const e = b.entrances[0]!;
    let leader: Sim | null = null;
    for (let i = 0; i < size; i++) {
      // A resident (of the station, or failing that its district) becomes tracked:
      // indoors either way, so the counters do not move.
      if (!takeStaff(world, b)) break;
      const sim = spawnSim(world, { x: e.x, y: e.y, insideBuilding: b.id, sourceTag: b.tag, from: b.id, initialPanic: 0, destinationKind: null });
      makePolice(world, sim);
      sim.weapon = config.swat.weapon;
      sim.ammo = config.swat.ammo;
      sim.station = b.id;
      sim.shelter = b.id;
      sim.depot = b.id;
      sim.destinationKind = 'shelter';
      sim.gait = 'still';
      sim.history.buildingsEntered = 1;
      leader ??= sim;
      sim.squadLeader = leader.id;
      sim.squadSlot = i;
      b.sheltered.push(sim.id);
    }
    if (config.features.cars) parkVan(world, ctx, b);
  }
}

/** SWAT: a squad that set out from a police station. */
export function isSwat(sim: Sim): boolean {
  return sim.station !== null && sim.squadLeader !== null;
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
  if (world.calledUpAt === null || sim.muster !== 'reserve' || sim.depot === null || !isLiving(sim)) return;
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

/**
 * The call-up order: the authorities activate the reserve once reservists.callUpCalls
 * 911 calls have come in — what they know of the outbreak's size, not the outbreak
 * itself — and the reserve musters (muster). Until then reservists are anonymous
 * residents like anyone; reservists at their strength cannot hold a city already lost,
 * and are not meant to put the outbreak down before it has a shape.
 */
function callUp(world: World, ctx: Context): void {
  if (world.calledUpAt !== null || !world.config.features.reservists || world.callsTaken < world.config.reservists.callUpCalls) return;
  world.calledUpAt = world.tick;
  const depot = world.buildings.find((b) => b.weaponStock !== null);
  const at = depot?.entrances[0] ?? { x: 0, y: 0 };
  ctx.events.push({ type: 'reservistsCalledUp', tick: world.tick, sim: null, x: at.x, y: at.y });
  muster(world);
}

/**
 * The muster: reservists.share of the residents still in the buildings the living
 * hold at the moment of the order — a district already gone produces none — step out
 * as tracked reservists and make for their depots, never stopping to shelter, and not
 * all arrive. Weighted toward buildings near an armoury (exp(−d / depotScale),
 * normalised so the share overall is unchanged): the lever for how many arrive,
 * without changing what the journey costs. A tenth (pistolShare) carry a pistol of
 * their own. A cop stays police.
 */
function muster(world: World): void {
  const { config, buildings, rng } = world;
  const rc = config.reservists;
  const weight: number[] = [];
  let weighted = 0, residents = 0;
  for (const b of buildings) {
    let w = 0;
    if (b.residents > 0 && b.zombiesInside === 0) {
      const a = nearestArmoury(world, b.entrances[0]!.x, b.entrances[0]!.y);
      if (a !== null) {
        const e = b.entrances[0]!, d = buildings[a]!.entrances[0]!;
        w = Math.exp(-Math.hypot(d.x - e.x, d.y - e.y) / rc.depotScale);
        weighted += w * b.residents;
        residents += b.residents;
      }
    }
    weight.push(w);
  }
  if (weighted === 0) return;
  const k = (rc.share * residents) / weighted;
  for (const b of buildings) {
    const expect = b.residents * weight[b.id]! * k;
    if (expect === 0) continue;
    let n = Math.min(b.residents, Math.floor(expect) + (nextFloat(rng) < expect - Math.floor(expect) ? 1 : 0));
    for (; n > 0; n--) {
      // A resident becomes tracked: indoors either way, so the counters do not move.
      b.residents--;
      const e = b.entrances[0]!;
      const sim = spawnSim(world, { x: e.x, y: e.y, insideBuilding: b.id, sourceTag: b.tag, from: b.id, initialPanic: 0, destinationKind: null });
      b.sheltered.push(sim.id);
      if (sim.archetype === 'police') continue;
      sim.archetype = 'reservist';
      sim.muster = 'reserve';
      const home = sim.home === null ? e : buildings[sim.home]!.entrances[0]!;
      sim.depot = nearestArmoury(world, home.x, home.y);
      if (chance(rng, rc.pistolShare)) {
        sim.weapon = 'pistol';
        sim.ammo = rc.pistolAmmo;
      }
      mobilise(world, sim);
    }
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
    if (sim.weapon !== null) b.stock.push({ item: sim.weapon, ammo: sim.ammo }); // its own, left at the depot
    sim.weapon = rc.weapon;
    sim.ammo = rc.ammo;
    sim.muster = 'waiting';
  } else {
    sim.muster = 'stoodDown';
    sim.shelter = b.id;
    sim.destinationKind = 'shelter';
  }
}

/**
 * Squads form at depots: `squads.size` waiting there, in id order, the lowest leading.
 * They wait inside for a target. Reservists stood down who are back inside an armoury
 * (their squad gone, or no weapon left when they came) count too: each takes what it
 * can of the armoury's stock (a firearm left there, rounds), and those armed join
 * whoever else is waiting. Four reservists sitting in an armoury are a squad.
 */
function formSquads(world: World, ctx: Context): void {
  const { config, tick, buildings, sims } = world;
  const size = config.squads.size;
  for (const b of buildings) {
    if (b.weaponStock === null) continue;
    const here = b.sheltered.map((id) => sims[id]!).filter((s) => (s.muster === 'waiting' || s.muster === 'stoodDown') && isLiving(s) && s.insideBuilding === b.id);
    if (here.length < size) continue;
    for (const s of here) if (s.muster === 'stoodDown') restock(world, s, b);
    const waiting = here.filter((s) => s.weapon !== null).sort((p, q) => p.id - q.id);
    for (let at = 0; at + size <= waiting.length; at += size) {
      const leader = waiting[at]!;
      for (let i = 0; i < size; i++) {
        const m = waiting[at + i]!;
        m.shelter = null;
        m.destinationKind = null;
        m.destinationBuilding = null;
        m.destination = null;
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
    if (m.checkpoint !== null) {
      // Too few to hold a checkpoint: it is left to whoever else holds it, or falls.
      m.checkpoint = null;
      m.post = null;
    }
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
 * zombie within reach, held diamondHold ticks; file otherwise; a line for a cordon
 * squad), its leader's trail, each
 * follower's slot, and whether the leader should wait for a straggler.
 */
export function squadPass(world: World, ctx: Context): void {
  const { config, tick, sims, zombies } = world;
  const sq = config.squads;
  callUp(world, ctx);
  formSquads(world, ctx);
  pruneRadios(world);
  const groups: Sim[][] = [];
  const order: number[] = [];
  for (const s of sims) {
    if (s.squadLeader === null) continue;
    if (!isLiving(s)) {
      s.squadLeader = null;
      continue;
    }
    // Run dry: out of the squad and back where it set out from to rearm — a reservist to
    // its depot (called up again, sims.ts), an officer to its station (sims.ts). Soldiers
    // from outside hold where they are. The rest go on, the lowest id leading.
    if (!s.outsider && outOfAmmo(world, s)) {
      s.squadLeader = null;
      s.diamondUntil = null;
      s.trail = [];
      s.checkpoint = null;
      s.post = null;
      if (s.archetype === 'reservist' && s.depot !== null) {
        s.muster = 'mobilised';
        s.destinationKind = null;
        s.destinationBuilding = null;
        s.destination = null;
        s.route = [];
      }
      ctx.events.push({ type: 'outOfAmmo', tick, sim: s.id, x: s.x, y: s.y });
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
      leader.post ??= sims[lid]!.post; // a cordon squad holds the same post under its new leader
    }
    let cap = 0;
    for (let i = 0; i < g.length; i++) {
      g[i]!.squadSlot = i;
      cap += capacity(world, g[i]!);
    }
    ctx.squadCap[leader.id] = cap;
    ctx.squadLag[leader.id] = 0;
    if (leader.insideBuilding !== null || leader.car !== null) continue;

    // Engaged: any member outdoors with a zombie within reach.
    let engaged = false;
    for (const m of g) {
      const zid = ctx.nearestZombie[m.id]!;
      if (m.insideBuilding !== null || m.car !== null || zid < 0) continue;
      const z = zombies[zid]!;
      if (Math.hypot(z.x - m.x, z.y - m.y) <= rangeOf(world, m) * sq.engageRange) engaged = true;
    }
    if (engaged) {
      if (leader.diamondUntil === null) ctx.events.push({ type: 'squadEngaged', tick, sim: leader.id, members: g.length, x: leader.x, y: leader.y });
      leader.diamondUntil = tick + sq.diamondHold;
    } else if (leader.diamondUntil !== null && tick >= leader.diamondUntil) {
      leader.diamondUntil = null;
    }

    // The leader's trail: a point each fileSpacing metres, the newest where it stands,
    // and one more behind it for each follower.
    const t = leader.trail;
    const last = t[t.length - 1];
    if (last === undefined || Math.hypot(leader.x - last.x, leader.y - last.y) >= sq.fileSpacing) {
      t.push({ x: leader.x, y: leader.y });
      if (t.length > g.length + 1) t.shift();
    }

    // Slots: a cordon squad stands in line abreast across its exit's highway, engaged or
    // not; others in the diamond, around the leader, turned toward the danger it sees
    // (or the way it faces), and in file, back along its trail.
    // A traffic unit stands across its checkpoint's road.
    const cp = leader.checkpoint === null ? null : world.checkpoints[leader.checkpoint]!;
    const ex = leader.post === null ? null : cp ?? world.exits[nearestExit(world, leader.post.x, leader.post.y)!]!;
    const line = ex === null ? null : { x: -ex.dy, y: ex.dx };
    const tx = ctx.threatX[leader.id]!, ty = ctx.threatY[leader.id]!;
    const bearing = tx !== 0 || ty !== 0 ? Math.atan2(ty, tx) : leader.heading;
    for (let i = 1; i < g.length; i++) {
      const m = g[i]!;
      if (line !== null) {
        // Alternately either side of the leader, across the road.
        const k = (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * sq.lineSpacing;
        ctx.slotX[m.id] = leader.x + line.x * k;
        ctx.slotY[m.id] = leader.y + line.y * k;
      } else if (leader.diamondUntil !== null) {
        const ring = Math.floor((i - 1) / 4);
        const a = bearing + DIAMOND[(i - 1) % 4]! + (ring * Math.PI) / 4;
        const r = sq.diamondRadius * (1 + ring);
        ctx.slotX[m.id] = leader.x + Math.cos(a) * r;
        ctx.slotY[m.id] = leader.y + Math.sin(a) * r;
      } else {
        const p = t[t.length - 1 - i] ?? t[0] ?? leader;
        ctx.slotX[m.id] = p.x;
        ctx.slotY[m.id] = p.y;
      }
      if (m.insideBuilding === null && m.directUntil === null && Math.hypot(ctx.slotX[m.id]! - m.x, ctx.slotY[m.id]! - m.y) > sq.lagRadius) ctx.squadLag[leader.id] = 1;
    }
  }
}

/** Diamond slots, as turns from the danger's bearing: ahead, either side, behind. */
const DIAMOND = [0, Math.PI / 2, -Math.PI / 2, Math.PI];

/** The point on the nearest street to (x, y): where a van can pull up. */
function onStreet(world: World, ctx: Context, x: number, y: number): { x: number; y: number } {
  const sid = ctx.map.nearestStreet(x, y, world.config.map.offStreetLookup);
  if (sid === null) return { x, y };
  const st = world.streets[sid]!;
  const a = world.nodes[st.a]!, b = world.nodes[st.b]!;
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
  const t = Math.max(0, Math.min(1, ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / len2));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * An officer on a call, outmatched, radios for SWAT: where it is and how many it
 * counted. A radio still unanswered within squads.sceneRadius is brought up to date
 * instead of doubled.
 */
export function radioForSwat(world: World, ctx: Context, sim: Sim, count: number): void {
  const { tick, config } = world;
  sim.radioedAt = tick;
  const near = world.radios.find((r) => r.claimedBy === null && Math.hypot(r.x - sim.x, r.y - sim.y) <= config.squads.sceneRadius);
  if (near !== undefined) {
    near.count = count;
    near.at = tick;
    near.from = sim.id;
    return;
  }
  world.radios.push({ x: sim.x, y: sim.y, count, at: tick, from: sim.id, claimedBy: null });
  ctx.events.push({ type: 'policeRadio', tick, sim: sim.id, count, x: sim.x, y: sim.y });
}

/** Radios nobody took lapse; one SWAT answered goes with its answer. */
function pruneRadios(world: World): void {
  const stale = world.config.squads.staleAfter;
  world.radios = world.radios.filter((r) => r.claimedBy !== null || world.tick - r.at <= stale);
}

/**
 * SWAT answers no 911 call, only an officer's radio: the nearest unanswered one within
 * swat.radius whose count its own capacity, summed, can take on — sized by the report,
 * not by what is there now. Held until resolved (at the scene, nothing left in reach)
 * or stale.
 */
function swatTarget(world: World, ctx: Context, sim: Sim): SquadTarget | null {
  const { config, tick } = world;
  if (sim.answeringSince !== null) {
    const held = world.radios.find((r) => r.claimedBy === sim.id);
    if (held !== undefined && tick - sim.answeringSince <= config.squads.staleAfter) return { x: held.x, y: held.y, building: null };
    resolveTarget(world, sim);
  }
  let best: (typeof world.radios)[number] | null = null;
  let bestD = Infinity;
  for (const r of world.radios) {
    if (r.claimedBy !== null || ctx.squadCap[sim.id]! < r.count * config.squads.contestRatio) continue;
    const d = Math.hypot(r.x - sim.x, r.y - sim.y);
    if (d <= config.swat.radius && d < bestD) {
      bestD = d;
      best = r;
    }
  }
  if (best === null) return null;
  best.claimedBy = sim.id;
  // Where the van can pull up: the radio's point, on the street, from here on.
  const p = onStreet(world, ctx, best.x, best.y);
  best.x = p.x;
  best.y = p.y;
  sim.answering = null;
  sim.answeringSince = tick;
  sim.destination = p;
  sim.destinationBuilding = null;
  sim.destinationKind = 'respond';
  ctx.events.push({ type: 'swatDeployed', tick, station: sim.station!, sim: sim.id, count: best.count, x: p.x, y: p.y });
  return { x: p.x, y: p.y, building: null };
}

/**
 * A squad setting out with its vehicle at hand — standing free at its station, or
 * within swat.vanReach of the leader (where it left it at the last scene) — and the
 * target beyond swat.vanBeyond: to the vehicle, and in together once every member is
 * within swat.vanGather of it. True while this is what the leader is doing. Only a
 * vehicle at the station counted: at the scene, a squad called on elsewhere stood
 * beside its van, then walked.
 */
export function swatVan(world: World, ctx: Context, sim: Sim, t: SquadTarget): boolean {
  const { config, cars, sims, buildings } = world;
  // Its station, or a reservist squad's armoury; a reservist squad drives a HMMWV, a
  // traffic unit a cruiser, SWAT its van.
  const reservists = sim.archetype === 'reservist' && !sim.outsider;
  const home = reservists ? sim.depot : sim.station;
  if (home === null) return false;
  const door = buildings[home]!.entrances[0]!;
  const kind = reservists ? 'hmmwv' : sim.checkpoint !== null ? 'cruiser' : 'van';
  // The nearest standing free at its station or near the leader (a first responder's cruiser may be parked anywhere).
  let van: (typeof cars)[number] | undefined, best = Infinity;
  for (const c of cars) {
    if (c.kind !== kind || c.home !== home || c.state !== 'parked' || c.occupants.length > 0) continue;
    if (kind === 'cruiser' && c.checkpoint !== sim.checkpoint) continue; // a traffic unit's own cruiser, not the station's
    const d = Math.hypot(c.x - sim.x, c.y - sim.y);
    if (d >= best || (d > config.swat.vanReach && Math.hypot(c.x - door.x, c.y - door.y) > config.swat.radius / 10)) continue;
    van = c;
    best = d;
  }
  if (van === undefined) return false;
  // Close enough to walk, unless going to man a checkpoint: there the vehicle is part of it.
  if (sim.checkpoint === null && Math.hypot(t.x - van.x, t.y - van.y) <= config.swat.vanBeyond) return false;
  const members = sims.filter((s) => s.squadLeader === sim.id && isLiving(s));
  const gathered = members.every((s) => s.insideBuilding === null && s.car === null && Math.hypot(s.x - van.x, s.y - van.y) <= config.swat.vanGather);
  if (gathered && boardSquad(world, ctx, van, members, t)) return true;
  sim.destination = { x: van.x, y: van.y };
  sim.destinationBuilding = null;
  sim.destinationKind = 'respond';
  return true;
}

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
  if (world.radios.some((r) => r.claimedBy === sim.id)) world.radios = world.radios.filter((r) => r.claimedBy !== sim.id);
  if (sim.answering !== null) {
    const b = world.buildings[sim.answering]!;
    b.callAt = null;
    b.dispatchedAt = null;
  }
  release(sim);
}

/**
 * The leader's target. A traffic unit or a reservist squad: its checkpoint, once the
 * checkpoints are ordered (traffic.ts) — a reservist squad without one claims the
 * nearest no other reservist squad has (fallen or not), and waits at its depot while
 * every checkpoint has one. SWAT: an officer's radio (swatTarget).
 */
export function squadTarget(world: World, ctx: Context, sim: Sim): SquadTarget | null {
  if (world.checkpointsAt !== null && sim.checkpoint === null && sim.archetype === 'reservist' && !sim.outsider) claimCheckpoint(world, sim);
  if (sim.checkpoint !== null) {
    // To where its vehicle parks, behind the checkpoint; standing there, the checkpoint is its post (sims.ts).
    if (world.checkpointsAt === null) return null;
    const p = parkingSpot(world, world.checkpoints[sim.checkpoint]!, sim.archetype === 'reservist');
    if (sim.destination === null || sim.destination.x !== p.x || sim.destination.y !== p.y) {
      sim.destination = { x: p.x, y: p.y };
      sim.destinationBuilding = null;
      sim.destinationKind = 'respond';
      sim.route = [];
      sim.routeIndex = 0;
    }
    return { x: p.x, y: p.y, building: null };
  }
  if (sim.station !== null) return swatTarget(world, ctx, sim);
  return null;
}

/** A reservist squad's leader takes the nearest checkpoint no other reservist squad has, for the whole squad; none, and it has none. */
function claimCheckpoint(world: World, sim: Sim): void {
  const manned = new Set<number>();
  for (const o of world.sims) if (o.checkpoint !== null && o.archetype === 'reservist' && isLiving(o)) manned.add(o.checkpoint);
  let best = -1, bestD = Infinity;
  world.checkpoints.forEach((c, k) => {
    if (manned.has(k)) return;
    const d = Math.hypot(c.x - sim.x, c.y - sim.y);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  });
  if (best < 0) return;
  for (const m of world.sims) if (m.squadLeader === sim.id && isLiving(m)) m.checkpoint = best;
}

