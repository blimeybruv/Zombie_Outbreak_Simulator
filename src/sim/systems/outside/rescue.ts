// The rescue: the ending. The outbreak has had its fourteen hours; then a company comes
// in from outside, by one exit, and pushes up a corridor from it, slowly and not far —
// districts away from it are never reached. The sweep makes the convergence rather than
// following it: the soldiers send back down the corridor anyone who identifies itself,
// and buildings the living hold behind their front give up their people, so a flow sets
// out across ground nobody has crossed in hours, against the way the soldiers came. Then
// a radio order tells everyone still hidden to make for that exit, and those far from
// the cleared corridor cross uncleared ground to reach it. Trucks take people out, a
// load at a time; nobody is screened. Soldiers shoot the dead, and may shoot whoever does
// not identify itself — frozen, sprinting, in the dark (combat.ts sweepFire): a sweep
// that told the living from the bitten would know what nobody knows.
//
//   at         rescue.at: the company comes in (rescueSweep) by the exit whose corridor
//              holds the most people still sheltering; trucks start
//   the front  each squad leader's post moves up its lane of the corridor, snapped to
//              the street, rescue.speed m a tick, to at most rescue.depth
//   send back  every 30 ticks: anyone outdoors within sendRadius of a soldier who is
//              not unidentified makes for the exit; buildings behind the front give up
//              takeShare of their residents (evacuees), and their tracked people go too
//   broadcast  rescue.broadcast later (rescueBroadcast): everyone tracked and outdoors
//              or sheltering makes for the exit; buildings still held let out
//              broadcastShare of their residents
//   trucks     every truckEvery ticks one pulls up beyond the barrier, loads for
//              truckLoad, and takes up to truckCapacity of those waiting, longest first

import type { Context } from '../../context';
import { roundByChance } from '../../lib/rng';
import type { Exit, Sim, Vec2, World } from '../../state';
import { parkTruck } from '../services/cars';
import { barrierAt, queueAt, spawnSquad } from './cordon';
import { headForExit, leaveMap } from './exits';
import { exitTicks, isLiving } from '../shared/common';
import { modeOf } from '../people/panic';

/** The corridor's axis from an exit: toward the middle of the map. */
function axisOf(world: World, e: Exit): Vec2 {
  const c = world.config.map.size / 2;
  const l = Math.hypot(c - e.x, c - e.y) || 1;
  return { x: (c - e.x) / l, y: (c - e.y) / l };
}

/** Where (x, y) lies against a corridor: how far along its axis, and how far off it. */
function inCorridor(world: World, e: Exit, x: number, y: number): { along: number; off: number } {
  const a = axisOf(world, e);
  const dx = x - e.x, dy = y - e.y;
  return { along: dx * a.x + dy * a.y, off: Math.abs(-dx * a.y + dy * a.x) };
}

/** The nearest point on a street to (x, y): where a squad can stand. */
function snap(world: World, ctx: Context, x: number, y: number): Vec2 {
  const sid = ctx.map.nearestStreet(x, y, world.config.map.offStreetLookup * 4);
  if (sid === null) return { x, y };
  const st = world.streets[sid]!;
  const a = world.nodes[st.a]!, b = world.nodes[st.b]!;
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
  const t = Math.max(0, Math.min(1, ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / len2));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * What became of those who answered the broadcast: out on a truck (or any way out),
 * dead, turned, still alive in the queue at the barrier when the run ended, or still
 * alive anywhere else. The broadcast kills more than it saves; this is where that shows.
 */
export function rescueTally(world: World): { answered: number; out: number; dead: number; turned: number; waiting: number; elsewhere: number } {
  const t = { answered: 0, out: 0, dead: 0, turned: 0, waiting: 0, elsewhere: 0 };
  const i = world.rescueExit;
  const q = i === null ? null : queueAt(world, world.exits[i]!);
  for (const s of world.sims) {
    if (s.answeredAt === null) continue;
    t.answered++;
    if (s.condition === 'evacuated') t.out++;
    else if (s.condition === 'dead') t.dead++;
    else if (s.condition === 'turned') t.turned++;
    else if (q !== null && s.insideBuilding === null && Math.hypot(s.x - q.x, s.y - q.y) <= world.config.cordon.queueRadius) t.waiting++;
    else t.elsewhere++;
  }
  return t;
}

/** Who a soldier can take for one of the living asking to be taken out: not frozen, not sprinting in a panic. */
export function identifies(world: World, sim: Sim): boolean {
  return sim.stand !== 'freeze' && sim.gait !== 'sprint' && modeOf(sim, world.config) !== 'flight';
}

/**
 * Has it heard the broadcast, and is it free to answer it? Then wherever it is it makes
 * for the rescue's exit — again, once calm, if it ran for a door on the way. Not those
 * on duty, in someone's care or come from outside.
 */
export function answersRescue(world: World, sim: Sim): boolean {
  const rc = world.config.rescue;
  if (world.rescueExit === null || world.tick < rc.at + rc.broadcast || sim.destinationKind === 'leave') return false;
  if (sim.outsider || sim.archetype === 'police' || sim.crew !== null || sim.carriedBy !== null || sim.squadLeader !== null || sim.answering !== null) return false;
  return believesAndDares(world, sim);
}

/**
 * Answering is a choice. A sceptic (trust under rescue.trustFloor) does not believe the
 * broadcast and stays put; the cautious weigh the uncleared ground between them and the
 * corridor the soldiers hold — caution × risk over rescue.riskTolerance and they stay
 * hidden, where risk grows with that distance, full at rescue.farFrom. Asked again as
 * things change: the front coming nearer can change a mind.
 */
function believesAndDares(world: World, sim: Sim): boolean {
  const rc = world.config.rescue;
  if (sim.trust < rc.trustFloor) return false;
  const e = world.exits[world.rescueExit!]!;
  const at = sim.insideBuilding === null ? sim : world.buildings[sim.insideBuilding]!.entrances[0]!;
  const c = inCorridor(world, e, at.x, at.y);
  const outside = Math.max(0, c.off - rc.halfWidth) + Math.max(0, c.along - world.rescueFront) + Math.max(0, -c.along);
  const risk = Math.min(1, outside / rc.farFrom);
  return sim.caution * risk <= rc.riskTolerance;
}

function sendBack(world: World, sim: Sim): void {
  if (sim.destinationKind === 'leave' || sim.outsider || sim.crew !== null || sim.carriedBy !== null) return;
  if (sim.squadLeader !== null || sim.answering !== null) return; // on duty
  headForExit(world, sim);
}

/** Building processes: the company, the front, sending back, the broadcast, the trucks. */
export function updateRescue(world: World, ctx: Context): void {
  const { config, tick, buildings, sims } = world;
  const rc = config.rescue;
  if (!config.features.rescue || !config.features.exits || world.exits.length === 0 || tick < rc.at) return;

  if (tick === rc.at) {
    // By the exit whose corridor holds the most people still sheltering.
    let best = 0, bestN = -1;
    world.exits.forEach((e, i) => {
      let n = 0;
      for (const b of buildings) {
        if (b.zombiesInside > 0 || b.residents === 0) continue;
        const c = inCorridor(world, e, b.entrances[0]!.x, b.entrances[0]!.y);
        if (c.along >= 0 && c.along <= rc.depth && c.off <= rc.halfWidth) n += b.residents;
      }
      if (n > bestN) {
        bestN = n;
        best = i;
      }
    });
    world.rescueExit = best;
    const e = world.exits[best]!;
    for (let k = 0; k < rc.squads; k++) for (const s of spawnSquad(world, e.x, e.y, { x: e.x, y: e.y }, rc.ammo)) s.sweep = true;
    world.rescueTruckAt = tick + rc.truckEvery;
    ctx.events.push({ type: 'rescueSweep', tick, count: 0, sim: null, x: e.x, y: e.y });
  }
  const i = world.rescueExit;
  if (i === null) return;
  const e = world.exits[i]!;
  const a = axisOf(world, e);
  // The front is where the company has got to, not where it was meant to: it advances
  // ahead of the farthest living soldier at most, and with none left the sweep stops.
  const soldiers = sims.filter((s) => s.sweep && isLiving(s) && s.insideBuilding === null);
  const reached = soldiers.reduce((m, s) => Math.max(m, inCorridor(world, e, s.x, s.y).along), 0);
  const front = soldiers.length === 0 ? 0 : Math.min(rc.depth, rc.speed * (tick - rc.at), reached + rc.lead);
  world.rescueFront = Math.max(world.rescueFront, front); // what has been cleared stays cleared, as far as anyone hiding knows

  // The front: each squad's leader holds its lane of the corridor at the front line.
  if (tick % 30 === 0) {
    const leaders = sims.filter((s) => s.sweep && s.squadLeader === s.id && isLiving(s));
    // In bounds: the line moves up `bound` metres at once, then holds and looks about
    // until the schedule catches up. A post crept forward a few metres every 30 ticks,
    // and the squads walked two metres and stood, over and over.
    const goal = Math.min(rc.depth, (Math.floor((rc.speed * (tick - rc.at)) / rc.bound) + 1) * rc.bound);
    leaders.forEach((s, k) => {
      const lane = ((k + 0.5) / leaders.length - 0.5) * 2 * rc.halfWidth * 0.8;
      const want = { x: e.x + a.x * goal - a.y * lane, y: e.y + a.y * goal + a.x * lane };
      const at = snap(world, ctx, want.x, want.y);
      // Nowhere to stand near its place in the line (the river, a block with no street
      // through it): it holds where it is until the line is past. Snapped from afar, the
      // post slid along the bank road as the line moved, and the squad with it.
      if (s.post === null || Math.hypot(at.x - want.x, at.y - want.y) <= rc.snapReach) s.post = at;
    });

    // Sending back: whoever a soldier meets, and buildings behind the front.
    for (const s of soldiers) {
      ctx.simHash.query(s.x, s.y, rc.sendRadius, ctx.ids2);
      for (const id of ctx.ids2) {
        const o = sims[id]!;
        if (!isLiving(o) || o.insideBuilding !== null || o.car !== null) continue;
        if (identifies(world, o)) sendBack(world, o);
      }
    }
    for (const b of buildings) {
      if (b.sweptAt !== null || b.zombiesInside > 0) continue;
      const c = inCorridor(world, e, b.entrances[0]!.x, b.entrances[0]!.y);
      if (c.along < 0 || c.along > front || c.off > rc.halfWidth) continue;
      b.sweptAt = tick;
      b.pendingEvacuate += Math.floor(Math.max(0, b.residents - b.pendingEvacuate - b.pendingRelease) * rc.takeShare);
      for (const id of b.sheltered) {
        const o = sims[id]!;
        if (isLiving(o)) {
          sendBack(world, o);
          if (o.destinationKind === 'leave') o.exitingUntil ??= tick + exitTicks(world, b);
        }
      }
    }
  }

  // The broadcast: everyone still hidden, to the exit.
  if (tick === rc.at + rc.broadcast) {
    ctx.events.push({ type: 'rescueBroadcast', tick, count: 0, sim: null, x: e.x, y: e.y });
    for (const s of sims) {
      if (!isLiving(s)) continue;
      s.awareAt ??= tick;
      if (answersRescue(world, s)) sendBack(world, s);
      if (s.insideBuilding !== null && s.destinationKind === 'leave') s.exitingUntil ??= tick + exitTicks(world, buildings[s.insideBuilding]!);
    }
    for (const b of buildings) {
      if (b.zombiesInside > 0) continue;
      b.pendingEvacuate += roundByChance(world.rng, Math.max(0, b.residents - b.pendingEvacuate - b.pendingRelease) * rc.broadcastShare);
    }
  }

  // The trucks.
  if (tick < world.rescueTruckAt) return;
  const b = barrierAt(world, e);
  if (world.rescueTruck === null) {
    const at = { x: b.x + e.dx * config.cordon.post * 2, y: b.y + e.dy * config.cordon.post * 2 };
    const truck = parkTruck(world, ctx, at.x, at.y, Math.atan2(-e.dy, -e.dx));
    world.rescueTruck = truck?.id ?? null;
    world.rescueTruckAt = tick + rc.truckLoad;
    return;
  }
  // Loaded: the longest waiting first (lower id on a tie), up to its capacity.
  const q = queueAt(world, e);
  const waiting = sims
    .filter((s) => isLiving(s) && s.queuedSince !== null && s.insideBuilding === null && s.car === null && s.destinationKind === 'leave' && Math.hypot(s.x - q.x, s.y - q.y) <= config.cordon.queueRadius)
    .sort((p, r) => p.queuedSince! - r.queuedSince! || p.id - r.id)
    .slice(0, rc.truckCapacity);
  for (const s of waiting) leaveMap(world, ctx, s);
  world.trucked += waiting.length;
  const truck = world.cars[world.rescueTruck]!;
  truck.state = 'gone';
  ctx.events.push({ type: 'truckLeft', tick, count: waiting.length, sim: null, x: truck.x, y: truck.y });
  world.rescueTruck = null;
  world.rescueTruckAt = tick + rc.truckEvery;
}
