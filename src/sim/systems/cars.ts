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
//   siege       a car being driven makes engine noise the dead hear; the dead at an
//               occupied car break in; someone turning inside bites the others
//
// Everyone inside counts as outdoors (or symptomatic), and is out of reach of
// everything that acts on people on foot: the population invariant does not change.

import { isOutdoorLiving, type Context } from '../context';
import { functionalProfile } from '../mapgen/generate';
import { sharedNode } from '../pathfinding';
import { chance, cloneRng } from '../rng';
import type { Building, BuildingId, Car, CarId, Sim, World } from '../state';
import { bite, destroyZombie, killSim } from './combat';
import { entranceNearest, isLiving, leaveTalk, setDestination } from './common';
import { modeOf, type Mode } from './panic';
import { carLeaves, headForExit, nearestExit } from './exits';
import { barrierAt } from './cordon';
import { emitStimulus } from './stimuli';

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
      if (car.state === 'driving' || car.state === 'gone') continue;
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

  /** Standing cars (parked or abandoned) whose centre is within r of the point, ascending id. */
  near(x: number, y: number, r: number, out: number[]): number[] {
    out.length = 0;
    if (this.cols === 0) return out;
    const c0x = this.col(x - r), c1x = this.col(x + r), c0y = this.col(y - r), c1y = this.col(y + r);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        for (const id of this.cells[cy * this.cols + cx]!) {
          const c = this.cars[id]!;
          if (Math.hypot(c.x - x, c.y - y) <= r && !out.includes(id)) out.push(id);
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** Cars on the move this tick, ascending id. */
  driving(): readonly Car[] {
    return this.moving;
  }

  /** Whether the point lies within a car's rectangle. */
  blocks(x: number, y: number): boolean {
    return this.standing(x, y) || this.drivingAt(x, y);
  }

  /** Whether the point lies within a parked or abandoned car: one a sim can climb over. */
  standing(x: number, y: number): boolean {
    if (this.cols === 0) return false;
    for (const id of this.cells[this.col(y) * this.cols + this.col(x)]!) if (inside(this.cars[id]!, x, y, this.halfL, this.halfW)) return true;
    return false;
  }

  /** Whether the point lies within a car on the move. */
  drivingAt(x: number, y: number): boolean {
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

function addCar(world: World, ctx: Context, x: number, y: number, heading: number, spaced: boolean, home: BuildingId | null = null, kind: Car['kind'] = 'car'): Car | null {
  const cc = world.config.cars;
  if (!ctx.map.walkable(x, y)) return null;
  if (spaced) for (const c of world.cars) if (Math.hypot(c.x - x, c.y - y) < cc.spacing) return null;
  const car: Car = {
    id: world.cars.length as CarId,
    state: 'parked',
    kind,
    home,
    job: null,
    patient: null,
    exit: null,
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
    reroutes: 0,
    impact: null,
    alarm: false,
    alarmUntil: null,
  };
  world.cars.push(car);
  return car;
}

/** A truck pulled up at (x, y), facing `heading`, for the rescue (rescue.ts): a van to look at. */
export function parkTruck(world: World, ctx: Context, x: number, y: number, heading: number): Car | null {
  return addCar(world, ctx, x, y, heading, false, null, 'van');
}

/** Whether a police station or hospital has a yard of its own (map generation, when it fit). */
export function hasYard(world: World, b: Building): boolean {
  return world.lots.some((l) => l.home === b.id);
}

/** A service vehicle in a bay of its home's yard; failing that, at the kerb by its door or the nearest clear spot along the street; null if there is none. */
export function parkVan(world: World, ctx: Context, b: Building, kind: Car['kind'] = 'van'): Car | null {
  // In its yard first, in the first free bay.
  for (const lot of world.lots) {
    if (lot.home !== b.id) continue;
    for (const p of bays(world, lot)) {
      if (world.cars.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < world.config.cars.stall.width * 0.9)) continue;
      const v = addCar(world, ctx, p.x, p.y, p.heading, false, b.id, kind);
      if (v !== null) return v;
    }
  }
  const e = b.entrances[0]!;
  const s = world.streets[b.street]!;
  const a = world.nodes[s.a]!, n = world.nodes[s.b]!;
  const len = Math.hypot(n.x - a.x, n.y - a.y) || 1;
  const ux = (n.x - a.x) / len, uy = (n.y - a.y) / len;
  const step = world.config.cars.spacing;
  for (const d of [0, step, -step, 2 * step, -2 * step, 3 * step, -3 * step]) {
    const k = kerbBy(world, b, e.x + ux * d, e.y + uy * d);
    if (k === null) continue;
    const van = addCar(world, ctx, k.x, k.y, k.heading, true, b.id, kind);
    if (van !== null) return van;
  }
  return null;
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
  // The mall's stalls: double rows nose to nose, either side of the driveway. (A yard's
  // bays are for its own vehicles: parkVan.)
  for (const lot of world.lots) {
    if (lot.home !== null) continue;
    for (const p of bays(world, lot)) if (chance(rng, cc.lotShare)) addCar(world, ctx, p.x, p.y, p.heading, false);
  }
}

/** A lot's stalls, as drawn: double rows nose to nose either side of the driveway, front rows first. */
function bays(world: World, lot: World['lots'][number]): { x: number; y: number; heading: number }[] {
  const st = world.config.cars.stall;
  const out: { x: number; y: number; heading: number }[] = [];
  {
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
          const p = at(u, row);
          out.push({ x: p.x, y: p.y, heading });
        }
      }
    }
  }
  return out;
}

// Choosing a car, and boarding

/**
 * Whether anyone may take this parked vehicle. An ordinary car, always. A service
 * vehicle only once nobody living is left to drive it: an ambulance's crew, or the
 * officers of a police car's or SWAT van's station, all dead or turned. Taking one
 * from a staffed hospital or station would quietly end its service for the run. A
 * rescue truck (a van with no home) is the Army's, never.
 */
function takeable(world: World, car: Car): boolean {
  if (car.kind === 'car') return true;
  if (car.home === null) return false;
  if (car.kind === 'ambulance') return !world.sims.some((s) => s.crew === car.id && isLiving(s));
  return !world.sims.some((s) => s.station === car.home && isLiving(s));
}

/**
 * An aware sim on foot heading for home or shelter far away takes the nearest free
 * parked car it can see within searchRadius, and walks to it. Staggered by id. The
 * building it meant to reach goes with the car (`Car.destinationBuilding`).
 */
export function considerDriving(world: World, ctx: Context, sim: Sim, mode: Mode): boolean {
  const { config, tick, cars } = world;
  const cc = config.cars;
  if (mode === 'flight' || sim.awareAt === null || sim.car !== null || sim.station !== null) return false;
  const leaving = sim.destinationKind === 'leave';
  if (sim.destination === null || (!leaving && (sim.destinationKind !== 'shelter' || sim.destinationBuilding === null))) return false;
  if ((sim.id + tick) % config.roles.interval !== 0) return false;
  if (Math.hypot(sim.destination.x - sim.x, sim.destination.y - sim.y) <= cc.driveBeyond) return false;
  let best: Car | null = null;
  let bestD = Infinity;
  for (const id of ctx.cars.near(sim.x, sim.y, cc.searchRadius, ctx.ids2)) {
    const c = cars[id]!;
    if (c.state !== 'parked' || c.claimedBy !== null) continue;
    const d = Math.hypot(c.x - sim.x, c.y - sim.y);
    if (d >= bestD || !ctx.map.lineOfSight(sim.x, sim.y, c.x, c.y) || !takeable(world, c)) continue;
    best = c;
    bestD = d;
  }
  if (best === null) return false;
  best.claimedBy = sim.id;
  best.destinationBuilding = sim.destinationBuilding;
  best.exit = leaving ? nearestExit(world, sim.destination.x, sim.destination.y) : null;
  sim.boarding = best.id;
  sim.destinationKind = 'car';
  sim.destinationBuilding = null;
  sim.destination = { x: best.x, y: best.y };
  sim.route = [];
  sim.routeIndex = 0;
  return true;
}

/** Whether the car this sim is walking to is still its to take. */
export function carStillMine(world: World, sim: Sim): boolean {
  const c = sim.boarding === null ? null : world.cars[sim.boarding]!;
  return c !== null && c.state === 'parked' && c.claimedBy === sim.id;
}

/** Gives up walking to a car: back on foot toward the building it meant to drive to. */
export function giveUpCar(world: World, sim: Sim): void {
  const c = sim.boarding === null ? null : world.cars[sim.boarding]!;
  sim.boarding = null;
  if (c !== null && c.claimedBy === sim.id) c.claimedBy = null;
  const b = c?.destinationBuilding ?? null;
  if (c !== null && c.exit !== null) headForExit(world, sim);
  else if (b !== null) setDestination(sim, world.buildings[b]!, 'shelter');
  else {
    sim.destinationKind = null;
    sim.destination = null;
  }
}

/** Where a car pulls up for a building: its street, beside the door, to the right of the way in. */
function pullUpBy(world: World, b: Building, x: number, y: number): { x: number; y: number } {
  const cc = world.config.cars;
  const s = world.streets[b.street]!;
  const a = world.nodes[s.a]!, n = world.nodes[s.b]!;
  const len = Math.hypot(n.x - a.x, n.y - a.y) || 1;
  const ux = (n.x - a.x) / len, uy = (n.y - a.y) / len;
  const t0 = Math.min(len, Math.max(0, (x - a.x) * ux + (y - a.y) * uy));
  const side = Math.sign((x - a.x) * -uy + (y - a.y) * ux) || 1;
  // At the kerb, like a parked car, in the first gap along it from the door: pulled up
  // in the lane, it stood where the next car drove, and the next one up to the same
  // door stopped on top of it.
  const kerb = Math.max(Math.min(cc.laneOffset, s.width / 4), s.width / 2 - cc.kerbInset);
  const at = (t: number) => ({ x: a.x + ux * t - uy * kerb * side, y: a.y + uy * t + ux * kerb * side });
  for (let k = 0; k <= cc.pullUpTries; k++) {
    for (const sign of k === 0 ? [1] : [1, -1]) {
      const t = t0 + sign * k * cc.spacing;
      if (t < 0 || t > len) continue;
      const p = at(t);
      if (!world.cars.some((c) => c.state !== 'gone' && c.state !== 'driving' && Math.hypot(c.x - p.x, c.y - p.y) < cc.spacing)) return p;
    }
  }
  return at(t0); // no gap: up to the door anyway, and it stops short of whatever is there
}

/** Everyone gets out beside the car, on foot again, each toward the building they meant to reach. */
function alight(world: World, ctx: Context, car: Car): void {
  const cc = world.config.cars;
  const b = car.destinationBuilding === null ? null : world.buildings[car.destinationBuilding]!;
  // The kerb side first, then the other.
  const nx = -Math.sin(car.heading), ny = Math.cos(car.heading);
  const out = cc.width / 2 + 0.8;
  for (const [k, id] of car.occupants.entries()) {
    const s = world.sims[id]!;
    s.car = null;
    let placed = false;
    for (const side of [1, -1]) {
      const px = car.x + nx * out * side + Math.cos(car.heading) * (k - 1) * 0.8;
      const py = car.y + ny * out * side + Math.sin(car.heading) * (k - 1) * 0.8;
      if (ctx.map.walkable(px, py) && !ctx.cars.blocks(px, py)) {
        s.x = px;
        s.y = py;
        placed = true;
        break;
      }
    }
    // Neither side clear (a car run into a building, or wedged among others): out
    // wherever there is ground nearby — a ring at a time, behind first. Put down where
    // the car stood, people from a crash were left inside the building it had hit.
    for (let r = out; !placed && r <= cc.length * 2; r += 0.8) {
      for (let k2 = 0; k2 < 8 && !placed; k2++) {
        const a = car.heading + Math.PI + (k2 % 2 === 0 ? 1 : -1) * Math.ceil(k2 / 2) * (Math.PI / 4);
        const px = car.x + Math.cos(a) * r, py = car.y + Math.sin(a) * r;
        if (ctx.map.walkable(px, py) && !ctx.cars.blocks(px, py)) {
          s.x = px;
          s.y = py;
          placed = true;
        }
      }
    }
    if (!placed) {
      s.x = car.x;
      s.y = car.y;
    }
    s.gait = 'walk';
    s.route = []; // routed afresh from where it got out
    s.routeIndex = 0;
    if (s.condition !== 'healthy' && s.condition !== 'infected') continue;
    if (b !== null && s.squadLeader === null && s.crew === null && s.carriedBy === null && s.answering === null) setDestination(s, b, 'shelter'); // a squad, a crew, its patient and officers on a call go where they are taken
  }
  car.occupants = [];
  car.speed = 0;
  car.route = [];
  car.routeIndex = 0;
  car.destination = null;
  car.destinationBuilding = null;
  car.exit = null; // anyone making for an exit goes on, on foot
  car.blockedSince = null;
}

/** Gets in to drive, with any aware companions on foot beside it bound for the same building, up to capacity. */
function board(world: World, ctx: Context, sim: Sim, car: Car): void {
  const { config, buildings, sims } = world;
  const cc = config.cars;
  if (car.exit !== null) return boardForExit(world, ctx, sim, car);
  const b = buildings[car.destinationBuilding!]!;
  const takeIn = (s: Sim) => {
    if (s.gathering !== null) leaveTalk(s, world.tick);
    s.car = car.id;
    s.boarding = null;
    s.gait = 'still';
    s.x = car.x;
    s.y = car.y;
    car.occupants.push(s.id);
  };
  takeIn(sim);
  car.claimedBy = null;
  ctx.simHash.query(car.x, car.y, cc.boardRadius * 2, ctx.ids2);
  for (const id of ctx.ids2) {
    if (car.occupants.length >= cc.capacity) break;
    const o = sims[id]!;
    if (o.id === sim.id || !isOutdoorLiving(o) || o.awareAt === null || o.destinationBuilding !== b.id) continue;
    takeIn(o);
  }
  const e = entranceNearest(b, car.x, car.y);
  car.destination = pullUpBy(world, b, e.x, e.y);
  const route = ctx.paths.route(sim, car.destination.x, car.destination.y, true);
  if (route === null) {
    alight(world, ctx, car);
    return;
  }
  car.state = 'driving';
  soundAlarm(world, ctx, car);
  vehicleTaken(world, ctx, car, sim);
  car.route = route;
  car.routeIndex = 0;
  car.blockedSince = null;
  for (const id of car.occupants) {
    const s = sims[id]!;
    s.destinationKind = 'shelter';
    s.destinationBuilding = b.id;
    s.destination = { x: e.x, y: e.y };
  }
}

/**
 * A squad gets into its van together, the leader driving, for a building's door or a
 * point on a street. False, and
 * nobody aboard, if there is no way there by road.
 */
export function boardSquad(world: World, ctx: Context, car: Car, members: Sim[], to: { x: number; y: number; building: Building | null }): boolean {
  const leader = members[0]!;
  const target = to.building;
  const dest = target === null ? { x: to.x, y: to.y } : pullUpBy(world, target, entranceNearest(target, car.x, car.y).x, entranceNearest(target, car.x, car.y).y);
  const route = ctx.paths.route(leader, dest.x, dest.y, true);
  if (route === null) return false;
  for (const s of members) {
    if (s.gathering !== null) leaveTalk(s, world.tick);
    s.car = car.id;
    s.boarding = null;
    s.gait = 'still';
    s.x = car.x;
    s.y = car.y;
    car.occupants.push(s.id);
  }
  car.claimedBy = null;
  car.destinationBuilding = target?.id ?? null;
  car.destination = dest;
  car.state = 'driving';
  soundAlarm(world, ctx, car);
  car.route = route;
  car.routeIndex = 0;
  car.blockedSince = null;
  return true;
}

/** Gets in to drive off the map, with any on foot beside it making for the same exit, up to capacity. */
function boardForExit(world: World, ctx: Context, sim: Sim, car: Car): void {
  const cc = world.config.cars;
  const e = world.exits[car.exit!]!;
  const others: Sim[] = [];
  ctx.simHash.query(car.x, car.y, cc.boardRadius * 2, ctx.ids2);
  for (const id of ctx.ids2) {
    const o = world.sims[id]!;
    if (others.length + 1 >= cc.capacity) break;
    if (o.id === sim.id || !isOutdoorLiving(o) || o.destinationKind !== 'leave' || o.destination === null) continue;
    if (Math.hypot(o.destination.x - e.x, o.destination.y - e.y) > 1) continue;
    others.push(o);
  }
  const exit = car.exit;
  if (!boardSquad(world, ctx, car, [sim, ...others], { x: e.x, y: e.y, building: null })) {
    car.exit = null;
    return;
  }
  car.exit = exit;
  for (const s of car.occupants.map((id) => world.sims[id]!)) {
    s.destinationKind = 'leave';
    s.destination = { x: e.x, y: e.y };
    s.route = []; // the walk to the car's: kept, it had them out of the car and on straight for the edge, into the margin
    s.routeIndex = 0;
  }
  vehicleTaken(world, ctx, car, sim);
}

/** Someone with no claim to it drives off in a service vehicle (its crew all gone): said, so the viewer knows why it heads off. */
function vehicleTaken(world: World, ctx: Context, car: Car, sim: Sim): void {
  if (car.kind === 'car') return;
  ctx.events.push({ type: 'vehicleTaken', tick: world.tick, car: car.id, kind: car.kind, leaving: car.exit !== null, sim: sim.id, x: car.x, y: car.y });
}

/** Arms the alarms of a share of ordinary cars, from a copy of the run's stream so that nothing else at setup moves. Called once at setup. */
export function armAlarms(world: World): void {
  const rng = cloneRng(world.rng);
  for (const car of world.cars) if (car.kind === 'car') car.alarm = chance(rng, world.config.cars.alarm.share);
}

/** An armed alarm goes off: once, loud and brief, and then it is spent. */
function soundAlarm(world: World, ctx: Context, car: Car): void {
  if (!car.alarm || !world.config.features.carAlarms) return;
  car.alarm = false;
  car.alarmUntil = world.tick + world.config.cars.alarm.ticks;
  emitStimulus(world, car.x, car.y, 'alarm', world.config.cars.alarm.noise, false, world.config.cars.alarm.intensity);
  ctx.events.push({ type: 'carAlarm', tick: world.tick, car: car.id, x: car.x, y: car.y, sim: null });
}

/** Car processes, in building processes (step 10): alarms, stale claims, boarding, arriving, abandoning. */
export function carProcesses(world: World, ctx: Context): void {
  const { config, tick, cars, sims } = world;
  const cc = config.cars;
  // Alarms sounding: a blast every alarm.every ticks until it stops (the first came as it went off).
  for (const car of cars) {
    if (car.alarmUntil === null) continue;
    if (tick >= car.alarmUntil) car.alarmUntil = null;
    else if ((car.alarmUntil - tick) % cc.alarm.every === 0) emitStimulus(world, car.x, car.y, 'alarm', cc.alarm.noise, false, cc.alarm.intensity);
  }
  for (const car of cars) {
    if (car.state === 'parked' && car.claimedBy !== null) {
      const s = sims[car.claimedBy]!;
      if (!isOutdoorLiving(s) || s.boarding !== car.id || s.destinationKind !== 'car') car.claimedBy = null;
    }
  }
  for (const sim of sims) {
    if (sim.boarding === null || sim.destinationKind !== 'car' || !isOutdoorLiving(sim)) continue;
    const car = cars[sim.boarding]!;
    if (car.state !== 'parked' || car.claimedBy !== sim.id) continue;
    if (Math.hypot(car.x - sim.x, car.y - sim.y) <= cc.boardRadius + cc.length / 2) board(world, ctx, sim, car);
  }
  for (const car of cars) {
    if (car.state !== 'driving') continue;
    // Nobody able to drive is left (stage 4: turned inside): it stops where it is.
    if (car.occupants.length === 0) {
      car.state = 'abandoned';
      alight(world, ctx, car);
      continue;
    }
    // At a closed barrier (cordon.ts): left where it stopped, and they go on on foot to
    // wait at it. The cars behind stop behind it.
    if (car.exit !== null && world.exits[car.exit]!.closedAt !== null) {
      const b = barrierAt(world, world.exits[car.exit]!);
      if (Math.hypot(b.x - car.x, b.y - car.y) <= config.cordon.barrierReach) {
        car.state = 'abandoned';
        ctx.events.push({ type: 'carAbandoned', tick, car: car.id, x: car.x, y: car.y, sim: null });
        alight(world, ctx, car);
        continue;
      }
    }
    const last = car.routeIndex >= car.route.length - 1;
    // Arrived: on its spot at the kerb (a way off the map, within arriveRadius), or
    // stopped within arriveRadius of it behind something. Parking anywhere within
    // arriveRadius left cars parked across the next car along the kerb.
    const toGo = car.destination === null ? Infinity : Math.hypot(car.destination.x - car.x, car.destination.y - car.y);
    if (last && (toGo <= (car.exit !== null ? cc.arriveRadius : cc.parkWithin) || (car.blockedSince !== null && toGo <= cc.arriveRadius))) {
      // At a way off the map: everyone in it, and the car, out of play (exits.ts).
      if (car.exit !== null) {
        carLeaves(world, ctx, car);
        continue;
      }
      car.state = 'parked';
      alight(world, ctx, car);
      continue;
    }
    // It hit a building or another car (movement stopped it): hard enough, a wreck.
    if (car.impact !== null) {
      const v = car.impact;
      car.impact = null;
      if (v >= cc.crashMin) {
        crash(world, ctx, car, v);
        continue;
      }
    }
    // Driving into the dead, its driver in flight: each in its path is knocked down — at
    // ramKill destroyed — and the impact slows it.
    if (car.speed > 0 && modeOf(sims[car.occupants[0]!]!, config) === 'flight') ram(world, ctx, car);
    // The dead at the doors: each awake one breaks in at breakIn a tick.
    ctx.zombieHash.query(car.x, car.y, cc.length / 2 + config.combat.contactRange, ctx.ids2);
    let at = 0;
    for (const id of ctx.ids2) {
      const z = world.zombies[id]!;
      if (z.state === 'active' || z.state === 'wandering') at++;
    }
    // The dead tearing at it with people inside: its alarm, if armed, tells the district.
    if (at > 0) soundAlarm(world, ctx, car);
    if (at > 0 && chance(world.rng, 1 - (1 - cc.breakIn) ** at)) {
      car.state = 'abandoned';
      ctx.events.push({ type: 'carAbandoned', tick, car: car.id, x: car.x, y: car.y, sim: null });
      alight(world, ctx, car);
      continue;
    }
    // Stopped a while: back to the junction behind it and another way round, if there
    // is one. Without this a car sat behind a wreck until it was abandoned too, and the
    // car behind it in turn: one abandoned car could strand a street of them.
    if (car.blockedSince !== null && tick - car.blockedSince >= cc.rerouteAfter && car.reroutes < cc.maxReroutes && reroute(world, ctx, car)) continue;
    if (car.blockedSince !== null && tick - car.blockedSince >= cc.jamTicks) {
      car.state = 'abandoned';
      ctx.events.push({ type: 'carAbandoned', tick, car: car.id, x: car.x, y: car.y, sim: null });
      alight(world, ctx, car);
    }
  }
}

/**
 * Turns a car stopped behind a wreck back: out of the street it is on by the junction
 * behind it, on a route that never uses that street again. False, and nothing changed, with no other
 * way (or nowhere it is going). Counted, so a car boxed in is still abandoned in time.
 */
function reroute(world: World, ctx: Context, car: Car): boolean {
  if (car.destination === null || car.occupants.length === 0) return false;
  // Only behind a wreck: the nearest car ahead in its lane is abandoned. In the back of a
  // queue, turning round only blocked the cars beside it — in a city-wide jam it cost
  // half the people who got out in the hour (seed 11, after the broadcast).
  const cc = world.config.cars;
  const look = cc.length + cc.gap;
  const hc = Math.cos(car.heading), hs = Math.sin(car.heading);
  let nearest: Car | null = null, best = Infinity;
  const ahead = (o: Car) => {
    if (o === car || o.state === 'gone' || o.state === 'parked') return;
    const dx = o.x - car.x, dy = o.y - car.y;
    const along = dx * hc + dy * hs;
    if (along <= 0 || along > look || Math.abs(-dx * hs + dy * hc) >= cc.width || along >= best) return;
    nearest = o;
    best = along;
  };
  for (const id of ctx.cars.near(car.x, car.y, look, ctx.ids2)) ahead(world.cars[id]!);
  for (const o of ctx.cars.driving()) ahead(o);
  if (nearest === null || (nearest as Car).state !== 'abandoned') return false;
  const street = car.route[Math.min(car.routeIndex, car.route.length - 1)];
  if (street === undefined) return false;
  const st = world.streets[street]!;
  const a = world.nodes[st.a]!, b = world.nodes[st.b]!;
  const c = Math.cos(car.heading), s = Math.sin(car.heading);
  // Behind it: the end its heading points away from.
  const behind = (a.x - car.x) * c + (a.y - car.y) * s <= (b.x - car.x) * c + (b.y - car.y) * s ? st.a : st.b;
  const driver = world.sims[car.occupants[0]!]!;
  const route = ctx.paths.route(driver, car.destination.x, car.destination.y, false, { node: behind, avoid: street });
  car.reroutes++;
  if (route === null) return false;
  car.route = route;
  car.routeIndex = 0;
  car.blockedSince = null;
  return true;
}

/** A wreck: abandoned where it stands for good; each person inside dies at crashKill × (speed / maxSpeed)², and the rest get out. */
function crash(world: World, ctx: Context, car: Car, speed: number): void {
  const cc = world.config.cars;
  const p = cc.crashKill * Math.min(1, (speed / cc.maxSpeed) ** 2);
  let dead = 0;
  for (const id of car.occupants) {
    const s = world.sims[id]!;
    if (!chance(world.rng, p)) continue;
    s.x = car.x;
    s.y = car.y;
    killSim(world, ctx, s, 'crash');
    dead++;
  }
  car.state = 'abandoned';
  ctx.events.push({ type: 'carCrashed', tick: world.tick, car: car.id, dead, sim: null, x: car.x, y: car.y });
  alight(world, ctx, car);
}

/** The dead in a moving car's path, at its front: struck, each destroyed at ramKill, else thrown along its path; it slows for each. */
function ram(world: World, ctx: Context, car: Car): void {
  const cc = world.config.cars;
  const hc = Math.cos(car.heading), hs = Math.sin(car.heading);
  ctx.zombieHash.query(car.x, car.y, cc.length, ctx.ids2);
  for (const id of ctx.ids2) {
    const z = world.zombies[id]!;
    if (z.state === 'destroyed' || z.state === 'occupying') continue;
    const dx = z.x - car.x, dy = z.y - car.y;
    const along = dx * hc + dy * hs;
    if (along < 0 || along > cc.length / 2 + world.config.combat.contactRange || Math.abs(-dx * hs + dy * hc) >= cc.width / 2 + 0.5) continue;
    const thrown = cc.knockBack[0] + (cc.knockBack[1] - cc.knockBack[0]) * Math.min(1, car.speed / cc.maxSpeed);
    car.speed *= cc.ramSlow;
    const killed = chance(world.rng, cc.ramKill);
    const lx = z.x + hc * thrown, ly = z.y + hs * thrown; // where it lands
    const lands = ctx.map.walkable(lx, ly);
    ctx.events.push({ type: 'carHit', tick: world.tick, x: z.x, y: z.y, dx: hc, dy: hs, distance: lands ? thrown : 0, killed, sim: null });
    if (lands) {
      z.x = lx;
      z.y = ly;
    }
    if (!killed) continue;
    const driver = world.sims[car.occupants[0]!]!;
    destroyZombie(world, z, driver);
    ctx.events.push({ type: 'zombieDestroyed', tick: world.tick, zombie: z.id, by: driver.id, x: z.x, y: z.y });
  }
}

// Driving

/** Something in this car's path, within gap ahead and a car's width either side. */
function ahead(car: Car, x: number, y: number, reach: number, half: number): boolean {
  const dx = x - car.x, dy = y - car.y;
  const c = Math.cos(car.heading), s = Math.sin(car.heading);
  const along = dx * c + dy * s;
  return along > 0 && along <= reach && Math.abs(-dx * s + dy * c) <= half;
}

/**
 * Car decisions (step 6, after the sims'): heading for the next junction, kept right of
 * the centreline, or for the kerb at the end; stopped by anything ahead — standing
 * abandoned cars, people, the dead, moving cars — the lower id yielding when two
 * moving cars stop for each other; slowed by congestion. Writes heading and speed only.
 */
export function decideCars(world: World, ctx: Context): void {
  const { config, tick, nodes, streets, sims, zombies, cars } = world;
  const cc = config.cars;
  const moving = ctx.cars.driving();
  const reach = cc.gap + cc.length / 2;
  const blockers = new Map<number, number[]>(); // moving car → moving cars stopping it
  const other = new Set<number>(); // moving cars stopped by anything else
  const roomOf = new Map<number, number>(); // moving car → metres it can go before touching what is ahead (read by id, never iterated)
  const wantOf = new Map<number, number>(); // moving car → the heading it is turning toward
  const softOf = new Map<number, number>(); // moving car → room it eases off for (less what it is swerving round)
  const cornerOf = new Map<number, number>(); // moving car → the most it may do now to take the next junction's turn

  for (const car of moving) {
    // Where to now: the next junction, offset right of the way there, or the kerb.
    let tx = car.destination!.x, ty = car.destination!.y;
    while (car.routeIndex < car.route.length - 1) {
      const n = sharedNode(world, car.route[car.routeIndex]!, car.route[car.routeIndex + 1]!);
      if (n === null) {
        car.routeIndex = car.route.length - 1;
        break;
      }
      // Along the street toward the junction; passed once level with it (at speed a
      // car can step past a point, never back past a line).
      const node = nodes[n]!;
      const st = streets[car.route[car.routeIndex]!]!;
      const far = nodes[st.a === n ? st.b : st.a]!;
      const len = Math.hypot(node.x - far.x, node.y - far.y) || 1;
      const ux = (node.x - far.x) / len, uy = (node.y - far.y) / len;
      if ((car.x - far.x) * ux + (car.y - far.y) * uy >= len - cc.waypointRadius) {
        car.routeIndex++;
        continue;
      }
      const lane = Math.min(cc.laneOffset, st.width / 4);
      const jx = node.x - uy * lane, jy = node.y + ux * lane; // the junction, in its lane
      // Keeping to its lane: aim a little way ahead of where it is along the lane, not
      // straight at the junction. Aiming at the junction, a car thrown wide by a turn, or
      // joining from a yard or a lot, closed on its lane over a whole street at a shallow
      // angle — and ran along the walls of alleys and into the buildings beside them.
      // Off the street altogether (pulling out of a yard, a bay or a lot), it makes for the
      // nearest of it first: aimed a lookahead along, the point lay past the corner of the
      // building beside it, and it cut through the wall.
      const lat = Math.abs(-(car.x - far.x) * uy + (car.y - far.y) * ux);
      const along = Math.max(0, Math.min(len, (car.x - far.x) * ux + (car.y - far.y) * uy)) + (lat > st.width / 2 ? 0 : cc.lookahead);
      if (along >= len) {
        tx = jx;
        ty = jy;
      } else {
        tx = far.x + ux * along - uy * lane;
        ty = far.y + uy * along + ux * lane;
      }
      // The turn it makes there: slow enough by the junction to take it, and braking in
      // time for it. Swinging wide round corners at speed, cars drove into the buildings
      // on them.
      const next = streets[car.route[car.routeIndex + 1]!]!;
      const beyond = nodes[next.a === n ? next.b : next.a]!;
      const nl = Math.hypot(beyond.x - node.x, beyond.y - node.y) || 1;
      const turnCos = ux * ((beyond.x - node.x) / nl) + uy * ((beyond.y - node.y) / nl);
      const corner = cc.maxSpeed * Math.max(cc.turnSlow, turnCos);
      cornerOf.set(car.id, corner + Math.hypot(jx - car.x, jy - car.y) * cc.approach);
      break;
    }
    wantOf.set(car.id, tx !== car.x || ty !== car.y ? Math.atan2(ty - car.y, tx - car.x) : car.heading);
    // A driver in flight does not stop for the dead: it drives into them (carProcesses rams).
    const driver = car.occupants.length > 0 ? sims[car.occupants[0]!]! : null;
    const rams = driver !== null && modeOf(driver, config) === 'flight';

    const stoppedBy: number[] = [];
    for (const o of moving) if (o !== car && ahead(car, o.x, o.y, reach, cc.width)) stoppedBy.push(o.id);
    blockers.set(car.id, stoppedBy);
    let blocked = false;
    for (const id of ctx.cars.near(car.x, car.y, reach, ctx.ids2)) {
      const o = cars[id]!;
      if (o.state === 'abandoned' && ahead(car, o.x, o.y, reach, cc.width)) blocked = true;
    }
    // Anyone on foot in its path, the living and (unless it rams them) the dead: how far
    // ahead, and how far to one side of its line.
    const look = cc.maxSpeed + cc.length + cc.gap;
    const hc = Math.cos(car.heading), hs = Math.sin(car.heading);
    const inPath: { x: number; y: number; along: number; lat: number }[] = [];
    const onFoot = (x: number, y: number) => {
      const dx = x - car.x, dy = y - car.y;
      const along = dx * hc + dy * hs, lat = -dx * hs + dy * hc;
      if (along > 0 && along <= look && Math.abs(lat) < cc.width / 2 + 0.5) inPath.push({ x, y, along, lat });
    };
    ctx.simHash.query(car.x, car.y, look, ctx.ids2);
    for (const id of ctx.ids2) onFoot(sims[id]!.x, sims[id]!.y);
    if (!rams) {
      ctx.zombieHash.query(car.x, car.y, look, ctx.ids2);
      for (const id of ctx.ids2) onFoot(zombies[id]!.x, zombies[id]!.y);
    }
    inPath.sort((p, q) => p.along - q.along);
    // The nearest, swerved round rather than braked for, if the car is moving, they are
    // not on top of it, and the road beside them is clear: the car aims to pass them on
    // the far side of where they stand, and keeps its speed for it.
    let swerved: (typeof inPath)[number] | null = null;
    const first = inPath[0];
    const street = streets[car.route[Math.min(car.routeIndex, car.route.length - 1)]!];
    if (first && street && car.speed >= cc.swerveFrom && first.along > cc.length / 2 + cc.personGap) {
      // Only on the carriageway: within the street, a car's half-width in from its edge.
      // Aimed only beside them, a swerve could leave the road and run into the buildings.
      const sa = nodes[street.a]!, sb = nodes[street.b]!;
      const onRoad = (x: number, y: number) => {
        const dx = sb.x - sa.x, dy = sb.y - sa.y;
        const t = Math.max(0, Math.min(1, ((x - sa.x) * dx + (y - sa.y) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(x - sa.x - dx * t, y - sa.y - dy * t) <= street.width / 2 - cc.width / 2;
      };
      const side = first.lat >= 0 ? 1 : -1;
      const off = cc.width / 2 + 0.5 + cc.swerveClear;
      const ax = first.x + hs * side * off, ay = first.y - hc * side * off; // beside them, away from their side
      if (onRoad(ax, ay) && onRoad((car.x + ax) / 2, (car.y + ay) / 2) && ctx.cars.near(ax, ay, cc.length, ctx.ids2).length === 0) {
        swerved = first;
        wantOf.set(car.id, Math.atan2(ay - car.y, ax - car.x));
      }
    }
    if (!blocked && inPath.some((p) => p !== swerved && p.along <= reach)) blocked = true;
    if (blocked) other.add(car.id);
    // Room to move before touching an abandoned or moving car ahead: a car stopped only
    // for what was within `reach` of it, and at up to maxSpeed a tick one just beyond
    // reach ended the next tick on top of it — overlapping cars, frozen so when abandoned.
    // Parked cars stand at the kerb, clear of the lane (pullUpBy): counting them stopped
    // every car pulling out from the kerb behind the next one along, until abandoned.
    let room = Infinity;
    const fit = (o: Car) => {
      if (o === car || o.state === 'gone' || o.state === 'parked') return;
      const dx = o.x - car.x, dy = o.y - car.y;
      const c = Math.cos(car.heading), sn = Math.sin(car.heading);
      const along = dx * c + dy * sn;
      if (along <= 0 || along > look || Math.abs(-dx * sn + dy * c) >= cc.width) return;
      room = Math.min(room, along - cc.length - cc.clearance);
    };
    for (const id of ctx.cars.near(car.x, car.y, look, ctx.ids2)) fit(cars[id]!);
    for (const o of moving) fit(o);
    // And before reaching anyone on foot in its path: never closer than personGap (the
    // hard limit), and easing off for them unless swerving round them (the soft one).
    let soft = room;
    for (const p of inPath) {
      const r = p.along - cc.length / 2 - cc.personGap;
      room = Math.min(room, r);
      if (p !== swerved) soft = Math.min(soft, r);
    }
    softOf.set(car.id, Math.max(0, soft));
    roomOf.set(car.id, Math.max(0, room));
    if (room < cc.clearance) other.add(car.id);
  }

  for (const car of moving) {
    // Two moving cars stopped by each other: the lower id yields, the higher goes.
    const stoppedBy = blockers.get(car.id)!.filter((id) => !(id < car.id && blockers.get(id)!.includes(car.id)));
    const blocked = other.has(car.id) || stoppedBy.length > 0;
    const room = roomOf.get(car.id)!;
    // Turning toward where it is going, no faster than its turning circle allows at its
    // speed, and slowing for a sharp turn: it swung round on the spot at full speed.
    const err = Math.atan2(Math.sin(wantOf.get(car.id)! - car.heading), Math.cos(wantOf.get(car.id)! - car.heading));
    let target = 0;
    if (blocked) car.blockedSince ??= tick;
    else {
      if (car.speed !== 0) car.blockedSince = null; // (one stopped by walls last tick stays blocked)
      let near = 0;
      for (const o of moving) if (o !== car && Math.hypot(o.x - car.x, o.y - car.y) <= cc.congestionRadius) near++;
      target = cc.maxSpeed / (1 + cc.congestion * near);
      if (car.routeIndex >= car.route.length - 1) target = Math.min(target, Math.hypot(car.destination!.x - car.x, car.destination!.y - car.y));
      target *= Math.max(cc.turnSlow, Math.cos(err));
      target = Math.min(target, cornerOf.get(car.id) ?? Infinity);
      target = Math.min(target, softOf.get(car.id)! * cc.approach); // easing off as it closes on what is ahead
    }
    // Inertia: speed closes on the target, braking harder than it picks up.
    car.speed += (target - car.speed) * (target > car.speed ? cc.accel : cc.brake);
    if (target === 0 && car.speed < cc.stopBelow) car.speed = 0;
    car.speed = Math.min(car.speed, room); // and never into anything
    const turn = Math.max(cc.turnMin, car.speed / cc.turnRadius);
    const want = Math.max(-turn, Math.min(turn, err));
    // Below crash speed, never further into a building: turning tightly at a crawl, a
    // car's corners swung through the walls on the inside of the turn. The turn it wants,
    // or less of it, at its speed or less; stopped if nothing keeps it clear. (At speed,
    // hitting a building is a crash: moveCars.)
    if (car.speed >= cc.crashMin) car.heading += want;
    else {
      const now = inWalls(world, ctx, car.x, car.y, car.heading);
      let done = false;
      // Turning toward where it is going, or less; failing that, away from the wall.
      const turns = [...[1, ...cc.wallTurn].map((f) => want * f), ...cc.wallTurn.filter((f) => f > 0).flatMap((f) => [turn * f, -turn * f]), turn, -turn];
      for (const v of [1, ...cc.wallSpeed]) {
        for (const t of turns) {
          const h = car.heading + t, sp = car.speed * v;
          if (h === car.heading && sp === 0) continue; // standing still is not a way out
          if (inWalls(world, ctx, car.x + Math.cos(h) * sp, car.y + Math.sin(h) * sp, h) > now) continue;
          car.heading = h;
          car.speed = sp;
          done = true;
          break;
        }
        if (done) break;
      }
      // Nothing forward keeps it clear — nosed into a bay or a yard, its way out turning
      // back past the wall beside it: it backs out, turning as it goes.
      for (const t of done ? [] : turns) {
        const h = car.heading + t;
        if (inWalls(world, ctx, car.x - Math.cos(h) * cc.reverseSpeed, car.y - Math.sin(h) * cc.reverseSpeed, h) > now) continue;
        car.heading = h;
        car.speed = -cc.reverseSpeed;
        done = true;
        break;
      }
      if (!done) {
        car.speed = 0;
        car.blockedSince ??= tick; // boxed in by walls: given up in time, like any blocked car
      }
    }
  }
  // Engines, moving or stuck: the dead hear them. A police car, SWAT van or ambulance on
  // the move sounds its siren too (features.sirens): sparse and modest, a thin wake
  // rather than a corridor (cars.siren).
  const sr = cc.siren;
  for (const car of moving) {
    if ((car.id + tick) % cc.engineInterval === 0) emitStimulus(world, car.x, car.y, 'engine', cc.engineNoise, false, cc.engineIntensity);
    if (config.features.sirens && car.home !== null && (car.id + tick) % sr.every === 0) emitStimulus(world, car.x, car.y, 'siren', sr.noise, false, sr.intensity);
  }
}

/** The four corners of a car's rectangle at (x, y), along `heading`. */
function cornersAt(world: World, x: number, y: number, heading: number): [number, number][] {
  const l = world.config.cars.length / 2, w = world.config.cars.width / 2;
  const c = Math.cos(heading), s = Math.sin(heading);
  return [[l, w], [l, -w], [-l, -w], [-l, w]].map(([u, v]) => [x + c * u! - s * v!, y + s * u! + c * v!]);
}

/** How much of a car's body, at (x, y) heading `heading`, lies inside buildings: how many of a grid of points over it. */
function inWalls(world: World, ctx: Context, x: number, y: number, heading: number): number {
  const cc = world.config.cars;
  const n = cc.bodySamples, l = cc.length / 2, w = cc.width / 2;
  const c = Math.cos(heading), s = Math.sin(heading);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const u = -l + (2 * l * i) / (n - 1);
    for (const v of [-w, 0, w]) if (ctx.map.buildingAt(x + c * u - s * v, y + s * u + c * v) !== null) k++;
  }
  return k;
}

/** Whether two convex quadrilaterals overlap (no separating axis among their edges). */
function overlap(p: [number, number][], q: [number, number][]): boolean {
  for (const poly of [p, q]) {
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = poly[i]!, [x2, y2] = poly[(i + 1) % 4]!;
      const nx = y2 - y1, ny = x1 - x2;
      let pMin = Infinity, pMax = -Infinity, qMin = Infinity, qMax = -Infinity;
      for (const [x, y] of p) { const d = x * nx + y * ny; pMin = Math.min(pMin, d); pMax = Math.max(pMax, d); }
      for (const [x, y] of q) { const d = x * nx + y * ny; qMin = Math.min(qMin, d); qMax = Math.max(qMax, d); }
      if (pMax <= qMin || qMax <= pMin) return false;
    }
  }
  return true;
}

/**
 * What a car would hit moving to (x, y): a building it drives into at speed, or another
 * car it is not already touching (so a car can always drive out of an overlap it started
 * in). Not parked cars: pulling in and out of the kerb, a car passes close to them.
 */
function wouldHit(world: World, ctx: Context, car: Car, x: number, y: number): boolean {
  const cc = world.config.cars;
  const to = cornersAt(world, x, y, car.heading);
  const from = cornersAt(world, car.x, car.y, car.heading);
  // A building only at crash speed, by the car's front edge, and not one its front is
  // already against: pulling in and out of the kerb, a yard bay or a stall, its corner
  // brushes a plot at walking pace (14,403 such bumps on seed 1 in 4,000 ticks, every
  // one stopping a car until it was abandoned).
  if (car.speed >= cc.crashMin) {
    const front = (q: [number, number][]) => [q[0]!, q[1]!, [(q[0]![0] + q[1]![0]) / 2, (q[0]![1] + q[1]![1]) / 2] as [number, number]];
    const inside = (q: [number, number][]) => front(q).some(([px, py]) => ctx.map.buildingAt(px, py) !== null);
    if (inside(to) && !inside(from)) return true;
  }
  const hits = (o: Car) => {
    if (o === car || o.state === 'gone' || o.state === 'parked') return false; // parked at the kerb: brushed pulling in and out, never hit
    if (Math.hypot(o.x - x, o.y - y) > cc.length + 1) return false;
    const them = cornersAt(world, o.x, o.y, o.heading);
    return overlap(to, them) && !overlap(from, them);
  };
  for (const id of ctx.cars.near(x, y, cc.length + 1, ctx.ids2)) if (hits(world.cars[id]!)) return true;
  for (const o of ctx.cars.driving()) if (hits(o)) return true;
  return false;
}

/** Car movement (step 9): along its heading by its speed, everyone inside with it — unless it would hit something, when it stops where it is (car processes resolve the impact). */
export function moveCars(world: World, ctx: Context): void {
  for (const car of world.cars) {
    if (car.state !== 'driving' || car.speed === 0) continue; // (backing out of a bay, the speed is negative)
    const nx = car.x + Math.cos(car.heading) * car.speed, ny = car.y + Math.sin(car.heading) * car.speed;
    if (wouldHit(world, ctx, car, nx, ny)) {
      car.impact = Math.abs(car.speed);
      car.speed = 0;
      continue;
    }
    car.x = nx;
    car.y = ny;
    for (const id of car.occupants) {
      const s = world.sims[id]!;
      s.x = car.x;
      s.y = car.y;
    }
  }
}

/**
 * Someone turned inside a car: they come out of it as the dead (infection.ts spawns
 * the zombie where the car is); the car stops, and whoever else is inside gets out
 * into it. (Stage 4 adds the bites.)
 */
export function turnedInCar(world: World, ctx: Context, sim: Sim): void {
  const car = world.cars[sim.car!]!;
  sim.car = null;
  car.occupants = car.occupants.filter((id) => id !== sim.id);
  // Shut in with it: each of the others is bitten at turnInsideBite.
  for (const id of car.occupants) if (chance(world.rng, world.config.cars.turnInsideBite)) bite(world, ctx, world.sims[id]!);
  if (car.state === 'driving') {
    car.state = 'abandoned';
    ctx.events.push({ type: 'carAbandoned', tick: world.tick, car: car.id, x: car.x, y: car.y, sim: null });
    alight(world, ctx, car);
  }
}
