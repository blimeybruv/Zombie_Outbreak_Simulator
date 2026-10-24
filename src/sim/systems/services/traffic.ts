// Traffic police: the city's own attempt to contain itself, before the world outside
// does it for good. One checkpoint on each exit's road, a unit of traffic officers to
// hold it.
//
//   place     at setup, a checkpoint on each exit's road, traffic.inset metres in from
//             the cordon's barrier by the streets (following the widest street inward:
//             the arterial that feeds the exit); a unit of traffic.officers police
//             waits at the police station nearest it, with a cruiser at the kerb
//   order     the first barrier closing: each unit drives out to its checkpoint (as
//             SWAT does, squads.ts swatVan) and stands across the road (sims.ts
//             decideLeader: the checkpoint becomes its post)
//   stop      a checkpoint set turns back anyone on foot within stopRadius making for
//             its exit: that way out is known shut, as if warned at the barrier, before
//             they reach the soldiers' guns. Never at the rescue's exit once the rescue
//             has come. Officers do not fire on people; the dead they fight as police do
//   fall      none of its unit within holdRadius — dead, turned, run dry or fled — and
//             it has fallen, for good. Drawn fallen for the rest of the run, so the
//             Rangers walk past what is left of it

import type { Context } from '../../context';
import { makePolice, spawnSim, takeStaff } from '../../spawn';
import type { Building, Checkpoint, DistrictId, Sim, Vec2, World } from '../../state';
import type { Adjacent } from '../../navigation/runtime';
import { isOutdoorLiving } from '../../context';
import { isLiving } from '../shared/common';
import { barrierAt, holdsFire } from '../outside/cordon';
import { headForExit } from '../outside/exits';
import { parkVan } from './cars';

/** Where an exit's checkpoint goes: `inset` metres in from its barrier along the widest street inward, facing the exit. */
function checkpointFor(world: World, ctx: Context, exit: number): Checkpoint {
  const e = world.exits[exit]!;
  const { streets, nodes } = world;
  const inset = world.config.traffic.inset;
  const first = streets[e.street]!;
  let prev = e.node;
  let cur = first.a === e.node ? first.b : first.a;
  let street = first;
  const b = barrierAt(world, e);
  let travelled = Math.hypot(nodes[cur]!.x - b.x, nodes[cur]!.y - b.y);
  let at = { x: nodes[cur]!.x, y: nodes[cur]!.y };
  if (travelled >= inset) {
    const k = inset / travelled;
    at = { x: b.x + (nodes[cur]!.x - b.x) * k, y: b.y + (nodes[cur]!.y - b.y) * k };
  } else {
    for (;;) {
      // On by the widest street; on a tie the straightest, then the lower id.
      const p = nodes[prev]!, c = nodes[cur]!;
      const inx = (c.x - p.x) / (Math.hypot(c.x - p.x, c.y - p.y) || 1), iny = (c.y - p.y) / (Math.hypot(c.x - p.x, c.y - p.y) || 1);
      let next: Adjacent | null = null;
      let bestW = -1, bestDot = -Infinity;
      for (const adj of ctx.map.adjacency[cur]!) {
        if (adj.node === prev) continue;
        const s = streets[adj.street]!, n = nodes[adj.node]!;
        const dot = ((n.x - c.x) * inx + (n.y - c.y) * iny) / (adj.length || 1);
        if (s.width > bestW || (s.width === bestW && (dot > bestDot || (dot === bestDot && adj.street < next!.street)))) {
          bestW = s.width;
          bestDot = dot;
          next = adj;
        }
      }
      if (next === null) break;
      const n = nodes[next.node]!;
      street = streets[next.street]!;
      if (travelled + next.length >= inset) {
        const k = (inset - travelled) / (next.length || 1);
        at = { x: c.x + (n.x - c.x) * k, y: c.y + (n.y - c.y) * k };
        prev = cur;
        cur = next.node;
        break;
      }
      travelled += next.length;
      prev = cur;
      cur = next.node;
      at = { x: n.x, y: n.y };
    }
  }
  // Facing the exit: back along the street it stands on, toward the node it came from.
  const p = nodes[prev]!;
  const d = Math.hypot(p.x - at.x, p.y - at.y) || 1;
  return { exit, district: null, orderedAt: null, x: at.x, y: at.y, dx: (p.x - at.x) / d, dy: (p.y - at.y) / d, width: street.width, setAt: null, fallenAt: null };
}

/** The police station nearest a point (lower id on a tie); null on a map without one. */
function nearestStation(world: World, x: number, y: number): Building | null {
  let best: Building | null = null, bestD = Infinity;
  for (const b of world.buildings) {
    if (b.tag !== 'policeStation') continue;
    const e = b.entrances[0]!;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/**
 * The checkpoints, and a unit of traffic officers for each at the police station
 * nearest it, waiting inside with a cruiser at the kerb: police, taken from the
 * station's residents, a squad the lowest id leads. Called once at setup, after SWAT.
 */
export function placeTraffic(world: World, ctx: Context): void {
  const { config } = world;
  if (!config.features.traffic || !config.features.cordon || !config.features.exits) return;
  world.checkpoints = world.exits.map((_, i) => checkpointFor(world, ctx, i));
  world.checkpoints.forEach((c, k) => {
    const b = nearestStation(world, c.x, c.y);
    if (b === null) return;
    const e = b.entrances[0]!;
    let leader: Sim | null = null;
    for (let i = 0; i < config.traffic.officers; i++) {
      // A resident becomes tracked: indoors either way, so the counters do not move.
      if (!takeStaff(world, b)) break;
      const sim = spawnSim(world, { x: e.x, y: e.y, insideBuilding: b.id, sourceTag: b.tag, from: b.id, initialPanic: 0, destinationKind: null });
      makePolice(world, sim);
      sim.station = b.id;
      sim.shelter = b.id;
      sim.depot = b.id;
      sim.checkpoint = k;
      sim.destinationKind = 'shelter';
      sim.gait = 'still';
      sim.history.buildingsEntered = 1;
      leader ??= sim;
      sim.squadLeader = leader.id;
      sim.squadSlot = i;
      b.sheltered.push(sim.id);
    }
    // Its own cruiser: not for the station's other officers' calls (dispatch.ts rideToCall).
    const car = config.features.cars ? parkVan(world, ctx, b, 'cruiser') : null;
    if (car !== null) car.checkpoint = k;
  });
}

/**
 * Where a unit's vehicle stops at a checkpoint: behind the sawhorses on the exit's side
 * (the line faces the city, its vehicles at its back; parked in front of it, the
 * checkpoint looked to face out of the city), a cruiser behind one sawhorse and a
 * reservists' HMMWV behind the other; a step further back for each vehicle already
 * standing in the way (one left by an earlier unit, or someone else's).
 */
export function parkingSpot(world: World, c: Checkpoint, reservists: boolean): Vec2 {
  const tc = world.config.traffic;
  const aside = (reservists ? -1 : 1) * tc.parkAside;
  for (let k = 0; ; k++) {
    const back = tc.parkBehind + k * tc.parkStep;
    const p = { x: c.x + c.dx * back - c.dy * aside, y: c.y + c.dy * back + c.dx * aside };
    if (k >= tc.parkTries || !world.cars.some((v) => v.state !== 'driving' && v.state !== 'gone' && Math.hypot(v.x - p.x, v.y - p.y) < tc.parkClear)) return p;
  }
}

/** Whether a checkpoint is up: set and not fallen. */
export function checkpointHeld(c: Checkpoint): boolean {
  return c.setAt !== null && c.fallenAt === null;
}

/** Building processes: the order, checkpoints set as their units reach them, people turned back, checkpoints falling. */
export function updateTraffic(world: World, ctx: Context): void {
  const { config, tick, sims, checkpoints } = world;
  if (checkpoints.length === 0) return;
  const tc = config.traffic;
  // The first district to evacuate: checkpoints where its main roads leave it, manned at
  // once by first responders.
  for (const e of ctx.events) if (e.type === 'districtEvacuating' && e.first) evacuationCheckpoints(world, ctx, e.district, e.x, e.y);
  if (world.checkpointsAt === null && world.exits.some((e) => e.closedAt !== null)) {
    world.checkpointsAt = tick;
    for (const c of checkpoints) if (c.exit !== null) c.orderedAt ??= tick;
  }
  checkpoints.forEach((c, k) => {
    if (c.orderedAt === null) return;
    // Its unit: the traffic police sent to it, and any reservist squad that has claimed it.
    const unit = sims.filter((s) => s.checkpoint === k && isLiving(s));
    if (c.setAt === null || c.fallenAt !== null) {
      // Set once a unit's leader stands at it; a fallen one set again by reservists coming to it.
      const leader = unit.find((s) => s.squadLeader === s.id && s.post !== null && s.insideBuilding === null && s.car === null && Math.hypot(s.x - c.x, s.y - c.y) <= tc.holdRadius);
      if (leader === undefined) return;
      c.setAt = tick;
      c.fallenAt = null;
      ctx.events.push({ type: 'checkpointSet', tick, sim: leader.id, by: leader.archetype === 'police' ? 'police' : 'reservists', x: c.x, y: c.y });
      return;
    }
    if (!unit.some((s) => s.insideBuilding === null && Math.hypot(s.x - c.x, s.y - c.y) <= tc.holdRadius)) {
      c.fallenAt = tick;
      for (const s of unit) {
        // What is left of the traffic police is police like any other; reservists on
        // their way keep their claim, and set it again when they get there.
        if (s.archetype !== 'police') continue;
        s.checkpoint = null;
        s.post = null;
      }
      ctx.events.push({ type: 'checkpointFallen', tick, sim: null, by: null, x: c.x, y: c.y });
      return;
    }
    if ((tick + k) % tc.every !== 0 || (c.exit !== null && holdsFire(world, c.exit))) return;
    ctx.simHash.query(c.x, c.y, tc.stopRadius, ctx.ids2);
    for (const id of ctx.ids2) {
      const s = sims[id]!;
      if (!isOutdoorLiving(s) || s.car !== null || s.archetype === 'police' || s.outsider || s.destinationKind !== 'leave' || s.destination === null) continue;
      // On an exit's road: anyone making for that exit. At the evacuating district's
      // edge: anyone making for any way out, but that district's own evacuees, who go on.
      const to = exitAt(world, s.destination.x, s.destination.y);
      if (to === null || (c.exit !== null ? to !== c.exit : s.evacuatedFrom === c.district)) continue;
      turnBack(world, s, to);
    }
  });
}

/** The way off the map at (x, y), or null if there is none there. */
function exitAt(world: World, x: number, y: number): number | null {
  const i = world.exits.findIndex((e) => Math.hypot(e.x - x, e.y - y) <= 1);
  return i < 0 ? null : i;
}

/**
 * The first district to evacuate: traffic.evacCheckpoints checkpoints where its widest
 * roads leave it — at the junctions of those roads farthest from where its evacuees
 * set out (its edge), each in a direction at least evacApart from the others — a little
 * way out along the road leaving the district, facing it. Each is manned at once by
 * officers.officers of the first responders of the police station nearest it, inside
 * and free, who drive out in one of its cars at the kerb: fewer to answer 911 calls.
 */
function evacuationCheckpoints(world: World, ctx: Context, district: DistrictId, cx: number, cy: number): void {
  const { config, streets, nodes, sims, buildings, cars, tick } = world;
  const tc = config.traffic;
  const own = streets.filter((s) => s.district === district);
  if (own.length === 0) return;
  const widest = Math.max(...own.map((s) => s.width));
  const roads = own.filter((s) => s.width >= Math.min(tc.evacRoadWidth, widest));
  // Junctions on those roads, farthest from the centre first (lower id on a tie).
  const ends = [...new Set(roads.flatMap((s) => [s.a, s.b]))]
    .filter((n) => ctx.map.adjacency[n]!.length >= 3)
    .sort((a, b) => Math.hypot(nodes[b]!.x - cx, nodes[b]!.y - cy) - Math.hypot(nodes[a]!.x - cx, nodes[a]!.y - cy) || a - b);
  const dirs: { x: number; y: number }[] = [];
  for (const n of ends) {
    if (dirs.length >= tc.evacCheckpoints) break;
    const node = nodes[n]!;
    const r = Math.hypot(node.x - cx, node.y - cy) || 1;
    const out = { x: (node.x - cx) / r, y: (node.y - cy) / r };
    if (dirs.some((d) => d.x * out.x + d.y * out.y > tc.evacApart)) continue;
    // The road leaving the junction most nearly outward: the checkpoint a little way along it.
    let best: { street: number; node: number; length: number } | null = null, bestDot = 0;
    for (const adj of ctx.map.adjacency[n]!) {
      const m = nodes[adj.node]!;
      const dot = ((m.x - node.x) * out.x + (m.y - node.y) * out.y) / (adj.length || 1);
      if (dot > bestDot && streets[adj.street]!.width >= Math.min(tc.evacRoadWidth, widest)) {
        best = adj;
        bestDot = dot;
      }
    }
    if (best === null) continue;
    const m = nodes[best.node]!;
    const along = Math.min(tc.evacOffset, best.length / 2) / (best.length || 1);
    const x = node.x + (m.x - node.x) * along, y = node.y + (m.y - node.y) * along;
    // Facing the district, its vehicles at its back: "toward the exit" here is outward.
    const ux = (m.x - node.x) / (best.length || 1), uy = (m.y - node.y) / (best.length || 1);
    const k = world.checkpoints.length;
    world.checkpoints.push({ exit: null, district, orderedAt: tick, x, y, dx: ux, dy: uy, width: streets[best.street]!.width, setAt: null, fallenAt: null });
    dirs.push(out);
    // Its unit: the first responders of the nearest station with enough of them in, free.
    const free = (s: Sim, st: number) => s.station === st && s.squadLeader === null && s.checkpoint === null && s.answering === null && s.insideBuilding === st && isLiving(s);
    let station: Building | null = null, stationD = Infinity;
    for (const b of buildings) {
      if (b.tag !== 'policeStation') continue;
      if (sims.filter((s) => free(s, b.id)).length < tc.officers) continue;
      const d = Math.hypot(b.entrances[0]!.x - x, b.entrances[0]!.y - y);
      if (d < stationD) {
        station = b;
        stationD = d;
      }
    }
    if (station === null) continue;
    const unit = sims.filter((s) => free(s, station!.id)).slice(0, tc.officers);
    unit.forEach((s, i) => {
      s.squadLeader = unit[0]!.id;
      s.squadSlot = i;
      s.checkpoint = k;
      s.shelter = station!.id;
      s.depot = station!.id;
    });
    const door = station.entrances[0]!;
    const car = cars.find((v) => v.kind === 'cruiser' && v.home === station!.id && v.state === 'parked' && v.occupants.length === 0 && v.checkpoint === null && Math.hypot(v.x - door.x, v.y - door.y) <= config.police.carNear);
    if (car !== undefined) car.checkpoint = k;
  }
}

/** Turned back at a checkpoint: that way out known shut; on to another the sim does not know is, or no longer leaving. */
function turnBack(world: World, sim: Sim, exit: number): void {
  sim.knownClosed |= 1 << exit;
  sim.crossing = null;
  if (headForExit(world, sim)) return;
  sim.destination = null;
  sim.destinationBuilding = null;
  sim.destinationKind = null;
  sim.route = [];
  sim.routeIndex = 0;
}
