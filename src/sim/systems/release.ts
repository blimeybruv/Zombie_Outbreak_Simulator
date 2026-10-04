// The occupant release: the only code that may read district release state.
//
// At its release tick a district queues a share of each building's residents to
// leave onto ordinary routines, unaware of the outbreak. Building processes drain
// the queue under a per-tick cap. This changes who exists, never what anyone decides.

import { nextInt } from '../rng';
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
      const queued = b.pendingRelease + b.pendingExpel + b.pendingTurn + b.pendingDie;
      b.pendingRelease += Math.min(Math.floor(b.residents * share), Math.max(0, b.residents - queued));
    }
  }
}
