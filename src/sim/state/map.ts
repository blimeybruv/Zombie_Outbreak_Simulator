// The street graph and districts: one shared, objective map. Sims know all of it;
// what they hold privately is opinion about parts of it (sim.streetMemory).
//
// Everything is edge-based. A park is a block with no building whose bounding and
// crossing streets carry terrain `open`; there is no area primitive.

import type { BuildingId, DistrictId, Metres, NodeId, StreetId, Tick, Unit01, Vec2 } from './units';

export const TERRAINS = ['standard', 'alley', 'open', 'bridge'] as const;
export type Terrain = (typeof TERRAINS)[number];

export const DISTRICT_KINDS = ['downtown', 'industrial', 'suburb'] as const;
export type DistrictKind = (typeof DISTRICT_KINDS)[number];

/** A street-graph vertex: a junction or a dead end. */
export interface StreetNode {
  /** @range 0–nodes @unit id @readBy pathfinding */
  id: NodeId;
  /** @range 0–3200 @unit m @readBy pathfinding (length, heuristic), steering, render */
  x: Metres;
  /** @range 0–3200 @unit m @readBy pathfinding (length, heuristic), steering, render */
  y: Metres;
}

/**
 * A way off the map: where a highway meets the map edge. Two or three per map, each
 * fed by an arterial that runs toward it across the city, so traffic for it converges
 * before it arrives.
 */
export interface Exit {
  /** The edge node it leaves from. @range node id @unit id @readBy render */
  node: NodeId;
  /** The highway's last segment before the edge. @range street id @unit id @readBy render */
  street: StreetId;
  /** @range 0–3200 @unit m @readBy render */
  x: Metres;
  /** @range 0–3200 @unit m @readBy render */
  y: Metres;
  /** Outward along the highway's last segment: off the map. @range unit vector @unit — @readBy render */
  dx: number;
  /** @range unit vector @unit — @readBy render */
  dy: number;
  /** When the cordon closed it (cordon.ts); null while open. @range tick | null @unit tick @readBy leaving, car processes, snapshot (render) */
  closedAt: Tick | null;
}

/** A street segment: a straight edge between two nodes. Length is derived from them. */
export interface Street {
  /** Memory table key. @range 0–streets @unit id @readBy everything */
  id: StreetId;
  /** Generated. @range — @unit — @readBy ticker, roster, inspector */
  name: string;
  /** @range node id @unit id @readBy pathfinding, steering, render */
  a: NodeId;
  /** @range node id @unit id @readBy pathfinding, steering, render */
  b: NodeId;
  /** Alley 6, standard 12, main 20, highway 28; a sim is on the street within width/2 of the centreline. @range 6–28 @unit m @readBy street membership, spawn weighting, render */
  width: Metres;
  /** @range 4 values @unit enum @readBy perception radius */
  terrain: Terrain;
  /** @range true/false @unit — @readBy perception radius, detectability, combat (a shot in the dark), render */
  lit: boolean;
  /** Permanent obstruction; 1 is impassable (a severed bridge). @range 0–1 @unit scalar @readBy pathfinding, steering */
  blocked: Unit01;
  /** @range district id @unit id @readBy ticker, spawn weighting */
  district: DistrictId;
}

/**
 * One cell of the 3×3 district grid. Generator inputs (block pitch, density,
 * lighting, tag weights) live in config per kind, not here.
 *
 * `released` and `releaseAt` may be read only by the occupant release. The
 * display phase is derived from them and from `world.promotedAt`.
 */
export interface District {
  /** @range 0–8 @unit id @readBy everything */
  id: DistrictId;
  /** @range — @unit — @readBy ticker */
  name: string;
  /** @range 3 values @unit enum @readBy generator, inspector */
  kind: DistrictKind;
  /** Axis-aligned. @range 0–3200 @unit m @readBy generator, street/building assignment, render */
  bounds: { x: Metres; y: Metres; w: Metres; h: Metres };
  /** @range true/false @unit — @readBy occupant release only; display phase */
  released: boolean;
  /** Release tick: config default ± per-district jitter, drawn from the run RNG at setup. @range tick @unit tick @readBy occupant release only */
  releaseAt: Tick;
  /** When the district began to evacuate (release.ts); null until it does. @range tick | null @unit tick @readBy occupant release only */
  evacuatedAt: Tick | null;
}

/**
 * A mall's grounds: open, walkable ground around one large building, reached by a
 * driveway cut from a street. Nothing in the simulation reads it — sims cross it like
 * any open ground — it is there to be drawn.
 */
export interface Lot {
  /** A rectangle, front edge first (corners 0→1 run along the street side). @range 0–3200 each vertex @unit m @readBy render */
  outline: readonly Vec2[];
  /** How far the parking reaches back from the front edge. @range 0–100 @unit m @readBy render */
  parkingDepth: Metres;
  /** Where the driveway enters, along the front edge from corner 0. @range 0–300 @unit m @readBy render */
  entry: Metres;
  /** A yard's police station or hospital, whose vehicles park in it; null for the mall's grounds. @range building id | null @unit id @readBy car placement */
  home: BuildingId | null;
}

/** The river: a band of constant width around a centreline. Bridges are the streets that cross it. */
export interface River {
  /** Runs edge to edge across the map, diagonally, with gentle bends. @range a few points, may extend past the map edge @unit m @readBy walkability, render */
  centreline: readonly Vec2[];
  /** @range 20–80 @unit m @readBy walkability, render */
  width: Metres;
}
