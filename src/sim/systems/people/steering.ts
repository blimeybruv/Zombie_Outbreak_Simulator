// Steering on foot: how a sim turns intent into a heading. Toward a point, going round
// danger it can see (and saying when the danger is squarely in the way, for the caller
// to decide on); away from danger; along its cached route, queuing a repath when it has
// none. Writes heading and the repath queue, never position.

import type { Context } from '../../context';
import { sharedNode } from '../../navigation/pathfinding';
import type { Sim, World } from '../../state';

export function steerToward(sim: Sim, x: number, y: number): void {
  const dx = x - sim.x;
  const dy = y - sim.y;
  if (dx !== 0 || dy !== 0) sim.heading = Math.atan2(dy, dx);
}

/** How directly ahead, along its heading, the danger lies: the cosine, or 0 with none in sight. */
export function dangerAhead(ctx: Context, sim: Sim): number {
  const tx = ctx.threatX[sim.id]!, ty = ctx.threatY[sim.id]!;
  const tl = Math.hypot(tx, ty);
  if (ctx.threat[sim.id]! <= 0 || tl === 0) return 0;
  return (Math.cos(sim.heading) * tx + Math.sin(sim.heading) * ty) / tl;
}

/**
 * Going somewhere with danger ahead: bend the heading away from it, more the closer
 * and more directly ahead it is, so the sim goes round rather than through. Danger
 * behind or beside it changes nothing: it is already getting away.
 *
 * Returns true, leaving the heading on the goal, when the danger is squarely in the
 * way (the blend at least `cornered.blockedAt`). Bending further would turn the sim
 * back the way it came, and a step further off the blend would weaken and turn it
 * forward again: the hover in front of a zombie that read as beelining back and
 * forth. The caller decides instead (wayBlocked).
 */
export function goRound(world: World, ctx: Context, sim: Sim): boolean {
  const threat = ctx.threat[sim.id]!;
  const ahead = dangerAhead(ctx, sim);
  if (threat <= 0 || ahead <= 0) return false;
  const tl = Math.hypot(ctx.threatX[sim.id]!, ctx.threatY[sim.id]!);
  const ux = ctx.threatX[sim.id]! / tl, uy = ctx.threatY[sim.id]! / tl;
  const dx = Math.cos(sim.heading), dy = Math.sin(sim.heading);
  const w = world.config.behaviour.avoidWeight * threat * ahead;
  if (w >= world.config.cornered.blockedAt) return true;
  sim.heading = Math.atan2(dy - w * uy, dx - w * ux);
  return false;
}

/** Toward a point, going round any danger in the way. True if the danger blocks it. */
export function headFor(world: World, ctx: Context, sim: Sim, x: number, y: number): boolean {
  steerToward(sim, x, y);
  return goRound(world, ctx, sim);
}

export function steerAway(ctx: Context, sim: Sim): void {
  const tx = ctx.threatX[sim.id]!;
  const ty = ctx.threatY[sim.id]!;
  if (tx !== 0 || ty !== 0) sim.heading = Math.atan2(-ty, -tx);
}

/**
 * The last leg, to the door: straight there if it can be seen, else first to the street
 * in front of it (the door's frontage street, level with the door). Straight at a door
 * round the corner of its own building, or behind another, a sim slid along the walls
 * and parked cars between, and could go round and round there.
 */
function lastLeg(world: World, ctx: Context, sim: Sim): boolean {
  const d = sim.destination!;
  const bid = sim.destinationBuilding;
  if (bid === null || Math.hypot(d.x - sim.x, d.y - sim.y) <= world.config.behaviour.waypointRadius) return headFor(world, ctx, sim, d.x, d.y);
  const st = world.streets[world.buildings[bid]!.street]!;
  const a = world.nodes[st.a]!, b = world.nodes[st.b]!;
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((d.x - a.x) * dx + (d.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  const fx = a.x + dx * t, fy = a.y + dy * t; // the street in front of the door
  const fl = Math.hypot(fx - d.x, fy - d.y) || 1;
  // Seen from here: a point just out from the door toward its street (the door itself lies on the wall).
  const ox = d.x + ((fx - d.x) / fl) * world.config.behaviour.doorStep, oy = d.y + ((fy - d.y) / fl) * world.config.behaviour.doorStep;
  if (ctx.map.lineOfSight(sim.x, sim.y, ox, oy)) return headFor(world, ctx, sim, d.x, d.y);
  return headFor(world, ctx, sim, fx, fy);
}

/** Follows the cached route; queues a repath when there is none. True if danger blocks the way. */
export function followRoute(world: World, ctx: Context, sim: Sim): boolean {
  if (sim.destination === null) return false;
  const { config, tick, repathQueue, nodes } = world;
  if (sim.route.length === 0) {
    if (!ctx.queued[sim.id] && tick >= sim.nextRepathAt) {
      ctx.queued[sim.id] = 1;
      repathQueue.push(sim.id);
    }
    return lastLeg(world, ctx, sim);
  }
  for (;;) {
    const i = sim.routeIndex;
    if (i >= sim.route.length - 1) return lastLeg(world, ctx, sim);
    const node = sharedNode(world, sim.route[i]!, sim.route[i + 1]!);
    if (node === null) {
      sim.route = [];
      return false;
    }
    const n = nodes[node]!;
    if (Math.hypot(n.x - sim.x, n.y - sim.y) <= config.behaviour.waypointRadius) {
      sim.routeIndex++;
      continue;
    }
    return headFor(world, ctx, sim, n.x, n.y);
  }
}
