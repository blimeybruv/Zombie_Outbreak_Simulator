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

/** Index of the occupancy band (night, morning, afternoon, evening) containing an hour of day. */
export function bandForHour(hour: number, config: Config): number {
  const starts = config.time.bandStartHours;
  let band = 0;
  for (let i = 0; i < starts.length; i++) if (hour >= starts[i]!) band = i;
  return band;
}

/** 1 in full daylight, 0 at night, ramping linearly across each twilight. */
export function daylight(tod: Unit01, config: Config): Unit01 {
  const { sunrise, sunset, twilight } = config.time;
  const half = twilight / 2;
  if (tod < sunrise - half || tod > sunset + half) return 0;
  if (tod < sunrise + half) return (tod - (sunrise - half)) / twilight;
  if (tod > sunset - half) return ((sunset + half) - tod) / twilight;
  return 1;
}
