// Panic: rise, decay and the mode it gates. One of three files allowed to read
// `panic` (lint-enforced). Everything else reads the mode, never the scalar.
//
//   informed  0 – memoryCutoff         routes with the full memory cost function
//   direct    memoryCutoff – routing   routes, ignores memory (shortest path)
//   flight    above routingCutoff      no pathfinding; steers away, takes any door
//
// Police and soldiers from outside are immune: panic never gates their mode.

import type { Config } from '../../config';
import { isOutdoorLiving, type Context } from '../context';
import { clamp01 } from '../geometry';
import { noteStreet } from '../memory';
import type { Sim, World } from '../state';
import { intensityAt } from './stimuli';

export type Mode = 'informed' | 'direct' | 'flight';

export function modeOf(sim: Sim, config: Config): Mode {
  if (config.archetypes[sim.archetype].panicImmune || sim.outsider) return 'informed'; // police, and soldiers from outside
  // A squad does not scatter: its members follow the leader's route and fall back as a
  // unit, so panic never takes one into flight (where it would stop shooting just as the
  // dead close in). Its nerve can still go when cornered (breaks, nerve.floor).
  if (sim.panic > config.panic.routingCutoff) return sim.squadLeader !== null ? 'direct' : 'flight';
  if (sim.panic > config.panic.memoryCutoff) return 'direct';
  return 'informed';
}

/** Panic rises from conversions witnessed last tick, from new noise and from people running this way; it decays every tick. */
/**
 * Has its nerve gone? Panic past its nerve (held up to nerve.floor for those trained
 * to it), steadied by calm company beside it (`company`, from the perception snapshot:
 * ctx.company). The one question about panic that cornered, blocked and exhausted sims
 * ask. Company counts only the calm — a crowd running steadies nobody — and it raises
 * the threshold at the moment of the test, never damps a rise in panic.
 */
export function breaks(sim: Sim, config: Config, company: number): boolean {
  if (config.archetypes[sim.archetype].panicImmune || sim.outsider) return false; // trained soldiers from outside hold
  const cc = config.company;
  const steadied = config.features.company && company > 0 ? cc.nerve * sim.sociality * (Math.min(company, cc.cap) / cc.cap) : 0;
  return sim.panic > Math.max(sim.nerve, config.nerve.floor[sim.archetype] ?? 0) + steadied;
}

export function updatePanic(world: World, ctx: Context): void {
  const { config, tick, sims } = world;
  const pc = config.panic;
  const conversions = world.events.filter((e) => e.type === 'simTurned');
  const noises = world.stimuli.filter((s) => s.createdAt === tick - 1);

  for (const sim of sims) {
    if (sim.condition !== 'healthy' && sim.condition !== 'infected') continue;
    sim.panic += (0 - sim.panic) * pc.decayRate;
    // Unease fades, and while it lasts holds panic up a little: the uneasy startle sooner.
    if (config.features.unease && sim.awareAt === null && sim.unease > 0) {
      const uc = config.unease;
      sim.unease += (0 - sim.unease) * uc.decay;
      const floor = sim.unease * uc.panicFloor;
      if (sim.panic < floor) sim.panic += (floor - sim.panic) * uc.panicFloorRate;
    }
    if (!isOutdoorLiving(sim)) continue;
    const r = ctx.radius[sim.id]!;
    for (const e of conversions) {
      if (e.sim === sim.id) continue;
      if (Math.hypot(e.x - sim.x, e.y - sim.y) > r) continue;
      if (!ctx.map.lineOfSight(sim.x, sim.y, e.x, e.y)) continue;
      sim.panic = clamp01(sim.panic + pc.risePerEvent);
      sim.history.conversionsWitnessed++;
      sim.awareAt ??= tick;
      // Someone turned there: the street remembers it, whatever walks it next.
      const street = ctx.map.nearestStreet(e.x, e.y, config.map.offStreetLookup);
      if (street !== null) noteStreet(world, sim, street, config.memory.witnessedDanger);
    }
    // Contagion: a crowd running this way frightens, toward how many and how close.
    const target = Math.min(1, ctx.fleeingSeen[sim.id]! * config.crowd.fleeingGain);
    if (target > sim.panic) sim.panic += (target - sim.panic) * config.crowd.fleeingRate;
    const uc = config.unease;
    const unaware = config.features.unease && sim.awareAt === null;
    // Swept along without knowing why: unsettled, never knowing.
    if (unaware && target * uc.fleeingShare > sim.unease) sim.unease += (target * uc.fleeingShare - sim.unease) * config.crowd.fleeingRate;
    for (const s of noises) {
      if (s.kind === 'engine' || s.kind === 'alarm' || s.kind === 'siren') continue; // an engine, an alarm, a siren: not news, and frightens nobody
      const i = intensityAt(s, sim.x, sim.y);
      // A shout frightens; what it means is for the encounters step (hearWarnings).
      if (i >= pc.noiseIntensityFloor) {
        sim.panic = clamp01(sim.panic + pc.risePerEvent);
        if (s.kind !== 'shout') sim.awareAt ??= tick; // gunfire close enough to know for what it is
      } else if (i > 0 && unaware && s.kind !== 'shout') {
        sim.unease += (1 - sim.unease) * uc.distantNoise; // gunfire, far off
      }
    }
  }
}
