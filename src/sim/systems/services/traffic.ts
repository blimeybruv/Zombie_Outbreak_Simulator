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
import type { Building, Checkpoint, Sim, World } from '../../state';
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
  return { exit, x: at.x, y: at.y, dx: (p.x - at.x) / d, dy: (p.y - at.y) / d, width: street.width, setAt: null, fallenAt: null };
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
    if (config.features.cars) parkVan(world, ctx, b, 'cruiser');
  });
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
  if (world.checkpointsAt === null) {
    if (world.exits.some((e) => e.closedAt !== null)) world.checkpointsAt = tick;
    return;
  }
  checkpoints.forEach((c, k) => {
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
    if ((tick + k) % tc.every !== 0 || holdsFire(world, c.exit)) return;
    const e = world.exits[c.exit]!;
    ctx.simHash.query(c.x, c.y, tc.stopRadius, ctx.ids2);
    for (const id of ctx.ids2) {
      const s = sims[id]!;
      if (!isOutdoorLiving(s) || s.car !== null || s.archetype === 'police' || s.outsider || s.destinationKind !== 'leave' || s.destination === null) continue;
      if (Math.hypot(s.destination.x - e.x, s.destination.y - e.y) > 1) continue;
      turnBack(world, s, c.exit);
    }
  });
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
