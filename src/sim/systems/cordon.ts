// The cordon: the world outside sealing the city. Not the city containing itself —
// an outside authority, arriving late, from off the map.
//
//   notice    the world outside notices the people arriving at its edge: once
//             cordon.noticeAfter have left the city by its exits (World.noticedAt)
//   arrival   cordon.delay ticks later — enough for the first wave to get out, not
//             the rest: the barrier closes while the evacuation is still arriving —, a squad of soldiers comes in at every exit
//             (outsiders: the invariant counts them on top of the population)
//   barrier   each squad walks to its post; when its leader is there, the barrier
//             closes — the highway's last segment is impassable for good, whether or
//             not anyone is left to hold it
//   the queue those making for it stop short of it and wait, believing they will be
//             screened and let through (nobody is: there is no screening); they give
//             it up one by one, as their patience runs out (exits.ts, sims.ts)
//   the flank some, the less trusting, try to get round instead, along the kerb past
//             the barrier's end and out at the edge. Whether the unit there fires on
//             them is its own, drawn when it arrives and never shown: you find out
//             when someone tries (combat.ts cordonFire)

import type { Context } from '../context';
import { admit } from '../counters';
import { chance } from '../rng';
import { spawnSim } from '../spawn';
import type { Exit, Sim, Vec2, World } from '../state';

/** The barrier's middle: setback metres in from the edge, across the highway. */
export function barrierAt(world: World, e: Exit): { x: number; y: number } {
  const s = world.config.cordon.setback;
  return { x: e.x - e.dx * s, y: e.y - e.dy * s };
}

/** Where those who mean to leave by it wait: queueGap metres inside the barrier. */
export function queueAt(world: World, e: Exit): { x: number; y: number } {
  const b = barrierAt(world, e);
  const g = world.config.cordon.queueGap;
  return { x: b.x - e.dx * g, y: b.y - e.dy * g };
}

/**
 * Getting round a closed barrier on one side of the road: `beside`, on the kerb level
 * with the barrier's end, then `out`, on the same kerb at the edge of the map.
 */
export function flank(world: World, e: Exit, side: 1 | -1): { beside: Vec2; out: Vec2 } {
  const w = world.streets[e.street]!.width / 2 + world.config.cordon.kerb;
  const nx = -e.dy * side * w, ny = e.dx * side * w;
  const b = barrierAt(world, e);
  return { beside: { x: b.x + nx, y: b.y + ny }, out: { x: e.x + nx, y: e.y + ny } };
}

/** How far past the barrier, outward along the road, a point is (negative inside it). */
export function pastBarrier(world: World, e: Exit, x: number, y: number): number {
  const b = barrierAt(world, e);
  return (x - b.x) * e.dx + (y - b.y) * e.dy;
}

/** The closed exit whose queue a sim is standing in (within cordon.queueRadius), and has not given up on; or null. */
export function atClosedExit(world: World, sim: Sim): number | null {
  for (let i = 0; i < world.exits.length; i++) {
    const e = world.exits[i]!;
    if (e.closedAt === null || sim.knownClosed & (1 << i)) continue;
    const q = queueAt(world, e);
    if (Math.hypot(q.x - sim.x, q.y - sim.y) <= world.config.cordon.queueRadius) return i;
  }
  return null;
}

/** Soldiers arrive at every exit, once; barriers close as squads reach their posts. Building processes. */
export function updateCordon(world: World, ctx: Context): void {
  const { config, tick, exits, sims } = world;
  const cc = config.cordon;
  if (!config.features.cordon || !config.features.exits) return;
  if (world.noticedAt === null && world.counters.unturned.evacuated >= cc.noticeAfter) world.noticedAt = tick;
  if (world.noticedAt === null) return;
  if (tick === world.noticedAt + cc.delay) {
    for (const e of exits) {
      const b = barrierAt(world, e);
      const post = { x: b.x + e.dx * cc.post, y: b.y + e.dy * cc.post };
      let leader = -1;
      const fires = chance(world.rng, cc.fireShare); // the unit's, not the soldier's
      for (let i = 0; i < config.squads.size; i++) {
        const s = spawnSim(world, { x: e.x, y: e.y, insideBuilding: null, sourceTag: 'policeStation', initialPanic: 0, destinationKind: null, aware: true });
        admit(world, 'unturned.outdoors');
        world.outsiders++;
        s.outsider = true;
        s.archetype = 'reservist';
        s.muster = 'deployed';
        s.weapon = config.reservists.weapon;
        s.ammo = cc.ammo;
        s.home = null;
        s.church = null;
        if (leader < 0) leader = s.id;
        s.squadLeader = leader as typeof s.id;
        s.squadSlot = i;
        s.firesOnCrossers = fires;
        if (i === 0) s.post = post;
      }
    }
  }
  for (const e of exits) {
    if (e.closedAt !== null) continue;
    const b = barrierAt(world, e);
    const post = { x: b.x + e.dx * cc.post, y: b.y + e.dy * cc.post };
    const held = sims.some((s) => s.post !== null && s.outsider && (s.condition === 'healthy' || s.condition === 'infected') && Math.hypot(s.x - post.x, s.y - post.y) <= cc.postReach);
    if (!held) continue;
    e.closedAt = tick;
    world.streets[e.street]!.blocked = 1;
    ctx.events.push({ type: 'cordonClosed', tick, sim: null, x: b.x, y: b.y });
  }
}
