import type { Config } from '../config';
import type { Unit01 } from './state/units';

/**
 * Chance that one zombie in a crowd big enough to try (fortification stages) breaches
 * a building on one roll: fortification divides it, never to zero. Integrity is not
 * here: it caps the stage a building can reach (stageOf).
 */
export function breachChance(fortification: Unit01, config: Config): Unit01 {
  return config.buildings.breach.base / (1 + 2 * fortification);
}
