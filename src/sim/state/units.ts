// Units and ids shared by every state type.
//
// Unit aliases document what a number means; they do not constrain it. Ids are
// branded because sims, zombies, buildings and streets each have their own id
// space (array index), and passing one where another is expected is a bug the
// compiler can catch.

/** Simulated seconds since tick 0. One tick is one second. Integer. */
export type Tick = number;

/** World distance. One unit is one metre. */
export type Metres = number;

/** Angle in radians, 0–2π. */
export type Radians = number;

/** A normalised simulation scalar, clamped to 0–1. */
export type Unit01 = number;

/** A non-negative integer count of discrete things (people, materials, rounds). */
export type Count = number;

declare const brand: unique symbol;
type Id<Name extends string> = number & { readonly [brand]: Name };

export type SimId = Id<'SimId'>;
export type ZombieId = Id<'ZombieId'>;
export type BuildingId = Id<'BuildingId'>;
export type StreetId = Id<'StreetId'>;
export type NodeId = Id<'NodeId'>;
export type DistrictId = Id<'DistrictId'>;

export interface Vec2 {
  /** @range 0–3200 @unit m @readBy whatever holds the point */
  x: Metres;
  /** @range 0–3200 @unit m @readBy whatever holds the point */
  y: Metres;
}

/** A closed polygon; the last vertex joins the first. */
export type Polygon = readonly Vec2[];
