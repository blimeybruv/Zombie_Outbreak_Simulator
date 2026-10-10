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
  /** Per street: 1 if it is a bridge deck over the river. */
  streetBridge: Uint8Array;
  /** Per building: the four outline corners, x0 y0 x1 y1 x2 y2 x3 y3. */
  outlines: Float32Array;
  /** Per entrance, every building: building index, x, y on the wall, and the wall's outward normal nx, ny. */
  doors: Float32Array;
  /** Where the outbreak began: the buildings patient zero was in at tick 0. The view opens on the first. */
  origins: number[];
  /** Per building: 1 for a church, drawn in plan (nave, apse, tower). */
  buildingChurch: Uint8Array;
  river: { centreline: { x: number; y: number }[]; width: number };
  districts: { name: string; x: number; y: number; w: number; h: number }[];
  streetNames: string[];
}

/** Sim kinds on the map; anything else (indoors, dead, turned) is not drawn as a dot. */
export const SIM_HIDDEN = 0;
export const SIM_LIVING = 1;
export const SIM_PROMOTED = 2;

/**
 * Sim flags, alongside simKind: what the viewer may know that the city does not.
 * Infected is drawn at near zoom only (an amber ring, or a pale amber fill, to try).
 */
export const SIM_INFECTED = 1;
export const SIM_FROZEN = 2; // cornered and keeping still
export const SIM_FIGHTING = 4; // standing its ground, or has struck or fired within its weapon's cooldown: a bright outline
export const SIM_ARMED = 8; // carries a firearm with ammunition: shoots back (drawn as a triangle)
export const SIM_POLICE = 16; // drawn light blue
export const SIM_FLEEING = 32; // panicked flight, or backing off: a long bright trail

/** Zombie kinds on the map. */
export const ZOMBIE_HIDDEN = 0; // occupying or destroyed
export const ZOMBIE_AWAKE = 1;
export const ZOMBIE_DORMANT = 2;

/** Building flags. */
export const BUILDING_CONTESTED = 1;
export const BUILDING_GARRISON = 2;
export const BUILDING_LIT = 4;
export const BUILDING_CALL = 8; // police on the way to a 911 call: a flashing light blue ring
/** Fortification stage in two bits: 0 open, 1 barricaded, 2 reinforced, 3 fortified. */
export const BUILDING_STAGE_SHIFT = 4;
export const BUILDING_STAGE_MASK = 3 << BUILDING_STAGE_SHIFT;

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
  /** How long the subject had been named when it happened, in ticks; null if anonymous. */
  namedFor: number | null;
  armed: boolean;
  /** The building concerned, if any. */
  building: number | null;
  /** e.g. "the hardware store on Elm Street", or "Elm Street". */
  place: string;
  district: string;
  x: number;
  y: number;
}

/** The world's state for one building: what the viewer sees and the people do not. */
export interface BuildingDetail {
  kind: 'building';
  id: number;
  /** e.g. "hardware store". */
  what: string;
  street: string;
  district: string;
  integrity: number;
  fortification: number;
  materials: number;
  breached: boolean;
  garrisoned: boolean;
  /** Anonymous residents present since the start. */
  residents: number;
  /** Tracked sims inside, by id, with a name if promoted. */
  tracked: { id: number; name: string | null }[];
  /** Occupying zombies. */
  occupiers: number;
}

/** One person: ground truth on the left of the panel, their beliefs on the right. */
export interface SimDetail {
  kind: 'sim';
  id: number;
  name: string | null;
  profession: string;
  age: number;
  archetype: string;
  caution: number;
  /** Ground truth, including the infection nobody else may know about. */
  condition: string;
  /** Bites taken; each after the first hastens the turn. */
  bites: number;
  insideBuilding: number | null;
  weapon: string | null;
  ammo: number;
  materials: number;
  role: string | null;
  /** What they are doing, in words: "heading home", "frozen, hiding", "errands, unaware"... */
  doing: string | null;
  /** Where they live, as a place. */
  home: string | null;
  /** The building they have taken as shelter, as a place. */
  shelter: string | null;
  // Beliefs.
  streetsKnown: number;
  buildingsKnown: number;
  knownInfected: number;
  backstory: string;
}

export type Inspected = BuildingDetail | SimDetail;

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
  simFlags: Uint8Array;
  /** Per sim: heading in radians (which way a triangle points). */
  simHeading: Float32Array;
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
  /** Whatever the viewer has asked to inspect, as of this frame. */
  inspected: Inspected | null;
  /**
   * Weapon noise made since the last frame — the stimuli that draw the dead, which
   * audio plays: the gunshot you hear is the one the horde heard.
   */
  noises: { x: number; y: number; kind: string; radius: number }[];
}

export type ToWorker =
  /** `advance` ticks are stepped before the first frame: for looking at, or measuring, a run part-way through. */
  | { type: 'start'; runSeed: number; mapSeed: number; advance: number }
  /** Ticks per wall-clock second; 0 pauses. */
  | { type: 'rate'; ticksPerSecond: number }
  /** The main thread is ready for another frame. */
  | { type: 'frame' }
  /** Keep sending detail for this sim or building with each frame; null stops. */
  | { type: 'inspect'; target: { kind: 'sim' | 'building'; id: number } | null };

export type FromWorker = { type: 'map'; map: MapSnapshot } | { type: 'frame'; frame: FrameSnapshot };
