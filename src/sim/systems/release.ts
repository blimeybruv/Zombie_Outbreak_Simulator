// The occupant release: the only code that may read district release state.
//
// At its release tick a district queues a share of each building's residents to
// leave onto ordinary routines. Building processes drain the queue under a per-tick
// cap, and decide what those leaving know: from a building alerted to the outbreak,
// nobody leaves home, and people leave work knowing (buildings.ts). This changes who
// exists, never what anyone decides.
//
// Evacuation is a second release, apart from the first, driven by the district's own
// state rather than the clock: once enough of its buildings know of the outbreak, it
// queues a share of the residents still in each building to leave together, aware
// and for somewhere far off (buildings.ts). The first release gets people onto the
// streets at the start; this one is a neighbourhood deciding to leave.

import type { Context } from '../context';
import { nextInt, roundByChance } from '../rng';
import type { World } from '../state';

/** Draws each district's release tick from the run RNG. Called once at setup. */
export function scheduleRelease(world: World): void {
  const { atTick, jitter } = world.config.release;
  for (const d of world.districts) d.releaseAt = atTick + nextInt(world.rng, -jitter, jitter);
}

export function updateRelease(world: World): void {
  const share = world.config.release.residentShare;
  for (const d of world.districts) {
    if (d.released || world.tick < d.releaseAt) continue;
    d.released = true;
    for (const b of world.buildings) {
      if (b.district !== d.id) continue;
      const queued = b.pendingRelease + b.pendingEvacuate + b.pendingExpel + b.pendingTurn + b.pendingDie;
      b.pendingRelease += Math.min(Math.floor(b.residents * share), Math.max(0, b.residents - queued));
    }
  }
}

/** Districts that have come to know evacuate: `evacuation.threshold` of their buildings alerted. */
export function updateEvacuation(world: World, ctx: Context): void {
  const { config, tick, buildings } = world;
  const ec = config.evacuation;
  if (!config.features.evacuation || tick % ec.interval !== 0) return;
  const total = new Array<number>(world.districts.length).fill(0);
  const alerted = new Array<number>(world.districts.length).fill(0);
  for (const b of buildings) {
    total[b.district]!++;
    if (b.alertedAt !== null) alerted[b.district]!++;
  }
  for (const d of world.districts) {
    if (d.evacuatedAt !== null || total[d.id] === 0 || alerted[d.id]! < ec.threshold * total[d.id]!) continue;
    d.evacuatedAt = tick;
    let x = 0, y = 0, n = 0;
    for (const b of buildings) {
      if (b.district !== d.id) continue;
      const queued = b.pendingRelease + b.pendingEvacuate + b.pendingExpel + b.pendingTurn + b.pendingDie;
      const leaving = roundByChance(world.rng, Math.max(0, b.residents - queued) * ec.share);
      b.pendingEvacuate += leaving;
      if (leaving > 0) {
        x += b.entrances[0]!.x;
        y += b.entrances[0]!.y;
        n++;
      }
    }
    if (n === 0) continue;
    // The first district to go is the one the world outside reacts to: the cordon comes
    // cordon.delay ticks later, and every district after this one meets a sealed road.
    const first = world.noticedAt === null;
    world.noticedAt ??= tick;
    ctx.events.push({ type: 'districtEvacuating', tick, district: d.id, first, sim: null, x: x / n, y: y / n });
  }
}
