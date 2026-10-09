// Everything needed to resume a run exactly. If this serialises and reloads
// identically, the simulation is correct in the sense that matters for testing.
//
// Derived and therefore absent: the spatial hash and street adjacency (rebuilt as
// acceleration structures), time of day (from tick, start hour and day length),
// display phase (from district release state and promotedAt), starting
// population (scenario.population), and the map RNG (consumed during generation).

import type { Config } from '../../config';
import type { RngState } from '../rng';
import type { Building } from './building';
import type { Counters } from './counters';
import type { SimEvent } from './events';
import type { District, River, Street, StreetNode } from './map';
import type { Archetype, Sim } from './sim';
import type { Stimulus } from './stimulus';
import type { Count, SimId, Tick, Unit01 } from './units';
import type { Zombie } from './zombie';

export const OUTBREAK_ORIGINS = ['enclosed', 'street', 'multiple'] as const;
export type OutbreakOrigin = (typeof OUTBREAK_ORIGINS)[number];

export const ZOMBIE_GAITS = ['shambler', 'runner'] as const;
export type ZombieGait = (typeof ZOMBIE_GAITS)[number];

/** Settings in front of the viewer (plus the sweep's stalemate switch). Fixed for the run. */
export interface Scenario {
  /** Starting population; the invariant's right-hand side. @range 100–10,000 @unit people @readBy setup, invariant, promotion trigger */
  population: Count;
  /** Hour of day at tick 0. @range 0–24 @unit hour @readBy setup (occupancy, outdoor share), time of day */
  startHour: number;
  /** @range 3 values @unit enum @readBy setup */
  origin: OutbreakOrigin;
  /** Share of each archetype; sums to 1. @range 0–1 each @unit fraction @readBy setup */
  archetypeMix: Record<Archetype, Unit01>;
  /** @range 2 values @unit enum @readBy zombie movement */
  zombieGait: ZombieGait;
  /** Street and interior lighting on or off for the whole run. @range true/false @unit — @readBy setup (lit flags) */
  power: boolean;
  /** Seeds the map generator. Held fixed across a sweep. @range 0–2^32-1 @unit seed @readBy setup */
  mapSeed: number;
  /** Seeds the simulation RNG. Varied across a sweep. @range 0–2^32-1 @unit seed @readBy setup */
  runSeed: number;
  /** On for viewing, off for measuring. @range true/false @unit — @readBy stalemate controller */
  stalemateController: boolean;
}

export interface World {
  /** Simulated seconds elapsed. @range 0–36,000 @unit tick @readBy everything */
  tick: Tick;
  /** The run RNG (from runSeed); its state is part of the snapshot. @range 4 × uint32 @unit — @readBy every random draw in sim/ */
  rng: RngState;
  /** @range see Scenario @unit — @readBy setup, invariant, time of day */
  scenario: Scenario;
  /** Every tuning parameter. @range see config.ts @unit — @readBy everything in sim/ */
  config: Config;

  /** Indexed by id. @range 0–population @unit — @readBy everything */
  sims: Sim[];
  /** Indexed by id; destroyed zombies stay in place. @range 0–population @unit — @readBy everything */
  zombies: Zombie[];
  /** Indexed by id. @range ~1,000–3,000 @unit — @readBy everything */
  buildings: Building[];
  /** Indexed by id. @range a few thousand @unit — @readBy pathfinding, perception, memory, render */
  streets: Street[];
  /** Indexed by id. @range a few thousand @unit — @readBy pathfinding, steering, render */
  nodes: StreetNode[];
  /** Indexed by id; a 3×3 grid. @range 9 @unit — @readBy release, ticker, render */
  districts: District[];
  /** The river; bridges are streets with terrain `bridge`. @range one polygon @unit — @readBy steering, render */
  river: River;

  /** Active noise. @range 0–hundreds @unit — @readBy zombie hearing, panic, audio */
  stimuli: Stimulus[];
  /** This tick's events only. @range 0–hundreds @unit — @readBy ticker, audio, corpse layer, end stats */
  events: SimEvent[];
  /** Sims awaiting a repath, drained in id order under a per-tick cap. @range sim ids @unit — @readBy sim decisions */
  repathQueue: SimId[];
  /** Promoted survivors in promotion order; append-only, never shrinks. @range 0–promotion.rosterCap sim ids @unit — @readBy roster UI, ticker, salience */
  roster: SimId[];
  /** @range see Counters @unit people @readBy invariant, promotion trigger, stalemate, end stats */
  counters: Counters;
  /**
   * Anonymous residents who died in a breach. They never had a Sim record, so this
   * is the only trace the full recount can count them from.
   * @range 0–population @unit people @readBy invariant recount, end stats
   */
  residentDeaths: Count;

  /** Last tick any sim converted; the stalemate controller's clock. @range tick | null @unit tick @readBy stalemate controller */
  lastConversionAt: Tick | null;
  /** When the provisional roster was named; null before. @range tick | null @unit tick @readBy promotion, display phase */
  promotedAt: Tick | null;
  /** When the roster was first re-scored and topped up; null before. Later top-ups follow on a fixed cadence from it. @range tick | null @unit tick @readBy promotion */
  rescoredAt: Tick | null;
}
