// Cars: a building with a velocity (state/car.ts). Jams and abandonment, not traffic.
//
//   setup       parked at the kerb in front of a share of buildings, and in the mall's
//               stalls (placeParkedCars)
//   obstacles   every car is a rectangle nobody on foot walks through (CarIndex)
//   choosing    an aware sim heading for home or shelter far away takes the nearest
//               free parked car it can see (considerDriving, from sim decisions)
//   boarding    at the car it gets in and plans the drive (carProcesses, step 10)
//   driving     toward the next junction, kept right of the centreline; stopped by
//               anything ahead, the lower id yielding when two stop for each other;
//               slowed by congestion (decideCars, step 6; moveCars, step 9)
//   arriving    at the kerb by the destination's door, everyone gets out
//   abandoning  stopped behind something for jamTicks: everyone gets out, and the car
//               stays where it is for the rest of the run
//
// Everyone inside counts as outdoors (or symptomatic), and is out of reach of
// everything that acts on people on foot: the population invariant does not change.

import type { Context } from '../context';
import { chance } from '../rng';
import type { Building, Car, CarId, World } from '../state';
import { functionalProfile } from '../mapgen/generate';

const CELL = 10; // m

/**
 * What a step on foot may not enter. Cars standing still (parked, abandoned) are on a
 * grid, rebuilt only when one starts, stops or is abandoned; the few moving ones are
 * checked directly.
 */
export class CarIndex {
  private cols = 0;
  private cells: number[][] = [];
  private used: number[] = []; // cells holding a car, to clear (most of the grid is empty)
  private cars: Car[] = [];
  private moving: Car[] = [];
  private signature = '';
  private halfL = 0;
  private halfW = 0;

  rebuild(world: World): void {
    this.cars = world.cars;
    this.moving.length = 0;
    let sig = world.cars.length;
    for (const car of world.cars) {
      if (car.state === 'driving') {
        this.moving.push(car);
        sig = (sig * 31 + car.id) | 0;
      }
    }
    const signature = `${world.cars.length}|${sig}|${this.moving.length}`;
    if (signature === this.signature) return;
    this.signature = signature;
    const size = world.config.map.size;
    this.cols = Math.ceil(size / CELL) + 2;
    if (this.cells.length !== this.cols * this.cols) this.cells = Array.from({ length: this.cols * this.cols }, () => []);
    for (const c of this.used) this.cells[c]!.length = 0;
    this.used.length = 0;
    this.halfL = world.config.cars.length / 2;
    this.halfW = world.config.cars.width / 2;
    for (const car of world.cars) {
      if (car.state === 'driving') continue;
      const r = this.halfL;
      const c0x = this.col(car.x - r), c1x = this.col(car.x + r), c0y = this.col(car.y - r), c1y = this.col(car.y + r);
      for (let cy = c0y; cy <= c1y; cy++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const cell = this.cells[cy * this.cols + cx]!;
          if (cell.length === 0) this.used.push(cy * this.cols + cx);
          cell.push(car.id);
        }
      }
    }
  }

  private col(v: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor(v / CELL) + 1));
  }

  /** Whether the point lies within a car's rectangle. */
  blocks(x: number, y: number): boolean {
    if (this.cols === 0) return false;
    for (const id of this.cells[this.col(y) * this.cols + this.col(x)]!) if (inside(this.cars[id]!, x, y, this.halfL, this.halfW)) return true;
    for (const car of this.moving) if (inside(car, x, y, this.halfL, this.halfW)) return true;
    return false;
  }
}

function inside(car: Car, x: number, y: number, halfL: number, halfW: number): boolean {
  const dx = x - car.x, dy = y - car.y;
  const c = Math.cos(car.heading), s = Math.sin(car.heading);
  return Math.abs(dx * c + dy * s) <= halfL && Math.abs(-dx * s + dy * c) <= halfW;
}

// Setup

/** The kerb in front of a building's door, on its street: a point and the street's direction. Null on an alley, a bridge or open ground, or near a junction. */
function kerbBy(world: World, b: Building, x: number, y: number): { x: number; y: number; heading: number } | null {
  const cc = world.config.cars;
  const s = world.streets[b.street]!;
  if (s.terrain !== 'standard') return null;
  const a = world.nodes[s.a]!, n = world.nodes[s.b]!;
  const len = Math.hypot(n.x - a.x, n.y - a.y);
  if (len === 0) return null;
  const ux = (n.x - a.x) / len, uy = (n.y - a.y) / len;
  const t = (x - a.x) * ux + (y - a.y) * uy;
  if (t < cc.nodeClear || t > len - cc.nodeClear) return null;
  // Toward the door's side of the street.
  const side = Math.sign((x - a.x) * -uy + (y - a.y) * ux) || 1;
  const off = s.width / 2 - cc.kerbInset;
  return { x: a.x + ux * t - uy * off * side, y: a.y + uy * t + ux * off * side, heading: Math.atan2(uy, ux) };
}

function addCar(world: World, ctx: Context, x: number, y: number, heading: number, spaced: boolean): void {
  const cc = world.config.cars;
  if (!ctx.map.walkable(x, y)) return;
  if (spaced) for (const c of world.cars) if (Math.hypot(c.x - x, c.y - y) < cc.spacing) return;
  world.cars.push({
    id: world.cars.length as CarId,
    state: 'parked',
    x,
    y,
    heading,
    speed: 0,
    occupants: [],
    claimedBy: null,
    destinationBuilding: null,
    destination: null,
    route: [],
    routeIndex: 0,
    blockedSince: null,
  });
}

/** Parks cars at the kerb in front of a share of buildings, and in the mall's stalls. Called once at setup. */
export function placeParkedCars(world: World, ctx: Context): void {
  const { config, rng, buildings } = world;
  const cc = config.cars;
  for (const b of buildings) {
    const tag = functionalProfile(b.tag, config) === b.tag ? b.tag : 'flavour';
    if (!chance(rng, cc.parkShare[tag] ?? 0)) continue;
    const e = b.entrances[0]!;
    const k = kerbBy(world, b, e.x, e.y);
    if (k !== null) addCar(world, ctx, k.x, k.y, k.heading, true);
  }
  // The mall's stalls: double rows nose to nose, either side of the driveway.
  const st = cc.stall;
  for (const lot of world.lots) {
    const o = lot.outline;
    const w = Math.hypot(o[1]!.x - o[0]!.x, o[1]!.y - o[0]!.y) || 1;
    const dx = (o[1]!.x - o[0]!.x) / w, dy = (o[1]!.y - o[0]!.y) / w;
    const depth = Math.hypot(o[3]!.x - o[0]!.x, o[3]!.y - o[0]!.y) || 1;
    const ix = (o[3]!.x - o[0]!.x) / depth, iy = (o[3]!.y - o[0]!.y) / depth;
    const at = (u: number, v: number) => ({ x: o[0]!.x + dx * u + ix * v, y: o[0]!.y + dy * u + iy * v });
    const heading = Math.atan2(iy, ix);
    for (let v = st.aisle / 2; v + 2 * st.depth <= lot.parkingDepth - st.aisle / 2; v += 2 * st.depth + st.aisle) {
      for (let u = st.aisle / 2 + st.width / 2; u <= w - st.aisle / 2; u += st.width) {
        if (Math.abs(u - lot.entry) < st.driveGap + st.width / 2) continue;
        for (const row of [v + st.depth / 2, v + st.depth * 1.5]) {
          if (!chance(rng, cc.lotShare)) continue;
          const p = at(u, row);
          addCar(world, ctx, p.x, p.y, heading, false);
        }
      }
    }
  }
}
