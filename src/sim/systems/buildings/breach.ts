import type { Config } from '../../../config';
import type { Unit01 } from '../../state/units';

/**
 * How much fortification a door loses a tick to `n` of the dead at it (the user's
 * design): one wears it down slowly, two faster, a throng much faster (as n^crowd), and
 * the building's integrity — how defensible it is — slows it, as (1 − integrity)^weakness.
 * Steady, not asymptotic: it reaches 0, and only at 0 do the dead break in (the user's
 * call, an exception to the asymptotic rule like supplies).
 */
export function doorDamage(n: number, integrity: Unit01, config: Config): number {
  if (n <= 0) return 0;
  const d = config.buildings.door;
  return d.rate * n ** d.crowd * (1 - integrity) ** d.weakness;
}

/**
 * How far a building can be fortified: integrity caps it as it caps the stage — a
 * supermarket to reinforcedAt (barricaded however much work goes in), an office to
 * fortifiedAt, a house or better all the way.
 */
export function fortificationCap(integrity: Unit01, config: Config): Unit01 {
  const st = config.buildings.stages;
  return integrity >= st.fortifiableFrom ? 1 : integrity >= st.reinforcibleFrom ? st.fortifiedAt : st.reinforcedAt;
}
