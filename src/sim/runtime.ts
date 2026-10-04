// Acceleration structures derived from the static map: street adjacency, grids for
// nearest-street and building lookups, line of sight, and obstacle tests. Built once
// per world from state, never stored in it, so a reloaded world rebuilds them.

import { distSq, pointSegmentDistance, segmentHitsAabb } from './geometry';
import type { BuildingId, NodeId, StreetId, World } from './state';

const STREET_CELL = 20; // m
const ON_STREET = 12; // m; covers half the widest street, so most lookups stop here
const BUILDING_CELL = 80; // m

export interface Adjacent {
  street: StreetId;
  node: NodeId;
  length: number;
}

export class MapIndex {
  readonly size: number;
  readonly adjacency: Adjacent[][];
  readonly streetLength: Float64Array;
  readonly bMinX: Float64Array;
  readonly bMinY: Float64Array;
  readonly bMaxX: Float64Array;
  readonly bMaxY: Float64Array;
  readonly riverLo: number;
  readonly riverHi: number;
  /** x-extent of each bridge's deck: [minX, maxX] pairs. */
  readonly bridges: [number, number][] = [];

  private readonly streetCols: number;
  private readonly streetCells: StreetId[][];
  private readonly buildingCols: number;
  private readonly buildingCells: BuildingId[][];
  private readonly stamp: Int32Array;
  private stampValue = 0;

  constructor(private readonly world: World) {
    const size = world.config.map.size;
    this.size = size;
    const { nodes, streets, buildings } = world;

    this.adjacency = nodes.map(() => []);
    this.streetLength = new Float64Array(streets.length);
    for (const s of streets) {
      const a = nodes[s.a]!;
      const b = nodes[s.b]!;
      const length = Math.sqrt(distSq(a.x, a.y, b.x, b.y));
      this.streetLength[s.id] = length;
      this.adjacency[s.a]!.push({ street: s.id, node: s.b, length });
      this.adjacency[s.b]!.push({ street: s.id, node: s.a, length });
    }

    this.streetCols = Math.ceil(size / STREET_CELL);
    this.streetCells = Array.from({ length: this.streetCols * this.streetCols }, () => []);
    for (const s of streets) {
      const a = nodes[s.a]!;
      const b = nodes[s.b]!;
      this.forCells(STREET_CELL, this.streetCols, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), (c) =>
        this.streetCells[c]!.push(s.id),
      );
      if (s.terrain === 'bridge') this.bridges.push([a.x - s.width / 2, a.x + s.width / 2]);
    }

    const n = buildings.length;
    this.bMinX = new Float64Array(n);
    this.bMinY = new Float64Array(n);
    this.bMaxX = new Float64Array(n);
    this.bMaxY = new Float64Array(n);
    this.buildingCols = Math.ceil(size / BUILDING_CELL);
    this.buildingCells = Array.from({ length: this.buildingCols * this.buildingCols }, () => []);
    for (const b of buildings) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of b.outline) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      this.bMinX[b.id] = minX;
      this.bMinY[b.id] = minY;
      this.bMaxX[b.id] = maxX;
      this.bMaxY[b.id] = maxY;
      this.forCells(BUILDING_CELL, this.buildingCols, minX, minY, maxX, maxY, (c) => this.buildingCells[c]!.push(b.id));
    }
    this.stamp = new Int32Array(n);

    const river = world.river.outline;
    this.riverLo = Math.min(...river.map((p) => p.y));
    this.riverHi = Math.max(...river.map((p) => p.y));
  }

  private forCells(cell: number, cols: number, minX: number, minY: number, maxX: number, maxY: number, fn: (c: number) => void) {
    const max = cols - 1;
    const c0x = Math.max(0, Math.floor(minX / cell));
    const c1x = Math.min(max, Math.floor(maxX / cell));
    const c0y = Math.max(0, Math.floor(minY / cell));
    const c1y = Math.min(max, Math.floor(maxY / cell));
    for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) fn(cy * cols + cx);
  }

  /** Whether the point is on the street: within half its width of the centreline. */
  onStreet(street: StreetId | null, x: number, y: number): boolean {
    if (street === null) return false;
    const s = this.world.streets[street]!;
    const a = this.world.nodes[s.a]!;
    const b = this.world.nodes[s.b]!;
    return pointSegmentDistance(x, y, a.x, a.y, b.x, b.y) <= s.width / 2;
  }

  /** Nearest street whose centreline is within maxDist, lowest id on ties; null if none. */
  nearestStreet(x: number, y: number, maxDist: number): StreetId | null {
    if (maxDist > ON_STREET) {
      const near = this.nearestWithin(x, y, ON_STREET);
      if (near !== null) return near;
    }
    return this.nearestWithin(x, y, maxDist);
  }

  private nearestWithin(x: number, y: number, maxDist: number): StreetId | null {
    const { nodes, streets } = this.world;
    const cols = this.streetCols;
    const max = cols - 1;
    const c0x = Math.max(0, Math.floor((x - maxDist) / STREET_CELL));
    const c1x = Math.min(max, Math.floor((x + maxDist) / STREET_CELL));
    const c0y = Math.max(0, Math.floor((y - maxDist) / STREET_CELL));
    const c1y = Math.min(max, Math.floor((y + maxDist) / STREET_CELL));
    let best: StreetId | null = null;
    let bestD = maxDist;
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        for (const id of this.streetCells[cy * cols + cx]!) {
          const s = streets[id]!;
          const a = nodes[s.a]!;
          const b = nodes[s.b]!;
          const d = pointSegmentDistance(x, y, a.x, a.y, b.x, b.y);
          if (d < bestD || (d === bestD && best !== null && id < best)) {
            bestD = d;
            best = id;
          }
        }
      }
    }
    return best;
  }

  /** Building whose footprint contains the point, or null. */
  buildingAt(x: number, y: number): BuildingId | null {
    const cx = Math.min(this.buildingCols - 1, Math.max(0, Math.floor(x / BUILDING_CELL)));
    const cy = Math.min(this.buildingCols - 1, Math.max(0, Math.floor(y / BUILDING_CELL)));
    for (const id of this.buildingCells[cy * this.buildingCols + cx]!) {
      if (x > this.bMinX[id]! && x < this.bMaxX[id]! && y > this.bMinY[id]! && y < this.bMaxY[id]!) return id;
    }
    return null;
  }

  /** Buildings whose footprint comes within r of the point, ascending id. */
  buildingsNear(x: number, y: number, r: number, out: BuildingId[]): BuildingId[] {
    out.length = 0;
    const s = ++this.stampValue;
    this.forCells(BUILDING_CELL, this.buildingCols, x - r, y - r, x + r, y + r, (c) => {
      for (const id of this.buildingCells[c]!) {
        if (this.stamp[id] === s) continue;
        this.stamp[id] = s;
        const dx = Math.max(this.bMinX[id]! - x, 0, x - this.bMaxX[id]!);
        const dy = Math.max(this.bMinY[id]! - y, 0, y - this.bMaxY[id]!);
        if (dx * dx + dy * dy <= r * r) out.push(id);
      }
    });
    out.sort((a, b) => a - b);
    return out;
  }

  /** Whether a straight sight line between two points is clear of every building. */
  lineOfSight(ax: number, ay: number, bx: number, by: number): boolean {
    const s = ++this.stampValue;
    let clear = true;
    this.forCells(BUILDING_CELL, this.buildingCols, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), (c) => {
      if (!clear) return;
      for (const id of this.buildingCells[c]!) {
        if (this.stamp[id] === s) continue;
        this.stamp[id] = s;
        if (segmentHitsAabb(ax, ay, bx, by, this.bMinX[id]!, this.bMinY[id]!, this.bMaxX[id]!, this.bMaxY[id]!)) {
          clear = false;
          return;
        }
      }
    });
    return clear;
  }

  /** Whether a point is walkable: on the map, outside every building, and dry or on a bridge. */
  walkable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x > this.size || y > this.size) return false;
    if (y > this.riverLo && y < this.riverHi && !this.bridges.some(([lo, hi]) => x >= lo && x <= hi)) return false;
    return this.buildingAt(x, y) === null;
  }
}
