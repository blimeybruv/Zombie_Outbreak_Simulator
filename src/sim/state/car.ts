// A car is a building with a velocity: a container people get into, that can be held,
// broken into, abandoned. Not traffic: no lanes, no intersections, no right of way
// beyond "the lower id yields". Cars follow the street graph, keeping to the right of
// the centreline by direction of travel so opposing cars never meet; they stop for
// whatever is in front of them; one stopped too long is abandoned where it stands,
// and stays there, an obstacle, for the rest of the run.
//
// The people inside are on the map, so they count as outdoors (or symptomatic): the
// population invariant does not change. They are out of reach of everything that
// acts on people on foot (`Sim.car`).

import type { BuildingId, CarId, Metres, Radians, SimId, StreetId, Tick, Vec2 } from './units';

/**
 * parked: empty, or waiting for the one who claimed it. driving: moving, or stopped
 * in traffic with someone at the wheel. abandoned: left where it stopped; never moves
 * again.
 */
export const CAR_STATES = ['parked', 'driving', 'abandoned'] as const;
export type CarState = (typeof CAR_STATES)[number];

export interface Car {
  /** Array index into `world.cars`. @range 0–a few thousand @unit id @readBy everything */
  id: CarId;
  /** @range 3 values @unit enum @readBy car decisions, obstacles, render */
  state: CarState;
  /** A car, a SWAT van, a police car or an ambulance: the same in every way, but only its crew sets out in it from home. @range 4 values @unit enum @readBy squads (SWAT), police dispatch, EMTs, render */
  kind: 'car' | 'van' | 'cruiser' | 'ambulance';
  /** A van's or police car's station, or an ambulance's hospital; null for a car. @range building id | null @unit id @readBy squads (SWAT), police dispatch, EMTs */
  home: BuildingId | null;
  /** An ambulance on a job: the building it is going to (the call, then home); null when idle. @range building id | null @unit id @readBy EMTs */
  job: BuildingId | null;
  /** The patient an ambulance has collected; null before, or with none found. @range sim id | null @unit id @readBy EMTs */
  patient: SimId | null;
  /** Centre. @range 0–3200 @unit m @readBy obstacles, car decisions, render */
  x: Metres;
  /** @range 0–3200 @unit m @readBy obstacles, car decisions, render */
  y: Metres;
  /** Which way it points. @range 0–2π @unit rad @readBy obstacles, car decisions, render */
  heading: Radians;
  /** Distance moved this tick, set by its decision. @range 0–cars.maxSpeed @unit m/tick @readBy car movement */
  speed: Metres;
  /** Who is inside, the driver first. @range 0–cars.capacity sim ids @unit — @readBy car processes, inspector, render */
  occupants: SimId[];
  /** Someone walking to it to drive it away; nobody else takes it meanwhile. @range sim id | null @unit id @readBy car choice, boarding */
  claimedBy: SimId | null;
  /** Where its driver means to go. @range building id | null @unit id @readBy car decisions, arrival */
  destinationBuilding: BuildingId | null;
  /** The point it pulls up at, by the destination's door. @range 0–3200 each axis | null @unit m @readBy car decisions */
  destination: Vec2 | null;
  /** Streets to follow, as the driver planned them. @range street ids @unit — @readBy car decisions */
  route: StreetId[];
  /** @range 0–route.length @unit — @readBy car decisions */
  routeIndex: number;
  /** Since when it has been stopped with something in front of it; null while moving. @range tick | null @unit tick @readBy abandonment */
  blockedSince: Tick | null;
}
