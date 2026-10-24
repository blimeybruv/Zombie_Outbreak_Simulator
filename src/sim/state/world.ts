// Everything needed to resume a run exactly. If this serialises and reloads
// identically, the simulation is correct in the sense that matters for testing.
//
// Derived and therefore absent: the spatial hash and street adjacency (rebuilt as
// acceleration structures), time of day (from tick, start hour and day length),
// display phase (from district release state and promotedAt), starting
// population (scenario.population), and the map RNG (consumed during generation).

import type { Config } from '../../config';
import type { RngState } from '../lib/rng';
import type { Building } from './building';
import type { Car } from './car';
import type { Counters } from './counters';
import type { SimEvent } from './events';
import type { Border, District, Exit, Lot, River, Street, StreetNode } from './map';
import type { Archetype, Sim, Weapon } from './sim';
import type { Stimulus } from './stimulus';
import type { CarId, Count, Metres, SimId, Tick, Unit01 } from './units';
import type { Zombie } from './zombie';

/**
 * Where the initial zombies start: enclosed, all in one high-occupancy building (a
 * hospital, office or school); scattered, one each in as many buildings across the
 * city, likelier where more people are; street, people outdoors who have just turned.
 */
export const OUTBREAK_ORIGINS = ['enclosed', 'scattered', 'street'] as const;
export type OutbreakOrigin = (typeof OUTBREAK_ORIGINS)[number];

export const ZOMBIE_GAITS = ['shambler', 'runner'] as const;
export type ZombieGait = (typeof ZOMBIE_GAITS)[number];

/** Settings in front of the viewer (plus the sweep's stalemate switch). Fixed for the run. */
/**
 * An officer on a call who found more than its unit could handle, radioing for SWAT:
 * where, how many it counted, and when. What SWAT acts on is this report — by the time
 * they arrive, it may have grown.
 */
/**
 * A police checkpoint across an exit's road (services/traffic.ts): placed at setup, set
 * when its unit gets there once the cordon closes, fallen when none of its unit is
 * left at it.
 */
export interface Checkpoint {
  /** The exit whose road it stands on. @range exit index @unit index @readBy traffic, snapshot (render) */
  exit: number;
  /** @range 0–3200 @unit m @readBy traffic, squads, snapshot (render) */
  x: Metres;
  /** @range 0–3200 @unit m @readBy traffic, squads, snapshot (render) */
  y: Metres;
  /** Along the road toward the exit. @range unit vector @unit — @readBy squads (the line across it), snapshot (render) */
  dx: number;
  /** @range unit vector @unit — @readBy squads, snapshot (render) */
  dy: number;
  /** The road's width there. @range 6–28 @unit m @readBy snapshot (render) */
  width: Metres;
  /** When its unit got there; null before. @range tick | null @unit tick @readBy traffic, snapshot (render) */
  setAt: Tick | null;
  /** When none of its unit was left at it; null while held, or before. @range tick | null @unit tick @readBy traffic, snapshot (render) */
  fallenAt: Tick | null;
}

export interface Radio {
  /** @range 0–3200 @unit m @readBy squads (SWAT targets) */
  x: Metres;
  /** @range 0–3200 @unit m @readBy squads (SWAT targets) */
  y: Metres;
  /** Zombies the officer counted. @range 1–hundreds @unit zombies @readBy squads (SWAT sizing), ticker copy */
  count: Count;
  /** @range tick @unit tick @readBy squads (staleness) */
  at: Tick;
  /** @range sim id @unit id @readBy ticker */
  from: SimId;
  /** The SWAT leader answering it; null while nobody is. @range sim id | null @unit id @readBy squads (one squad to a call) */
  claimedBy: SimId | null;
}

export interface Scenario {
  /** Starting population; the invariant's right-hand side. @range 100–10,000 @unit people @readBy setup, invariant, promotion trigger */
  population: Count;
  /** Hour of day at tick 0. @range 0–24 @unit hour @readBy setup (occupancy, outdoor share), time of day */
  startHour: number;
  /** @range 3 values @unit enum @readBy setup */
  origin: OutbreakOrigin;
  /** How many of the population have turned at tick 0 (taken from it, so the invariant holds). @range 1–200 @unit zombies @readBy setup */
  initialZombies: Count;
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
  /** Simulated seconds elapsed. @range 0–50,400 @unit tick @readBy everything */
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
  /** Indexed by id; abandoned cars stay where they stopped. @range a few thousand @unit — @readBy car systems, obstacles, render */
  cars: Car[];
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
  /** The empty margin round the city and the feature on each side. @range one per map @unit — @readBy walkability, render */
  border: Border;
  /** A mall's grounds; empty when the map has no mall. @range 0–1 lots @unit — @readBy render */
  lots: Lot[];
  /** Ways off the map (map generation). @range 0–exits.count @unit — @readBy render, leaving (exits.ts), evacuation */
  exits: Exit[];
  /** The bitten who got off the map before turning: counted as evacuated, carrying it out. @range 0–population @unit people @readBy end stats, sweep */
  escapedInfected: Count;
  /** When the world outside noticed: the first district evacuation (release.ts); null until then. @range tick | null @unit tick @readBy cordon, evacuation (first) */
  noticedAt: Tick | null;
  /** 911 calls made so far (dispatch.ts placeCall): all the authorities know of the outbreak's size. @range 0–thousands @unit calls @readBy squads (the call-up order) */
  callsTaken: Count;
  /** When the reservists were called up, once reservists.callUpCalls calls had come in; null until then. @range tick | null @unit tick @readBy squads (mobilise) */
  calledUpAt: Tick | null;
  /** Soldiers who came in from outside to hold the cordon: counted in the leaves like anyone, so the invariant is population + outsiders. @range 0–exits × squads.size @unit people @readBy invariant, cordon, end stats */
  outsiders: Count;
  /** Weapons lying where someone fell outdoors, or was dropped for a better one (systems/fighting/arms.ts), until picked up. @range 0–hundreds @unit — @readBy arms (pickup) */
  drops: { x: Metres; y: Metres; weapon: Weapon; ammo: Count }[];
  /** The exit the rescue comes in by and takes people out of (rescue.ts); null before the sweep. @range exit index | null @unit index @readBy leaving (which exit, the wait for a truck), rescue */
  rescueExit: number | null;
  /** The truck loading at the rescue exit, and when it came; null between trucks. @range car id | null @unit id @readBy rescue */
  rescueTruck: CarId | null;
  /** When the next truck comes, or the one loading leaves. @range tick @unit tick @readBy rescue */
  rescueTruckAt: Tick;
  /** How far up its corridor the rescue company has cleared, at most: what those hiding weigh when deciding whether to answer the broadcast. @range 0–rescue.depth @unit m @readBy rescue (who answers) */
  rescueFront: Metres;
  /** People the rescue's trucks have taken out. @range 0–population @unit people @readBy end stats */
  trucked: Count;
  /** People in the rescue's tents, out of the city, waiting for a truck. @range 0–population @unit people @readBy rescue (trucks), render (the tents) */
  tented: Count;

  /** Active noise. @range 0–hundreds @unit — @readBy zombie hearing, panic, audio */
  stimuli: Stimulus[];
  /** This tick's events only. @range 0–hundreds @unit — @readBy ticker, audio, corpse layer, end stats */
  events: SimEvent[];
  /** Sims awaiting a repath, drained in id order under a per-tick cap. @range sim ids @unit — @readBy sim decisions */
  repathQueue: SimId[];
  /** Police checkpoints, one on each exit's road (services/traffic.ts). @range 0–exits @unit — @readBy traffic, squads, sim decisions, snapshot (render) */
  checkpoints: Checkpoint[];
  /** When the checkpoints were ordered: the first barrier closing; null before. @range tick | null @unit tick @readBy traffic, squads */
  checkpointsAt: Tick | null;
  /** Officers' calls for SWAT, oldest first; dropped once stale. @range 0–dozens @unit — @readBy squads (SWAT targets) */
  radios: Radio[];
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
