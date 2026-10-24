// Driving: a moving car's decisions (step 6) and its movement (step 9). Where it steers
// — along its lane toward the next junction, slowing for corners and for what is ahead,
// swerving round people, never turning faster than its turning circle allows, keeping
// its body out of buildings below crash speed — and whether a move would hit something
// (car processes in cars.ts resolve the impact). Writes heading and speed in decisions,
// position only in movement.

import type { Context } from '../../context';
import { sharedNode } from '../../navigation/pathfinding';
import type { Car, World } from '../../state';
import { modeOf } from '../people/panic';
import { emitStimulus } from '../shared/stimuli';

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
    if (!blocked) {
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
    let held = false; // kept from the way it wants by walls
    if (car.speed >= cc.crashMin) car.heading += want;
    else {
      const now = inWalls(world, ctx, car.x, car.y, car.heading);
      // The way it wants, if that keeps it clear; standing (waiting behind something, or
      // at its spot), it stays put rather than casting about — trying other ways, cars
      // waiting in a queue pivoted on the spot.
      const h0 = car.heading + want;
      let done = inWalls(world, ctx, car.x + Math.cos(h0) * car.speed, car.y + Math.sin(h0) * car.speed, h0) <= now;
      if (done) car.heading = h0;
      else if (car.speed <= 0) {
        done = true;
        held = true;
      }
      // Turning toward where it is going, or less; failing that, away from the wall.
      const turns = [...[1, ...cc.wallTurn].map((f) => want * f), ...cc.wallTurn.filter((f) => f > 0).flatMap((f) => [turn * f, -turn * f]), turn, -turn];
      for (const v of done ? [] : [1, ...cc.wallSpeed]) {
        for (const t of turns) {
          const h = car.heading + t, sp = car.speed * v;
          if (h === car.heading && sp === 0) continue; // standing still is not a way out
          if (inWalls(world, ctx, car.x + Math.cos(h) * sp, car.y + Math.sin(h) * sp, h) > now) continue;
          car.heading = h;
          car.speed = sp;
          held = v !== 1; // (steering away from a wall at its speed is still getting on)
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
        held = true;
        done = true;
        break;
      }
      if (!done) {
        car.speed = 0;
        held = true;
      }
    }
    // Held back by walls counts as blocked: near its spot it parks, and one that cannot
    // work its way out is rerouted and in the end abandoned, like a car in a jam. Not
    // counted, a car wedged between a kerb and a wall pivoted on the spot for 1,280 ticks.
    if (blocked || held) car.blockedSince ??= tick;
    else car.blockedSince = null;
  }
  // Engines, moving or stuck: the dead hear them. A police car, SWAT van or ambulance on
  // the move (not the reservists' HMMWVs) sounds its siren too (features.sirens): sparse and modest, a thin wake
  // rather than a corridor (cars.siren).
  const sr = cc.siren;
  for (const car of moving) {
    if ((car.id + tick) % cc.engineInterval === 0) emitStimulus(world, car.x, car.y, 'engine', cc.engineNoise, false, cc.engineIntensity);
    if (config.features.sirens && car.home !== null && car.kind !== 'hmmwv' && (car.id + tick) % sr.every === 0) emitStimulus(world, car.x, car.y, 'siren', sr.noise, false, sr.intensity);
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
