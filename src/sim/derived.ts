// Quantities computed from state rather than stored, for the fields that would
// otherwise have been a second source of truth.

import type { Config } from '../config';
import type { Scenario } from './state/world';
import type { Tick, Unit01 } from './state/units';

/** 0 midnight, 0.5 noon. Compressed: one cycle every `config.time.dayLength` ticks. */
export function timeOfDay(tick: Tick, scenario: Scenario, config: Config): Unit01 {
  const t = scenario.startHour / 24 + tick / config.time.dayLength;
  return t - Math.floor(t);
}

/**
 * Confidence in a remembered observation. `halfLife` is a true half-life: an
 * observation that old is believed at 0.5.
 */
export function confidence(observedAt: Tick, tick: Tick, config: Config): Unit01 {
  const age = Math.max(0, tick - observedAt);
  return Math.exp((-Math.LN2 * age) / config.memory.halfLife);
}
