// Messages between the main thread and the simulation worker.
//
// The worker owns the World and the clock; the main thread only ever sees
// snapshots. Positions travel as typed arrays (transferred, not copied), so the
// renderer cannot write simulation state even by accident: it never holds any.

import type { Scenario } from '../sim/state';
import type { Counters, SimEvent } from '../sim/state';

/** The map, sent once. Everything the renderer draws that never changes. */
export interface MapSnapshot {
  size: number;
  /** Per street: ax, ay, bx, by, width. */
  streets: Float32Array;
  /** Per street: 1 if lit. */
  streetLit: Uint8Array;
  /** Per street: 1 if it is a bridge deck over the river (an exit's crossing of the border is drawn with the border). */
  streetBridge: Uint8Array;
  /** Per building: the four outline corners, x0 y0 x1 y1 x2 y2 x3 y3. */
  outlines: Float32Array;
  /** Per entrance, every building: building index, x, y on the wall, and the wall's outward normal nx, ny. */
  doors: Float32Array;
  /** Where the outbreak began: each building the dead started in (its centre) and each spot where someone turned in the street, at tick 0. The view opens on the first. */
  origins: { x: number; y: number }[];
  /** Per building: how its outline is drawn — SHAPE_BOX, or a church in plan, a hospital's L or a school's U (renderer.ts). */
  buildingShape: Uint8Array;
  /** Per building: 1 for the reservists' armoury (the depot holding a weapon stock); other depots are ordinary buildings. */
  buildingArmoury: Uint8Array;
  /** Per building: 1 if the building's tag is policeStation. */
  buildingStation: Uint8Array;
  river: { centreline: { x: number; y: number }[]; width: number };
  /** The empty margin round the city, and the feature across it on each side (top, right, bottom, left). */
  border: { margin: number; sides: ('rail' | 'motorway')[] };
  /** How far in from a closed barrier the soldiers' warnings begin (cordon.warnRadius), m: where DO NOT CROSS is painted. */
  cordonWarn: number;
  /** Per mall: its grounds' four corners (front edge first), parking depth, and where the driveway enters along the front. */
  lots: Float32Array;
  /** Per way off the map: where the highway meets the edge, outward, and where its cordon barrier would stand, and the road's width there (x, y, dx, dy, bx, by, width). */
  exits: Float32Array;
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
/** Values per tent in FrameSnapshot.tents. */
export const TENT_STRIDE = 6;
export const SIM_FIGHTING = 4; // standing its ground, or has struck or fired within its weapon's cooldown: a bright outline
export const SIM_ARMED = 8; // carries a firearm with ammunition: shoots back (drawn as a triangle)
export const SIM_POLICE = 16; // drawn light blue
export const SIM_FLEEING = 32; // panicked flight, or backing off: a long bright trail
export const SIM_GUARD = 64; // a reservist armed at an armoury (National Guard): drawn pale green

/** Zombie kinds on the map. */
export const ZOMBIE_HIDDEN = 0; // occupying or destroyed
export const ZOMBIE_AWAKE = 1;
export const ZOMBIE_DORMANT = 2;
/** Car states, as drawn. */
export const SHAPE_BOX = 0;
export const SHAPE_CHURCH = 1;
export const SHAPE_L = 2; // a hospital: an L, a back corner cut away
export const SHAPE_U = 3; // a school: a U, open at the back

/** Values per checkpoint in MapSnapshot.checkpoints. */
export const CHECKPOINT_STRIDE = 5;

export const CAR_PARKED = 0;
export const CAR_DRIVING = 1;
export const CAR_ABANDONED = 2;
export const CAR_GONE = 3; // driven off the map: not drawn
export const CAR_STATE_MASK = 3;
export const CAR_VAN = 4; // a SWAT van: longer, police blue
export const CAR_AMBULANCE = 8; // an ambulance: longer, white
export const CAR_CRUISER = 16; // a police car: a car's size, police blue
export const CAR_HMMWV = 64; // a reservists' HMMWV: drawn as one, reservist green
export const CAR_TRUCK = 32; // with CAR_VAN: the rescue's truck, standing or on the road in or out: army canvas, no lights

/** Awake and intact (turned from one bite): drawn paler at near zoom, where the viewer is told; the city is not. */
export const ZOMBIE_INTACT = 3;

/** Building flags. */
export const BUILDING_CONTESTED = 1;
export const BUILDING_GARRISON = 2;
export const BUILDING_LIT = 4;
export const BUILDING_CALL = 8; // police on the way to a 911 call: a light blue ring closing in
export const BUILDING_CALL_WAITING = 64; // a 911 call going unanswered (half its time gone, nobody sent): a faint slow pulse, gone when it lapses
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
  supplies: number;
  /** How long its supplies would last the people in it, simulated hours; null when nobody eats them. */
  suppliesHours: number | null;
  breached: boolean;
  garrisoned: boolean;
  /** Anonymous residents present since the start. */
  residents: number;
  /** Tracked sims inside, by id, with a name if promoted. */
  /** Each tracked sim inside; `kind` colours it as on the map (police light blue, a rifle pale green). */
  tracked: { id: number; name: string | null; kind: 'police' | 'guard' | null }[];
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
  sociality: number;
  trust: number;
  nerve: number;
  unease: number;
  /** Ground truth, including the infection nobody else may know about. */
  condition: string;
  /** Bites taken; each after the first hastens the turn. */
  bites: number;
  insideBuilding: number | null;
  weapon: string | null;
  ammo: number;
  supplies: number;
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
  /** What it believes, in its own words, from its own fields only (thoughts.ts); empty for the dead. */
  thoughts: string[];
  /** Those it knows have been bitten: up to three names (of the named), and how many in all. */
  knownBitten: { names: string[]; count: number };
  /** How its story ended, for the dead, the turned and those who got out (endings.ts): hours are on the viewer's clock, since the outbreak began. */
  ending: { how: 'fedOn' | 'breach' | 'shot' | 'mistaken' | 'returned' | 'crash' | 'turned' | 'evacuated'; place: string; hoursIn: number; roseAfter: number | null } | null;
  /** The dead it destroyed. */
  kills: number;
}

export type Inspected = BuildingDetail | SimDetail;

/** One moment of the run, for drawing. */
export interface FrameSnapshot {
  tick: number;
  /** 1 in daylight, 0 at night. */
  daylight: number;
  /** Hour of day, 0–24. */
  hour: number;
  /** Exits the cordon has closed, as bits (1 << exit index). */
  closedExits: number;
  /** Per police checkpoint (traffic.ts) — one on each exit's road from the start, more at the first evacuating district's edge once it goes: x, y, the way its vehicles park dx, dy, the road's width (CHECKPOINT_STRIDE values). */
  checkpoints: Float32Array;
  /** Police checkpoints set, as bits (1 << checkpoint index); drawn once set. */
  checkpointsSet: number;
  /** Checkpoints fallen, as bits: drawn knocked aside and faded, for the rest of the run. */
  checkpointsFallen: number;
  /** Closed exits nobody is left to hold, as bits: their barriers are drawn abandoned. */
  breachedExits: number;
  /** The rescue's tents, once it has come: middle x, y, the road's direction dx, dy, length along it and width across, per tent (TENT_STRIDE values); empty before. */
  tents: Float32Array;
  /** Army Rangers of the rescue still outdoors: x, y pairs. Empty before the sweep and when none remain. */
  rangers: Float32Array;
  /** People in the tents waiting for a truck. */
  tented: number;
  /** The rescue's exit (its barrier has the gate), or -1 before it comes. */
  rescueExit: number;
  /** Half the gate's width at the middle of that barrier, m (rescue.gate). */
  rescueGate: number;
  /** Day of the week, 0 Monday … 6 Sunday (time.startWeekday, then a day each dayLength ticks past midnight). */
  weekday: number;
  /** Game seconds since the outbreak began (tick 0): the clock's own rate, not wall time. */
  sinceOutbreak: number;
  /** Per sim (indexed by id): x, y. */
  simXY: Float32Array;
  simKind: Uint8Array;
  simFlags: Uint8Array;
  /** Per sim: heading in radians (which way a triangle points). */
  simHeading: Float32Array;
  /** Per sim: ticks until the bitten turn (0 for everyone else), for the amber ring's pulse. */
  simTurnIn: Float32Array;
  /** Everyone outdoors in a conversation, as pairs: sim id, and the id that names the conversation. */
  talk: Int32Array;
  /** Squad followers outdoors with their leader outdoors too, as pairs: follower id, leader id. */
  squad: Int32Array;
  /** Per zombie (indexed by id): x, y. */
  zombieXY: Float32Array;
  zombieKind: Uint8Array;
  /** Per car: x, y, heading. */
  carXYH: Float32Array;
  /** Per car: CAR_PARKED, CAR_DRIVING or CAR_ABANDONED. */
  carState: Uint8Array;
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
  | { type: 'start'; runSeed: number; mapSeed: number; advance: number; settings: Partial<Scenario> }
  /** Ticks per wall-clock second; 0 pauses. */
  | { type: 'rate'; ticksPerSecond: number }
  /** The main thread is ready for another frame. */
  | { type: 'frame' }
  /** Keep sending detail for this sim or building with each frame; null stops. */
  | { type: 'inspect'; target: { kind: 'sim' | 'building'; id: number } | null };

/** The run's last tick reached: the end screen's figures, read from the same place as the sweep's. */
export interface EndSummary {
  population: number;
  /** Soldiers from outside, counted on top of the population. */
  outsiders: number;
  evacuated: number;
  dead: number;
  turned: number;
  /** Alive in the city at the end, outsiders included. */
  alive: number;
  trucked: number;
  /** What became of those who answered the broadcast, and the road they were told to make for; null without a rescue. */
  /**
   * Of those still in the city when the broadcast went out, split at rescue.trustFloor:
   * how many doubted the radio and how many believed it, and how many of each lived or
   * got out. Null without a rescue.
   */
  trust: { doubted: number; doubtedLived: number; believed: number; believedLived: number } | null;
  /** Loners against civilians, the city's outsiders aside: how many of each, and how many lived or got out. */
  loners: { loners: number; lonersLived: number; civilians: number; civiliansLived: number };
  rescue: { place: string; answered: number; out: number; dead: number; turned: number; waiting: number; elsewhere: number } | null;
}

export type FromWorker = { type: 'map'; map: MapSnapshot } | { type: 'frame'; frame: FrameSnapshot } | { type: 'ended'; end: EndSummary };
