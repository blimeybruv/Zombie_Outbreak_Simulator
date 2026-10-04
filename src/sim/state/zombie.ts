// Deliberately minimal: by the end of a run these are most of the population.
//
// One `state` enum replaces the separate dormant / wandering / feeding flags, so
// contradictory combinations cannot be represented. Destroyed zombies stay in
// `world.zombies` so ids remain stable; the array is bounded by starting population.

import type { BuildingId, Metres, Radians, SimId, Tick, Vec2, ZombieId } from './units';

export const ZOMBIE_STATES = ['active', 'dormant', 'wandering', 'feeding', 'occupying', 'destroyed'] as const;
export type ZombieState = (typeof ZOMBIE_STATES)[number];

export interface Zombie {
  /** Array index into `world.zombies`; its own id space, separate from sims. @range 0–population @unit id @readBy everything */
  id: ZombieId;
  /**
   * active: awake, pursuing or drifting. dormant: idle, ticks cheaply. wandering:
   * spontaneously woken, will re-dormant. feeding: stopped on a victim. occupying:
   * inside a building, not on the map. destroyed: killed; terminal.
   * @range 6 values @unit enum @readBy every zombie system, counters, render
   */
  state: ZombieState;
  /** When `wandering` or `feeding` ends; null in other states. @range tick | null @unit tick @readBy zombie decisions */
  stateUntil: Tick | null;
  /** Position. Meaningless while `occupying`; last position once `destroyed`. @range 0–3200 @unit m @readBy spatial hash, movement, combat, render */
  x: Metres;
  /** @range 0–3200 @unit m @readBy spatial hash, movement, combat, render */
  y: Metres;
  /** @range 0–2π @unit rad @readBy movement, flocking alignment, render */
  heading: Radians;
  /** Side it is sliding along an obstacle, held until the way is clear (see Sim.slide). @range -1, 0, 1 @unit side @readBy movement */
  slide: -1 | 0 | 1;
  /** Set only while `occupying`. @range building id | null @unit id @readBy occupier spill, occupation recount */
  insideBuilding: BuildingId | null;
  /** Tracked survivor; null when drifting, flocking or responding to sound. @range sim id | null @unit id @readBy zombie decisions, steering */
  target: SimId | null;
  /** Last tick the target was in sight; drives the 40-tick loss rule. @range tick | null @unit tick @readBy tracking loss */
  targetSeenAt: Tick | null;
  /** Destination from sound or a lost target's last position; a place, not a person. @range 0–3200 each axis | null @unit m @readBy zombie steering */
  heardPoint: Vec2 | null;
  /** @range tick | null @unit tick @readBy sound response (staleness) */
  heardAt: Tick | null;
  /** Earliest tick of the next attack roll (cooldown, staggered by id). @range tick @unit tick @readBy combat */
  nextAttackAt: Tick;
  /** Who this used to be; null for patient zero spawned without a sim. @range sim id | null @unit id @readBy ticker, inspector */
  wasSim: SimId | null;
}
