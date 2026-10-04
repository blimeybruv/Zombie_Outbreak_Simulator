// The street graph and districts: one shared, objective map. Sims know all of it;
// what they hold privately is opinion about parts of it (sim.streetMemory).
//
// Everything is edge-based. A park is a block with no building whose bounding and
// crossing streets carry terrain `open`; there is no area primitive.

import type { DistrictId, Metres, NodeId, StreetId, Tick, Unit01, Vec2 } from './units';

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
  /** Alley 6, standard 12, main 20; a sim is on the street within width/2 of the centreline. @range 6–20 @unit m @readBy street membership, spawn weighting, render */
  width: Metres;
  /** @range 4 values @unit enum @readBy perception radius */
  terrain: Terrain;
  /** @range true/false @unit — @readBy perception radius, detectability, render */
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
}

/** The river: a band of constant width around a centreline. Bridges are the streets that cross it. */
export interface River {
  /** Runs edge to edge across the map, diagonally, with gentle bends. @range a few points, may extend past the map edge @unit m @readBy walkability, render */
  centreline: readonly Vec2[];
  /** @range 20–80 @unit m @readBy walkability, render */
  width: Metres;
}
