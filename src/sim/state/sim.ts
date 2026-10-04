// A living person. Zombies are a separate entity (zombie.ts), not a Sim with a flag.
//
// Every field carries @range, @unit and @readBy; tests/state-gate.test.ts enforces it.
// Quantities derived from other state are deliberately absent:
//   speed           — gait, stamina, age and drag (Movement)
//   perceptionRadius — the street the sim stands on and time of day (Perception)
//   perceivedThreat — recomputed each tick into the perception snapshot
//   ticksSurvived   — (history.endedAt ?? tick) - history.spawnedAt
//   ticksAlone      — tick - history.lastCompanyAt
//   promoted        — name !== null

import type { BuildingId, Count, Metres, Radians, SimId, StreetId, Tick, Unit01, Vec2 } from './units';

export const ARCHETYPES = ['civilian', 'police', 'hunkerDown', 'loner', 'reckless'] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/** Display labels. Assigned at spawn from the starting building's tag; bias the archetype. */
export const PROFESSIONS = [
  // civilian profile
  'officeWorker', 'retailAssistant', 'teacher', 'deliveryDriver', 'student', 'chef',
  'cleaner', 'bartender', 'mechanic', 'courier', 'receptionist', 'barista',
  // police profile
  'patrolOfficer', 'detective', 'securityGuard', 'paramedic', 'firefighter',
  // hunker-down profile
  'retiree', 'parent', 'librarian', 'accountant', 'nurse', 'nightShiftWorker', 'caretaker',
  // loner profile
  'nightCleaner', 'longHaulDriver', 'groundskeeper', 'homeless', 'tourist',
  // reckless profile
  'offDutySoldier', 'hunter', 'bouncer', 'amateurSurvivalist', 'drunk',
] as const;
export type Profession = (typeof PROFESSIONS)[number];

/**
 * Whether the person is alive and whether they carry the infection. Location is
 * separate (`insideBuilding`). `turned` keeps the record after conversion so ids,
 * history and the ticker's "who this used to be" survive.
 *
 * Nothing may read another sim's condition to learn whether it is infected —
 * that knowledge travels only through `knownInfected`.
 */
export const CONDITIONS = ['healthy', 'infected', 'dead', 'turned'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const GAITS = ['still', 'sneak', 'walk', 'run', 'sprint'] as const;
export type Gait = (typeof GAITS)[number];

export const DESTINATION_KINDS = ['routine', 'shelter', 'scavenge', 'regroup'] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export const ROLES = ['builder', 'scavenger', 'dispatcher'] as const;
export type Role = (typeof ROLES)[number];

export const WEAPONS = ['pistol', 'smg', 'shotgun', 'knife', 'club', 'sledgehammer'] as const;
export type Weapon = (typeof WEAPONS)[number];

/** One remembered observation of a street. Merged by recency on encounter. */
export interface StreetBelief {
  /**
   * `perceivedThreat` at the moment of observation. Never decays; confidence is
   * derived from age instead.
   * @range 0–1 @unit scalar @readBy pathfinding cost, shelter desirability
   */
  danger: Unit01;
  /** @range 0–21,600 @unit tick @readBy confidence, encounter merge (newer wins) */
  observedAt: Tick;
  /**
   * Set only by this sim's own observation, never copied by a merge, so the
   * distinct-streets history counter counts places actually visited.
   * @range true/false @unit — @readBy history (streetsVisited)
   */
  visited: boolean;
}

/** One remembered observation of a building. Merged by recency on encounter. */
export interface BuildingBelief {
  /**
   * Visible fill, which looks identical for residents and occupying zombies.
   * @range 0–400 @unit people @readBy shelter desirability (groupTerm)
   */
  believedOccupants: Count;
  /** @range 0–60 @unit materials @readBy shelter desirability, scavenger target choice */
  materials: Count;
  /** @range 0–1 @unit scalar @readBy shelter desirability */
  fortification: Unit01;
  /** @range 0–21,600 @unit tick @readBy confidence, encounter merge (newer wins) */
  observedAt: Tick;
  /**
   * Set only when this sim itself entered the building; never copied by a merge.
   * @range true/false @unit — @readBy history (buildingsEntered)
   */
  visited: boolean;
}

/** Accrues from spawn on every sim. Read by promotion scoring and end-of-run statistics. */
export interface SimHistory {
  /** @range 0–21,600 @unit tick @readBy ticksSurvived, promotion, end stats */
  spawnedAt: Tick;
  /** Tick the sim died or turned; null while alive. @range 0–21,600 | null @unit tick @readBy ticksSurvived, end stats */
  endedAt: Tick | null;
  /** Last tick another sim was within encounter range. @range 0–21,600 @unit tick @readBy ticksAlone, promotion */
  lastCompanyAt: Tick;
  /** @range 0–2,000 @unit conversions @readBy promotion, panic, backstory */
  conversionsWitnessed: Count;
  /** Distinct buildings entered. @range 0–buildings @unit buildings @readBy promotion, backstory */
  buildingsEntered: Count;
  /** Distinct streets visited. @range 0–streets @unit streets @readBy promotion, backstory */
  streetsVisited: Count;
  /** In zombie contact range and survived it. @range 0–21,600 @unit events @readBy promotion, backstory */
  nearMisses: Count;
  /** @range 0–2,000 @unit zombies @readBy promotion, end stats (highest kills) */
  kills: Count;
  /** Total carried into a shelter. @range 0–∞ @unit materials @readBy promotion, end stats */
  materialsDelivered: Count;
}

export interface Sim {
  // Identity

  /** Array index into `world.sims`; also the deterministic tiebreak. @range 0–population @unit id @readBy everything */
  id: SimId;
  /** @range 5 values @unit enum @readBy all behaviour (thresholds and weights), render */
  archetype: Archetype;
  /** @range ~34 labels @unit enum @readBy inspector, ticker, backstory */
  profession: Profession;
  /** @range 16–85 @unit years @readBy movement (ageFactor), shelter preference, inspector */
  age: number;
  /**
   * Per-sim, orthogonal to archetype.
   * @range 0–1 @unit scalar @readBy migration (requiredDelta), promotion, end stats (caution band)
   */
  caution: Unit01;
  /** @range 4 values @unit enum @readBy counters, every system that skips the dead, render */
  condition: Condition;
  /** Assigned at promotion; null until then. @range wordlist | null @unit — @readBy roster, ticker, labels */
  name: string | null;

  // Physical

  /** Frozen at the entrance used while indoors; where the sim reappears. @range 0–3200 @unit m @readBy spatial hash, movement, perception, render */
  x: Metres;
  /** @range 0–3200 @unit m @readBy spatial hash, movement, perception, render */
  y: Metres;
  /** Facing; decisions set it, movement integrates along it. @range 0–2π @unit rad @readBy movement, render (trails) */
  heading: Radians;
  /**
   * Which way the sim is sliding along an obstacle: -1 or 1, or 0 when its way is
   * clear. Kept until the direct path opens, so it follows a wall instead of
   * flipping sides every tick.
   * @range -1, 0, 1 @unit side @readBy movement
   */
  slide: -1 | 0 | 1;
  /** @range 5 values @unit enum @readBy movement (speed), stamina, detectability, noise */
  gait: Gait;
  /** @range 0–1 @unit scalar @readBy movement (effectiveSpeed), gait selection */
  stamina: Unit01;
  /** Null when outdoors. @range building id | null @unit id @readBy spatial hash, ticking, counters, combat */
  insideBuilding: BuildingId | null;
  /**
   * Street the sim stood on at its last observation; null off-street or indoors.
   * Kept while the sim stays within half the street's width of its centreline.
   * @range street id | null @unit id @readBy perception (radius, lighting), memory writes on entering a street
   */
  street: StreetId | null;
  /** Tick an in-progress exit completes (fortification * 40 ticks); null when not leaving. @range tick | null @unit tick @readBy building processes */
  exitingUntil: Tick | null;

  // Perception and belief

  /** @range 0–1 @unit scalar @readBy panic gating only: routing mode, memory use, expulsion */
  panic: Unit01;
  /** Beliefs about streets, keyed by street id. Bounded by streets seen. @range ~20 entries @unit — @readBy pathfinding, shelter desirability, encounter merge */
  streetMemory: Map<StreetId, StreetBelief>;
  /** Beliefs about buildings, keyed by building id. Bounded by buildings seen. @range ~20–30 entries @unit — @readBy shelter selection, migration, scavenging, encounter merge */
  buildingMemory: Map<BuildingId, BuildingBelief>;
  /**
   * Sims this sim believes are infected: written on personally seeing a bite,
   * merged by union on encounter.
   * @range 0–population ids @unit — @readBy shelter admission, encounter merge
   */
  knownInfected: Set<SimId>;
  /** Rate-limits proximity merges. @range tick @unit tick @readBy encounters */
  lastMergeAt: Tick;

  // Movement intent

  /** Null when fleeing or idle. @range 0–3200 each axis | null @unit m @readBy steering, pathfinding */
  destination: Vec2 | null;
  /** @range 4 values | null @unit enum @readBy gait selection, role logic, arrival handling */
  destinationKind: DestinationKind | null;
  /** Building being walked to (routine stop, shelter, scavenge target); null for a bare point. @range building id | null @unit id @readBy arrival handling, entrance choice */
  destinationBuilding: BuildingId | null;
  /** Street ids; empty when steering rather than routing. @range street ids @unit — @readBy steering, repath relevance check */
  route: StreetId[];
  /** @range 0–route.length @unit index @readBy steering */
  routeIndex: number;
  /** Earliest tick a repath may run (cooldown). @range tick @unit tick @readBy repath gating */
  nextRepathAt: Tick;
  /** Routine idle at a stop ends here; null when not idling. @range tick | null @unit tick @readBy routine behaviour */
  idleUntil: Tick | null;
  /**
   * Keeps avoiding until this tick after a threat drops out of sight, so a zombie
   * flickering at the edge of view does not flip the sim between fleeing and its
   * route every tick. Null when not avoiding.
   * @range tick | null @unit tick @readBy sim decisions
   */
  avoidUntil: Tick | null;
  /** The last building that turned this sim away (occupied, or someone inside knew it was bitten); never chosen again as a door or shelter. @range building id | null @unit id @readBy door and shelter choice */
  refusedBy: BuildingId | null;

  // Carried

  /** Null when unarmed. @range 6 values | null @unit enum @readBy combat, engagement capacity, inspector */
  weapon: Weapon | null;
  /** Zero makes a firearm dead weight. @range 0–30 @unit rounds @readBy combat, engagement capacity */
  ammo: Count;
  /** Capped so one trip cannot resupply a shelter. @range 0–8 @unit materials @readBy delivery, role logic */
  materials: Count;
  /** Earliest tick the next attack may be made (weapon cooldown). @range tick @unit tick @readBy combat */
  nextAttackAt: Tick;

  // Infection

  /** Conversion tick, set on a bite to tick + 20–40; null when not infected. @range tick | null @unit tick @readBy conversion */
  turnsAt: Tick | null;

  // Shelter

  /** Building this sim has committed to; re-evaluated only on breach, fall, decay or migration. @range building id | null @unit id @readBy shelter return, roles, migration */
  shelter: BuildingId | null;
  /** @range 3 values | null @unit enum @readBy building processes, role re-evaluation */
  role: Role | null;
  /** @range tick @unit tick @readBy role re-evaluation (prevents thrashing) */
  roleSince: Tick;
  /** Null if never migrated. @range tick | null @unit tick @readBy migration cooldown */
  lastMigratedAt: Tick | null;

  /** Inline for now; a parallel id-indexed structure is a later option if profiling asks. @range see SimHistory @unit — @readBy promotion, end stats */
  history: SimHistory;
}
