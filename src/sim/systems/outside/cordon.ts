// The cordon: the world outside sealing the city. Not the city containing itself —
// an outside authority, arriving late, from off the map.
//
//   notice    the first district to evacuate is what the world outside reacts to
//             (release.ts updateEvacuation sets World.noticedAt)
//   arrival   cordon.delay ticks later — enough for that district to get out, not
//             the next: every district after it meets a sealed road — a squad of
//             soldiers comes in at every exit
//             (outsiders: the invariant counts them on top of the population)
//   barrier   each squad walks to its post; when its leader is there, the barrier
//             closes — the highway's last segment is impassable for good, whether or
//             not anyone is left to hold it
//   fire      the soldiers fire at everyone who comes near: a warning shot at anyone
//             within warnRadius of the barrier, aimed fire within fireRadius, to wound
//             or kill (combat.ts cordonFire). There is no screening and no queue
//   warned    a person making for the exit gives it up, for another or for shelter;
//             the less trusting may press on round the barrier along the kerb, under
//             fire, and out at the edge (sims.ts, exits.ts)
//   rescue    at the rescue's exit, once the rescue has come, nobody is fired on:
//             those answering the broadcast wait at the barrier for a truck

import type { Context } from '../../context';
import { admit } from '../../counters';
import { nextInt } from '../../lib/rng';
import { spawnSim } from '../../spawn';
import type { Exit, Sim, Vec2, World } from '../../state';

/** Whether a way out is shut to people on foot: closed by the cordon, and still held. A breached barrier still stops vehicles (cars.ts). */
export function shut(e: Exit): boolean {
  return e.closedAt !== null && e.breachedAt === null;
}

/** The barrier's middle: setback metres in from the edge, across the highway. */
export function barrierAt(world: World, e: Exit): { x: number; y: number } {
  const s = world.config.cordon.setback;
  return { x: e.x - e.dx * s, y: e.y - e.dy * s };
}

/** Where those answering the rescue's broadcast wait for a truck: queueGap metres inside its barrier. */
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

/** Whether a point is within the soldiers' warning distance of an exit's barrier. */
export function nearBarrier(world: World, e: Exit, x: number, y: number): boolean {
  const b = barrierAt(world, e);
  return Math.hypot(x - b.x, y - b.y) <= world.config.cordon.warnRadius;
}

/** Whether the soldiers at exit `i` hold their fire: at the rescue's exit, once the rescue has come, people are waited for, not warned off. */
export function holdsFire(world: World, i: number): boolean {
  return i === world.rescueExit;
}

/** Whether a sim is standing in the rescue's queue (within cordon.queueRadius of it): it waits there for a truck. */
export function inRescueQueue(world: World, sim: Sim): boolean {
  const i = world.rescueExit;
  if (i === null) return false;
  const q = queueAt(world, world.exits[i]!);
  return Math.hypot(q.x - sim.x, q.y - sim.y) <= world.config.cordon.queueRadius;
}

/** A squad of soldiers from outside, at (x, y), its leader bound for `post`: outsiders, counted on top of the population. */
export function spawnSquad(world: World, x: number, y: number, post: Vec2, ammo: number): Sim[] {
  const { config } = world;
  const squad: Sim[] = [];
  for (let i = 0; i < config.squads.size; i++) {
    const s = spawnSim(world, { x, y, insideBuilding: null, sourceTag: 'policeStation', initialPanic: 0, destinationKind: null, aware: true });
    admit(world, 'unturned.outdoors');
    world.outsiders++;
    s.outsider = true;
    s.archetype = 'reservist';
    s.age = nextInt(world.rng, config.cordon.soldierAge[0]!, config.cordon.soldierAge[1]!); // of soldiering age, whatever the profession drawn
    s.muster = 'deployed';
    s.depot = null;
    s.weapon = config.reservists.weapon;
    s.ammo = ammo;
    s.home = null;
    s.church = null;
    s.squadLeader = squad.length === 0 ? s.id : squad[0]!.id;
    s.squadSlot = i;
    if (i === 0) s.post = { x: post.x, y: post.y };
    squad.push(s);
  }
  return squad;
}

/** Soldiers arrive at every exit, once; barriers close as squads reach their posts. Building processes. */
export function updateCordon(world: World, ctx: Context): void {
  const { config, tick, exits, sims } = world;
  const cc = config.cordon;
  if (!config.features.cordon || !config.features.exits) return;
  if (world.noticedAt === null) return;
  if (tick === world.noticedAt + cc.delay) {
    for (const e of exits) {
      const b = barrierAt(world, e);
      const post = { x: b.x + e.dx * cc.post, y: b.y + e.dy * cc.post };
      spawnSquad(world, e.x, e.y, post, cc.ammo);
    }
  }
  // A closed barrier nobody is left to hold (no living soldier within breachRadius) is
  // breached: people on foot walk through, and the street opens to their routes again.
  // Vehicles still stop at the barrier itself (cars.ts). For good: nobody comes to relieve it.
  for (const e of exits) {
    if (e.closedAt === null || e.breachedAt !== null) continue;
    const b = barrierAt(world, e);
    if (sims.some((s) => s.outsider && (s.condition === 'healthy' || s.condition === 'infected') && Math.hypot(s.x - b.x, s.y - b.y) <= cc.breachRadius)) continue;
    e.breachedAt = tick;
    world.streets[e.street]!.blocked = 0;
    ctx.events.push({ type: 'cordonBreached', tick, sim: null, x: b.x, y: b.y });
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
