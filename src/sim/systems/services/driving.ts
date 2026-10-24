// Driving: a moving car's decisions (step 6) and its movement (step 9). Where it steers
// — along its lane toward the next junction, slowing for corners and for what is ahead,
// swerving round people, never turning faster than its turning circle allows, keeping
// its body out of buildings below crash speed — and whether a move would hit something
// (car processes in cars.ts resolve the impact). Writes heading and speed in decisions,
// position only in movement.

import type { Context } from '../../context';
import { sharedNode } from '../../navigation/pathfinding';
import type { BuildingId, Car, World } from '../../state';
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
  const passing = new Map<number, number>(); // moving car → the abandoned car it is driving round

  const half = cc.width / 2 + cc.clearance; // room either side for a car
  for (const car of moving) {
    // Where to now: the next junction, offset right of the way there, or the kerb.
    let tx = car.destination!.x, ty = car.destination!.y;
    let replanned = false;
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
      // Off it, with no room for the car between here and that point (a gap between two
      // houses): a fresh way from where it is, every offStreetEvery ticks. Making for the
      // nearest point regardless, a police car nosed into a two-metre gap for 292 ticks.
      if (lat > st.width / 2 && !replanned && (tick + car.id) % cc.offStreetEvery === 0 && car.occupants.length > 0 && !ctx.map.corridor(car.x, car.y, tx, ty, half)) {
        replanned = true;
        const reach = config.behaviour.pathStreetSearch;
        const fresh = ctx.paths.route(sims[car.occupants[0]!]!, car.destination!.x, car.destination!.y, false, undefined, ctx.map.driveStreet(car.x, car.y, reach, half), ctx.map.driveStreet(car.destination!.x, car.destination!.y, reach, half));
        if (fresh !== null && fresh[0] !== car.route[car.routeIndex]) {
          car.route = fresh;
          car.routeIndex = 0;
          tx = car.destination!.x;
          ty = car.destination!.y;
          continue;
        }
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
    // An abandoned car in its lane ahead: driven round on the other side of the road if
    // the road there is clear, slowly. Stopping for it, the cars behind queued until each
    // was abandoned in turn — half of all abandoned cars stood beside another.
    // Once begun, the pass holds until it is a car's length past the wreck: let go when
    // the wreck was no longer straight ahead, a car turned back into its lane early, at
    // speed, and into the wreck.
    const u = laneDir(world, car);
    if (car.passing !== null) {
      const w = cars[car.passing]!;
      if (w.state !== 'abandoned' || (w.x - car.x) * u.x + (w.y - car.y) * u.y < -cc.length) {
        car.passing = null;
        car.passSide = 0;
      }
    }
    const wreck = car.passing !== null ? cars[car.passing]! : wreckAhead(world, ctx, car);
    if (wreck !== null) {
      const p = passBy(world, ctx, car, wreck, u, car.passSide);
      if (p !== null) {
        car.passing = wreck.id;
        car.passSide = p.side;
        passing.set(car.id, wreck.id);
        wantOf.set(car.id, Math.atan2(p.y - car.y, p.x - car.x));
      } else if (car.passing !== null) other.add(car.id); // part-way round, the way on is taken: it waits there
    }
    let blocked = false;
    for (const id of ctx.cars.near(car.x, car.y, reach, ctx.ids2)) {
      const o = cars[id]!;
      if (o.state === 'abandoned' && o.id !== passing.get(car.id) && ahead(car, o.x, o.y, reach, cc.width)) blocked = true;
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
    // A checkpoint unit's own vehicle goes through the officers standing across the road
    // there, to park behind them: they let it by.
    const unit = driver !== null && driver.checkpoint !== null;
    for (const id of ctx.ids2) {
      const o = sims[id]!;
      if (unit && o.checkpoint !== null && o.post !== null) continue;
      onFoot(o.x, o.y);
    }
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
    const round = passing.get(car.id);
    const fit = (o: Car) => {
      if (o === car || o.state === 'gone' || o.state === 'parked') return;
      // The wreck it is driving round: in the way only if the way it is turning toward
      // (to the point it aims at) still runs into it.
      if (o.id === round) {
        const w = wantOf.get(car.id)!;
        const along = (o.x - car.x) * Math.cos(w) + (o.y - car.y) * Math.sin(w);
        if (along <= 0 || Math.abs(-(o.x - car.x) * Math.sin(w) + (o.y - car.y) * Math.cos(w)) >= cc.width) return;
      }
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
    const moved = car.speed !== 0; // last tick's move went ahead (movement zeroes a move stopped by contact)
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
      if (passing.has(car.id)) target = Math.min(target, cc.passSpeed);
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
      const near = ctx.map.buildingsNear(car.x, car.y, cc.length + cc.width + cc.reverseSpeed, nearIds).slice(); // within any move tried below
      const now = inWalls(world, ctx, car.x, car.y, car.heading, near);
      // The way it wants, if that keeps it clear; standing (waiting behind something, or
      // at its spot), it stays put rather than casting about — trying other ways, cars
      // waiting in a queue pivoted on the spot. Failing that: turning toward where it is
      // going, or less, or away from the wall, at its speed or less; and boxed in (nosed
      // into a bay or a yard, its way out turning back past the wall beside it), backing
      // out, turning as it goes, a full reverseSpeed step or less of one. Already against
      // a wall, it takes whichever of those first draws it off the wall, if any does:
      // taking any move no deeper in, a car slid along a wall grinding, and one with a
      // corner caught on a building, a full step back swinging its nose in, never moved.
      const at = (h: number, sp: number) => inWalls(world, ctx, car.x + Math.cos(h) * sp, car.y + Math.sin(h) * sp, h, near);
      const h0 = car.heading + want;
      const turns = [...[1, ...cc.wallTurn].map((f) => want * f), ...cc.wallTurn.filter((f) => f > 0).flatMap((f) => [turn * f, -turn * f]), turn, -turn];
      const ahead: { h: number; sp: number; held: boolean }[] = [];
      const back: { h: number; sp: number; held: boolean }[] = [];
      for (const v of [1, ...cc.wallSpeed]) for (const t of turns) ahead.push({ h: car.heading + t, sp: car.speed * v, held: v !== 1 });
      for (const f of cc.reverseSteps) for (const t of turns) back.push({ h: car.heading + t, sp: -cc.reverseSpeed * f, held: true });
      // Where it is going well behind it: backing out first. Going on ahead instead, a car
      // pulling out nose-first across an alley crept on into the gap between the houses
      // opposite, away from where it was going, for 292 ticks.
      const ways = Math.abs(err) > cc.backFor ? [...back, ...ahead] : [...ahead, ...back];
      const moves = (w: { h: number; sp: number }) => !(w.h === car.heading && w.sp === 0); // standing still is not a way out
      let way = now > 0 ? ways.find((w) => moves(w) && at(w.h, w.sp) < now) : undefined;
      if (way === undefined && at(h0, car.speed) <= now) way = { h: h0, sp: car.speed, held: false };
      else if (way === undefined && car.speed > 0) way = ways.find((w) => moves(w) && at(w.h, w.sp) <= now);
      if (way === undefined) {
        car.speed = 0;
        held = true;
      } else {
        car.heading = way.h;
        car.speed = way.sp;
        held = way.held; // (steering away from a wall at its speed is still getting on)
      }
    }
    // Held back by walls counts as blocked: near its spot it parks, and one that cannot
    // work its way out is rerouted and in the end abandoned, like a car in a jam. Not
    // counted, a car wedged between a kerb and a wall pivoted on the spot for 1,280 ticks.
    // Stopped a while, nose to what holds it, with the road behind clear: it backs off a
    // few metres — room to drive round it, or to turn and go back. Standing nose to it,
    // a car had no room to swing out, and could only wait to be abandoned.
    const since = car.blockedSince === null ? 0 : tick - car.blockedSince;
    if ((blocked || held || !moved) && car.blockedSince !== null && since >= cc.backAfter && since < cc.backAfter + cc.backTicks && clearBehind(world, ctx, car)) {
      const bx = car.x - Math.cos(car.heading) * cc.reverseSpeed, by = car.y - Math.sin(car.heading) * cc.reverseSpeed;
      if (inWalls(world, ctx, bx, by, car.heading) <= inWalls(world, ctx, car.x, car.y, car.heading)) car.speed = -cc.reverseSpeed;
    }
    // Stopped by contact (movement marks it) stays stopped until a move goes ahead: cleared
    // whenever decisions saw nothing in the way, a car nosed against a wreck's corner bumped
    // it every tick for hours, never rerouted and never abandoned.
    // And it is moving again only once it has got somewhere — cars.unstuck from where it
    // was first stopped: cleared by any move, a car backing off a metre and nosing in
    // again, or shuffling against a wall, was stuck for hours and never rerouted,
    // parked or abandoned.
    if (blocked || held) stopped(car, tick);
    else if (moved && (car.stuckAt === null || Math.hypot(car.x - car.stuckAt.x, car.y - car.stuckAt.y) > cc.unstuck)) {
      car.blockedSince = null;
      car.stuckAt = null;
    }
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

/** Marks a car stopped, from now and here, unless it already is. */
function stopped(car: Car, tick: number): void {
  if (car.blockedSince !== null) return;
  car.blockedSince = tick;
  car.stuckAt = { x: car.x, y: car.y };
}

/**
 * Nothing behind it in its lane within a car's length and gap, and two ticks at full
 * speed besides: no car standing or moving, nobody on foot, none of the dead. A car
 * coming up behind sets its speed by the room it sees at the start of the tick; backing
 * into it a metre more than that, a car was run into at full speed.
 */
function clearBehind(world: World, ctx: Context, car: Car): boolean {
  const cc = world.config.cars;
  const look = cc.length + cc.gap + 2 * cc.maxSpeed;
  const c = Math.cos(car.heading), s = Math.sin(car.heading);
  const behind = (x: number, y: number, half: number) => {
    const dx = x - car.x, dy = y - car.y;
    const along = dx * c + dy * s;
    return along < 0 && along >= -look && Math.abs(-dx * s + dy * c) < half;
  };
  for (const id of ctx.cars.near(car.x, car.y, look, ctx.ids2)) {
    const o = world.cars[id]!;
    if (o !== car && o.state !== 'gone' && behind(o.x, o.y, cc.width)) return false;
  }
  for (const o of ctx.cars.driving()) if (o !== car && behind(o.x, o.y, cc.width)) return false;
  ctx.simHash.query(car.x, car.y, look, ctx.ids2);
  for (const id of ctx.ids2) if (behind(world.sims[id]!.x, world.sims[id]!.y, cc.width / 2 + 0.5)) return false;
  ctx.zombieHash.query(car.x, car.y, look, ctx.ids2);
  for (const id of ctx.ids2) if (behind(world.zombies[id]!.x, world.zombies[id]!.y, cc.width / 2 + 0.5)) return false;
  return true;
}

/** The nearest abandoned car in this car's lane ahead, within a car's length and gap and its stopping distance; null if none. */
function wreckAhead(world: World, ctx: Context, car: Car): Car | null {
  const cc = world.config.cars;
  const look = cc.maxSpeed + cc.length + cc.gap;
  const c = Math.cos(car.heading), s = Math.sin(car.heading);
  let best: Car | null = null, bestAlong = Infinity;
  for (const id of ctx.cars.near(car.x, car.y, look, ctx.ids2)) {
    const o = world.cars[id]!;
    if (o.state !== 'abandoned') continue;
    const dx = o.x - car.x, dy = o.y - car.y;
    const along = dx * c + dy * s;
    if (along <= 0 || along > look || along >= bestAlong || Math.abs(-dx * s + dy * c) >= cc.width) continue;
    best = o;
    bestAlong = along;
  }
  return best;
}

/** Along the street it is on, the way its route goes (toward the next junction, or the end nearer where it is going). */
function laneDir(world: World, car: Car): { x: number; y: number } {
  const i = Math.min(car.routeIndex, car.route.length - 1);
  const st = world.streets[car.route[i]!];
  if (st === undefined) return { x: Math.cos(car.heading), y: Math.sin(car.heading) };
  const a = world.nodes[st.a]!, b = world.nodes[st.b]!;
  const n = i < car.route.length - 1 ? sharedNode(world, car.route[i]!, car.route[i + 1]!) : null;
  const d = car.destination ?? { x: b.x, y: b.y };
  const toB = n !== null ? n === st.b : Math.hypot(b.x - d.x, b.y - d.y) <= Math.hypot(a.x - d.x, a.y - d.y);
  const from = toB ? a : b, to = toB ? b : a;
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
}

/**
 * Where to aim to drive round a wreck: beside it and a car's length past it along the
 * lane's way `u`, on `side` (or, with none chosen, the side away from it first, then the
 * other), a car's width and passClear out from it; only on the carriageway of the
 * street it is on, the way there too, with no other car standing or moving within a
 * car's length of it. Null if no side will do.
 */
function passBy(world: World, ctx: Context, car: Car, wreck: Car, u: { x: number; y: number }, side0: number): { x: number; y: number; side: number } | null {
  const cc = world.config.cars;
  const street = world.streets[car.route[Math.min(car.routeIndex, car.route.length - 1)]!];
  if (street === undefined) return null;
  const sa = world.nodes[street.a]!, sb = world.nodes[street.b]!;
  const onRoad = (x: number, y: number) => {
    const dx = sb.x - sa.x, dy = sb.y - sa.y;
    const t = Math.max(0, Math.min(1, ((x - sa.x) * dx + (y - sa.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(x - sa.x - dx * t, y - sa.y - dy * t) <= street.width / 2 - cc.width / 2;
  };
  const c = u.x, s = u.y;
  const lat = -(wreck.x - car.x) * s + (wreck.y - car.y) * c;
  const off = cc.width + cc.passClear;
  for (const side of side0 !== 0 ? [side0] : lat >= 0 ? [-1, 1] : [1, -1]) {
    const bx = wreck.x - s * side * off, by = wreck.y + c * side * off; // beside it
    const px = bx + c * cc.length * 1.5, py = by + s * cc.length * 1.5; // and on past it, by more than it holds the pass for
    if (!onRoad(bx, by) || !onRoad(px, py) || !onRoad((car.x + bx) / 2, (car.y + by) / 2)) continue;
    // Out to beside it while still behind it; then on past. Aimed past it from close
    // behind, the way there still ran through the wreck, and the car stood nose to it.
    const behind = (wreck.x - car.x) * c + (wreck.y - car.y) * s > 0;
    let clear = true;
    for (const id of ctx.cars.near(bx, by, cc.length, ctx.ids2)) {
      const o = world.cars[id]!;
      if (o !== car && o !== wreck && o.state !== 'gone' && Math.hypot(o.x - bx, o.y - by) < cc.length) clear = false;
    }
    for (const o of ctx.cars.driving()) if (o !== car && Math.hypot(o.x - bx, o.y - by) < cc.length) clear = false;
    if (clear) return behind ? { x: bx, y: by, side } : { x: px, y: py, side };
  }
  return null;
}

/** The four corners of a car's rectangle at (x, y), along `heading`. */
function cornersAt(world: World, x: number, y: number, heading: number): [number, number][] {
  const l = world.config.cars.length / 2, w = world.config.cars.width / 2;
  const c = Math.cos(heading), s = Math.sin(heading);
  return [[l, w], [l, -w], [-l, -w], [-l, w]].map(([u, v]) => [x + c * u! - s * v!, y + s * u! + c * v!]);
}

const nearIds: BuildingId[] = []; // scratch for inWalls

/**
 * How much of a car's body, at (x, y) heading `heading`, lies inside buildings: how many
 * of a grid of points over it, and how many building corners lie inside it. By the points
 * alone, a corner poked into a car's side between two of them unseen, and every move
 * after put one into it: the car froze there, half into the building. `near`: the
 * buildings to look at, if already found (any within reach of the car).
 */
function inWalls(world: World, ctx: Context, x: number, y: number, heading: number, near?: readonly BuildingId[]): number {
  const cc = world.config.cars;
  const n = cc.bodySamples, l = cc.length / 2, w = cc.width / 2;
  const c = Math.cos(heading), s = Math.sin(heading);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const u = -l + (2 * l * i) / (n - 1);
    for (const v of [-w, 0, w]) if (ctx.map.buildingAt(x + c * u - s * v, y + s * u + c * v) !== null) k++;
  }
  for (const id of near ?? ctx.map.buildingsNear(x, y, l + w, nearIds)) {
    for (const p of world.buildings[id]!.outline) {
      const dx = p.x - x, dy = p.y - y;
      if (Math.abs(dx * c + dy * s) < l && Math.abs(-dx * s + dy * c) < w) k++;
    }
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
      stopped(car, world.tick);
      continue;
    }
    // At speed, deeper into a building anywhere but its front (a side swung in on a turn):
    // stopped where it is, to work its way out at a crawl. Judged by the front alone, a
    // car once into a wall drove on through the block.
    if (car.speed >= world.config.cars.crashMin && inWalls(world, ctx, nx, ny, car.heading) > inWalls(world, ctx, car.x, car.y, car.heading)) {
      car.speed = 0;
      stopped(car, world.tick);
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
