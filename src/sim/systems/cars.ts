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
import { chance } from '../rng';
import type { Building, BuildingId, Car, CarId, Sim, World } from '../state';
import { bite } from './combat';
import { entranceNearest, leaveTalk, setDestination } from './common';
import type { Mode } from './panic';
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

function addCar(world: World, ctx: Context, x: number, y: number, heading: number, spaced: boolean, home: BuildingId | null = null): Car | null {
  const cc = world.config.cars;
  if (!ctx.map.walkable(x, y)) return null;
  if (spaced) for (const c of world.cars) if (Math.hypot(c.x - x, c.y - y) < cc.spacing) return null;
  const car: Car = {
    id: world.cars.length as CarId,
    state: 'parked',
    kind: home === null ? 'car' : 'van',
    home,
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
  };
  world.cars.push(car);
  return car;
}

/** A SWAT van at the kerb by its station's door, or the nearest clear spot along the street; null if there is none. */
export function parkVan(world: World, ctx: Context, b: Building): Car | null {
  const e = b.entrances[0]!;
  const s = world.streets[b.street]!;
  const a = world.nodes[s.a]!, n = world.nodes[s.b]!;
  const len = Math.hypot(n.x - a.x, n.y - a.y) || 1;
  const ux = (n.x - a.x) / len, uy = (n.y - a.y) / len;
  const step = world.config.cars.spacing;
  for (const d of [0, step, -step, 2 * step, -2 * step, 3 * step, -3 * step]) {
    const k = kerbBy(world, b, e.x + ux * d, e.y + uy * d);
    if (k === null) continue;
    const van = addCar(world, ctx, k.x, k.y, k.heading, true, b.id);
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

// Choosing a car, and boarding

/**
 * An aware sim on foot heading for home or shelter far away takes the nearest free
 * parked car it can see within searchRadius, and walks to it. Staggered by id. The
 * building it meant to reach goes with the car (`Car.destinationBuilding`).
 */
export function considerDriving(world: World, ctx: Context, sim: Sim, mode: Mode): boolean {
  const { config, tick, cars } = world;
  const cc = config.cars;
  if (mode === 'flight' || sim.awareAt === null || sim.car !== null || sim.station !== null) return false;
  if (sim.destinationKind !== 'shelter' || sim.destinationBuilding === null || sim.destination === null) return false;
  if ((sim.id + tick) % config.roles.interval !== 0) return false;
  if (Math.hypot(sim.destination.x - sim.x, sim.destination.y - sim.y) <= cc.driveBeyond) return false;
  let best: Car | null = null;
  let bestD = Infinity;
  for (const id of ctx.cars.near(sim.x, sim.y, cc.searchRadius, ctx.ids2)) {
    const c = cars[id]!;
    if (c.state !== 'parked' || c.claimedBy !== null) continue;
    const d = Math.hypot(c.x - sim.x, c.y - sim.y);
    if (d >= bestD || !ctx.map.lineOfSight(sim.x, sim.y, c.x, c.y)) continue;
    best = c;
    bestD = d;
  }
  if (best === null) return false;
  best.claimedBy = sim.id;
  best.destinationBuilding = sim.destinationBuilding;
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
  if (b !== null) setDestination(sim, world.buildings[b]!, 'shelter');
  else {
    sim.destinationKind = null;
    sim.destination = null;
  }
}

/** Where a car pulls up for a building: its street, beside the door, to the right of the way in. */
function pullUpBy(world: World, b: Building, x: number, y: number): { x: number; y: number } {
  const s = world.streets[b.street]!;
  const a = world.nodes[s.a]!, n = world.nodes[s.b]!;
  const len = Math.hypot(n.x - a.x, n.y - a.y) || 1;
  const ux = (n.x - a.x) / len, uy = (n.y - a.y) / len;
  const t = Math.min(len, Math.max(0, (x - a.x) * ux + (y - a.y) * uy));
  const side = Math.sign((x - a.x) * -uy + (y - a.y) * ux) || 1;
  const off = Math.min(world.config.cars.laneOffset, s.width / 4);
  return { x: a.x + ux * t - uy * off * side, y: a.y + uy * t + ux * off * side };
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
    if (!placed) {
      s.x = car.x;
      s.y = car.y;
    }
    s.gait = 'walk';
    if (s.condition !== 'healthy' && s.condition !== 'infected') continue;
    if (b !== null && s.squadLeader === null) setDestination(s, b, 'shelter'); // a squad goes where its leader takes it
  }
  car.occupants = [];
  car.speed = 0;
  car.route = [];
  car.routeIndex = 0;
  car.destination = null;
  car.destinationBuilding = null;
  car.blockedSince = null;
}

/** Gets in to drive, with any aware companions on foot beside it bound for the same building, up to capacity. */
function board(world: World, ctx: Context, sim: Sim, car: Car): void {
  const { config, buildings, sims } = world;
  const cc = config.cars;
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
  car.route = route;
  car.routeIndex = 0;
  car.blockedSince = null;
  return true;
}

/** Car processes, in building processes (step 10): stale claims, boarding, arriving, abandoning. */
export function carProcesses(world: World, ctx: Context): void {
  const { config, tick, cars, sims } = world;
  const cc = config.cars;
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
    const last = car.routeIndex >= car.route.length - 1;
    if (last && car.destination !== null && Math.hypot(car.destination.x - car.x, car.destination.y - car.y) <= cc.arriveRadius) {
      car.state = 'parked';
      alight(world, ctx, car);
      continue;
    }
    // The dead at the doors: each awake one breaks in at breakIn a tick.
    ctx.zombieHash.query(car.x, car.y, cc.length / 2 + config.combat.contactRange, ctx.ids2);
    let at = 0;
    for (const id of ctx.ids2) {
      const z = world.zombies[id]!;
      if (z.state === 'active' || z.state === 'wandering') at++;
    }
    if (at > 0 && chance(world.rng, 1 - (1 - cc.breakIn) ** at)) {
      car.state = 'abandoned';
      ctx.events.push({ type: 'carAbandoned', tick, car: car.id, x: car.x, y: car.y, sim: null });
      alight(world, ctx, car);
      continue;
    }
    if (car.blockedSince !== null && tick - car.blockedSince >= cc.jamTicks) {
      car.state = 'abandoned';
      ctx.events.push({ type: 'carAbandoned', tick, car: car.id, x: car.x, y: car.y, sim: null });
      alight(world, ctx, car);
    }
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
      tx = node.x - uy * lane;
      ty = node.y + ux * lane;
      break;
    }
    if (tx !== car.x || ty !== car.y) car.heading = Math.atan2(ty - car.y, tx - car.x);

    const stoppedBy: number[] = [];
    for (const o of moving) if (o !== car && ahead(car, o.x, o.y, reach, cc.width)) stoppedBy.push(o.id);
    blockers.set(car.id, stoppedBy);
    let blocked = false;
    for (const id of ctx.cars.near(car.x, car.y, reach, ctx.ids2)) {
      const o = cars[id]!;
      if (o.state === 'abandoned' && ahead(car, o.x, o.y, reach, cc.width)) blocked = true;
    }
    if (!blocked) {
      ctx.simHash.query(car.x, car.y, reach, ctx.ids2);
      for (const id of ctx.ids2) if (ahead(car, sims[id]!.x, sims[id]!.y, reach, cc.width / 2 + 0.5)) blocked = true;
    }
    if (!blocked) {
      ctx.zombieHash.query(car.x, car.y, reach, ctx.ids2);
      for (const id of ctx.ids2) if (ahead(car, zombies[id]!.x, zombies[id]!.y, reach, cc.width / 2 + 0.5)) blocked = true;
    }
    if (blocked) other.add(car.id);
  }

  for (const car of moving) {
    // Two moving cars stopped by each other: the lower id yields, the higher goes.
    const stoppedBy = blockers.get(car.id)!.filter((id) => !(id < car.id && blockers.get(id)!.includes(car.id)));
    const blocked = other.has(car.id) || stoppedBy.length > 0;
    if (blocked) {
      car.speed = 0;
      car.blockedSince ??= tick;
      continue;
    }
    car.blockedSince = null;
    let near = 0;
    for (const o of moving) if (o !== car && Math.hypot(o.x - car.x, o.y - car.y) <= cc.congestionRadius) near++;
    let speed = cc.maxSpeed / (1 + cc.congestion * near);
    if (car.routeIndex >= car.route.length - 1) speed = Math.min(speed, Math.hypot(car.destination!.x - car.x, car.destination!.y - car.y));
    car.speed = speed;
  }
  // Engines, moving or stuck: the dead hear them.
  for (const car of moving) {
    if ((car.id + tick) % cc.engineInterval === 0) emitStimulus(world, car.x, car.y, 'engine', cc.engineNoise, false, cc.engineIntensity);
  }
}

/** Car movement (step 9): along its heading by its speed, everyone inside with it. */
export function moveCars(world: World): void {
  for (const car of world.cars) {
    if (car.state !== 'driving' || car.speed <= 0) continue;
    car.x += Math.cos(car.heading) * car.speed;
    car.y += Math.sin(car.heading) * car.speed;
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
