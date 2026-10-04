import type { Config } from '../config';
import type { Unit01 } from './state/units';

/**
 * Chance that one adjacent zombie breaches a building on one roll. Integrity sets
 * how breachable the bare building is; fortification divides it. Never zero, and
 * a fortified weak building can outlast a bare strong one.
 */
export function breachChance(integrity: Unit01, fortification: Unit01, config: Config): Unit01 {
  return (config.buildings.breach.base * (1 - integrity)) / (1 + 2 * fortification);
}
