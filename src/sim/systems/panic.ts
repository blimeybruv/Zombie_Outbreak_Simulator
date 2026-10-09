// Panic: rise, decay and the mode it gates. One of three files allowed to read
// `panic` (lint-enforced). Everything else reads the mode, never the scalar.
//
//   informed  0 – memoryCutoff         routes with the full memory cost function
//   direct    memoryCutoff – routing   routes, ignores memory (shortest path)
//   flight    above routingCutoff      no pathfinding; steers away, takes any door
//
// Police are immune: panic never gates their mode.

import type { Config } from '../../config';
import { isOutdoorLiving, type Context } from '../context';
import { clamp01 } from '../geometry';
import type { Sim, World } from '../state';
import { intensityAt } from './stimuli';

export type Mode = 'informed' | 'direct' | 'flight';

export function modeOf(sim: Sim, config: Config): Mode {
  if (config.archetypes[sim.archetype].panicImmune) return 'informed';
  if (sim.panic > config.panic.routingCutoff) return 'flight';
  if (sim.panic > config.panic.memoryCutoff) return 'direct';
  return 'informed';
}

/** Panic rises from conversions witnessed last tick and from new noise; it decays every tick. */
export function updatePanic(world: World, ctx: Context): void {
  const { config, tick, sims } = world;
  const pc = config.panic;
  const conversions = world.events.filter((e) => e.type === 'simTurned');
  const noises = world.stimuli.filter((s) => s.createdAt === tick - 1);

  for (const sim of sims) {
    if (sim.condition !== 'healthy' && sim.condition !== 'infected') continue;
    sim.panic += (0 - sim.panic) * pc.decayRate;
    if (!isOutdoorLiving(sim)) continue;

    const r = ctx.radius[sim.id]!;
    for (const e of conversions) {
      if (e.sim === sim.id) continue;
      if (Math.hypot(e.x - sim.x, e.y - sim.y) > r) continue;
      if (!ctx.map.lineOfSight(sim.x, sim.y, e.x, e.y)) continue;
      sim.panic = clamp01(sim.panic + pc.risePerEvent);
      sim.history.conversionsWitnessed++;
      sim.awareAt ??= tick;
    }
    for (const s of noises) {
      if (intensityAt(s, sim.x, sim.y) < pc.noiseIntensityFloor) continue;
      sim.panic = clamp01(sim.panic + pc.risePerEvent);
      sim.awareAt ??= tick; // gunfire, or someone shouting a warning
    }
  }
}
