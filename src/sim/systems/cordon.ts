// The cordon: the world outside sealing the city. Not the city containing itself —
// an outside authority, arriving late, from off the map.
//
//   notice    the first officer to radio for SWAT is the city asking for help; the
//             world outside notices (radioForSwat sets World.noticedAt)
//   arrival   cordon.delay ticks later, a squad of soldiers comes in at every exit
//             (outsiders: the invariant counts them on top of the population)
//   barrier   each squad walks to its post; when its leader is there, the barrier
//             closes — the highway's last segment is impassable for good, whether or
//             not anyone is left to hold it
//   the queue those making for it stop short of it and wait, believing they will be
//             screened and let through (nobody is: there is no screening); they give
//             it up one by one, as their patience runs out (exits.ts, sims.ts)

import type { Context } from '../context';
import { admit } from '../counters';
import { spawnSim } from '../spawn';
import type { Exit, World } from '../state';

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

/** Soldiers arrive at every exit, once; barriers close as squads reach their posts. Building processes. */
export function updateCordon(world: World, ctx: Context): void {
  const { config, tick, exits, sims } = world;
  const cc = config.cordon;
  if (!config.features.cordon || !config.features.exits || world.noticedAt === null) return;
  if (tick === world.noticedAt + cc.delay) {
    for (const e of exits) {
      const b = barrierAt(world, e);
      const post = { x: b.x + e.dx * cc.post, y: b.y + e.dy * cc.post };
      let leader = -1;
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
