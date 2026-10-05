// Messages between the main thread and the simulation worker.
//
// The worker owns the World and the clock; the main thread only ever sees
// snapshots. Positions travel as typed arrays (transferred, not copied), so the
// renderer cannot write simulation state even by accident: it never holds any.

import type { Counters, SimEvent } from '../sim/state';

/** The map, sent once. Everything the renderer draws that never changes. */
export interface MapSnapshot {
  size: number;
  /** Per street: ax, ay, bx, by, width. */
  streets: Float32Array;
  /** Per street: 1 if lit. */
  streetLit: Uint8Array;
  /** Per building: the four outline corners, x0 y0 x1 y1 x2 y2 x3 y3. */
  outlines: Float32Array;
  river: { centreline: { x: number; y: number }[]; width: number };
  districts: { name: string; x: number; y: number; w: number; h: number }[];
  streetNames: string[];
}

/** Sim kinds on the map; anything else (indoors, dead, turned) is not drawn as a dot. */
export const SIM_HIDDEN = 0;
export const SIM_LIVING = 1;
export const SIM_PROMOTED = 2;

/** Zombie kinds on the map. */
export const ZOMBIE_HIDDEN = 0; // occupying or destroyed
export const ZOMBIE_AWAKE = 1;
export const ZOMBIE_DORMANT = 2;

/** Building flags. */
export const BUILDING_CONTESTED = 1;
export const BUILDING_GARRISON = 2;
export const BUILDING_LIT = 4;

/**
 * What the ticker needs to know about an event, captured by the worker at the tick
 * it happened: who (a name only if promoted — anonymous people are "a survivor"),
 * whether they were armed, and where, in words.
 */
export interface EventNote {
  /** The sim at the centre of the event, if any. */
  sim: number | null;
  /** The promoted survivor's name, or null for anyone anonymous. */
  name: string | null;
  armed: boolean;
  /** The building concerned, if any. */
  building: number | null;
  /** e.g. "the hardware store on Elm Street", or "Elm Street". */
  place: string;
  district: string;
  x: number;
  y: number;
}

/** One moment of the run, for drawing. */
export interface FrameSnapshot {
  tick: number;
  /** 1 in daylight, 0 at night. */
  daylight: number;
  /** Hour of day, 0–24. */
  hour: number;
  /** Per sim (indexed by id): x, y. */
  simXY: Float32Array;
  simKind: Uint8Array;
  /** Per zombie (indexed by id): x, y. */
  zombieXY: Float32Array;
  zombieKind: Uint8Array;
  /** Per building: everyone inside — residents, tracked sims and occupiers, indistinguishable from outside. */
  fill: Uint16Array;
  buildingFlags: Uint8Array;
  counters: Counters;
  roster: { id: number; name: string; living: boolean }[];
  /** Everything that happened since the last frame (capped; see `eventsDropped`). */
  events: SimEvent[];
  /** Aligned with `events`; null for events no ticker line could be about (kills, anonymous deaths in breaches). */
  notes: (EventNote | null)[];
  eventsDropped: number;
  /** Simulated ticks per wall-clock second over the last second, as achieved. */
  achievedRate: number;
}

export type ToWorker =
  /** `advance` ticks are stepped before the first frame: for looking at, or measuring, a run part-way through. */
  | { type: 'start'; runSeed: number; mapSeed: number; advance: number }
  /** Ticks per wall-clock second; 0 pauses. */
  | { type: 'rate'; ticksPerSecond: number }
  /** The main thread is ready for another frame. */
  | { type: 'frame' };

export type FromWorker = { type: 'map'; map: MapSnapshot } | { type: 'frame'; frame: FrameSnapshot };
