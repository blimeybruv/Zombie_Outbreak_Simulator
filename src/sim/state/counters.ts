// The eight population leaves. Leaves are updated incrementally at each state
// transition; group totals are derived, never stored. The headless harness
// recounts every leaf from entity state each tick and asserts both that the
// recount matches and that the sum equals the starting population.

import type { Count } from './units';

export interface UnturnedCounters {
  /** Healthy sims on the map. @range 0–population @unit people @readBy invariant, promotion trigger, ticker, end stats */
  outdoors: Count;
  /** Anonymous residents plus healthy tracked sims inside buildings. @range 0–population @unit people @readBy invariant, promotion trigger, end stats */
  indoors: Count;
  /** Died without converting. @range 0–population @unit people @readBy invariant, end stats */
  dead: Count;
  /** Removed from the map by the v2 rescue; always 0 in the demo. @range 0–population @unit people @readBy invariant, end stats */
  rescued: Count;
}

export interface TurnedCounters {
  /**
   * Bitten sims not yet converted, wherever they are. Accounting puts them here;
   * the roster and other sims still see a living survivor.
   * @range 0–population @unit people @readBy invariant, end stats
   */
  symptomatic: Count;
  /** Zombies on the map: active, dormant, wandering or feeding. @range 0–population @unit zombies @readBy invariant, stalemate controller, end stats */
  outdoors: Count;
  /** Zombies inside buildings, de-instantiated. @range 0–population @unit zombies @readBy invariant, end stats */
  occupying: Count;
  /** Killed. @range 0–population @unit zombies @readBy invariant, end stats */
  destroyed: Count;
}

export interface Counters {
  /** @range see UnturnedCounters @unit people @readBy invariant, end stats */
  unturned: UnturnedCounters;
  /** @range see TurnedCounters @unit people @readBy invariant, end stats */
  turned: TurnedCounters;
}

export function unturnedTotal(c: Counters): Count {
  return c.unturned.outdoors + c.unturned.indoors + c.unturned.dead + c.unturned.rescued;
}

export function turnedTotal(c: Counters): Count {
  return c.turned.symptomatic + c.turned.outdoors + c.turned.occupying + c.turned.destroyed;
}

/** Must equal the starting population on every tick. */
export function populationTotal(c: Counters): Count {
  return unturnedTotal(c) + turnedTotal(c);
}

export function emptyCounters(): Counters {
  return {
    unturned: { outdoors: 0, indoors: 0, dead: 0, rescued: 0 },
    turned: { symptomatic: 0, outdoors: 0, occupying: 0, destroyed: 0 },
  };
}
