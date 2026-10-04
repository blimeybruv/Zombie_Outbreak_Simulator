// Per-run working state that is derived, not part of the world: the map index,
// the spatial hashes, the per-tick perception snapshot and scratch buffers.
// Rebuildable from a World at any time, so it is never serialised.

import { Pathfinder } from './pathfinding';
import { MapIndex } from './runtime';
import { SpatialHash } from './spatial';
import type { BuildingId, SimEvent, World } from './state';

export interface Context {
  map: MapIndex;
  paths: Pathfinder;
  /** Outdoor living sims at start-of-tick positions (rebuilt again for encounters). */
  simHash: SpatialHash;
  /** Zombies on the map (not occupying, not destroyed) at start-of-tick positions. */
  zombieHash: SpatialHash;

  // Perception snapshot, indexed by sim id. Written in step 4, read-only after.
  threat: Float64Array;
  /** Unit-ish vector pointing toward what the sim fears, weighted by threat. */
  threatX: Float64Array;
  threatY: Float64Array;
  radius: Float64Array;
  /** Nearest street within the off-street lookup, or -1. */
  street: Int32Array;
  /** Nearest visible zombie, or -1. */
  nearestZombie: Int32Array;
  /** Zombies within contact range (no line of sight needed). */
  contacts: Int32Array;
  /** 1 if the sim stands on an unlit street at night (concealment). */
  dark: Uint8Array;
  daylight: number;

  // Zombie snapshot and intent, indexed by zombie id.
  /** Sim this zombie detects this tick, or -1. */
  zombieSees: Int32Array;
  /** Speed chosen in zombie decisions, applied in movement. */
  zombieSpeed: Float64Array;

  /** Sims already waiting in the repath queue. */
  queued: Uint8Array;
  events: SimEvent[];
  ids: number[];
  ids2: number[];
  buildingIds: BuildingId[];
}

export function createContext(world: World): Context {
  const size = world.config.map.size;
  const cell = world.config.map.spatialHashCell;
  const map = new MapIndex(world);
  return {
    map,
    paths: new Pathfinder(world, map),
    simHash: new SpatialHash(size, cell),
    zombieHash: new SpatialHash(size, cell),
    threat: new Float64Array(0),
    threatX: new Float64Array(0),
    threatY: new Float64Array(0),
    radius: new Float64Array(0),
    street: new Int32Array(0),
    nearestZombie: new Int32Array(0),
    contacts: new Int32Array(0),
    dark: new Uint8Array(0),
    daylight: 1,
    zombieSees: new Int32Array(0),
    zombieSpeed: new Float64Array(0),
    queued: new Uint8Array(0),
    events: [],
    ids: [],
    ids2: [],
    buildingIds: [],
  };
}

/** Grows the per-entity arrays to fit the current population, preserving `queued`. */
export function sizeContext(ctx: Context, world: World): void {
  const ns = world.sims.length;
  if (ctx.threat.length < ns) {
    const cap = Math.max(ns, ctx.threat.length * 2, 256);
    ctx.threat = new Float64Array(cap);
    ctx.threatX = new Float64Array(cap);
    ctx.threatY = new Float64Array(cap);
    ctx.radius = new Float64Array(cap);
    ctx.street = new Int32Array(cap);
    ctx.nearestZombie = new Int32Array(cap);
    ctx.contacts = new Int32Array(cap);
    ctx.dark = new Uint8Array(cap);
    const queued = new Uint8Array(cap);
    queued.set(ctx.queued);
    ctx.queued = queued;
  }
  const nz = world.zombies.length;
  if (ctx.zombieSees.length < nz) {
    const cap = Math.max(nz, ctx.zombieSees.length * 2, 256);
    ctx.zombieSees = new Int32Array(cap);
    ctx.zombieSpeed = new Float64Array(cap);
  }
}

export function isOutdoorLiving(s: { condition: string; insideBuilding: unknown }): boolean {
  return (s.condition === 'healthy' || s.condition === 'infected') && s.insideBuilding === null;
}
