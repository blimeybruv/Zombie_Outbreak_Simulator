// Tick step 9: movement integration, sims then zombies. The only place positions
// change (besides entering and leaving buildings).

import { isOutdoorLiving, type Context } from '../../context';
import { moveCars } from '../services/driving';
import { modeOf } from '../people/panic';
import type { Gait, World } from '../../state';
import { barrierAt, shut } from '../outside/cordon';

/** Age's toll on speed: mild for walking, steep for running and sprinting. */
function ageFactor(age: number, gait: Gait, world: World): number {
  const mv = world.config.movement;
  const { atAge, value } = gait === 'run' || gait === 'sprint' ? mv.fleeAgeFactor : mv.ageFactor;
  const t = Math.min(1, Math.max(0, (age - atAge[0]!) / (atAge[1]! - atAge[0]!)));
  return value[0]! + (value[1]! - value[0]!) * t;
}

/** Deflection angles tried on one side when the way ahead is blocked. */
const DEFLECT = [0.4, 0.8, 1.2, 1.57, 2.0];
/**
 * When every deflection on both sides has failed, a fine sweep all the way round at
 * half a step: in a slit between buildings the only way out can lie behind, narrower
 * than the deflections can find, and without this an agent stood there for the rest
 * of the run. Rare, so its cost does not matter.
 */
const SWEEP = Array.from({ length: 16 }, (_, k) => ((k + 1) * Math.PI) / 16);

interface Mover {
  x: number;
  y: number;
  slide: -1 | 0 | 1;
}

/** A closed barrier across a road out: its middle, the road's outward direction, and its half-span. */
interface Fence {
  x: number;
  y: number;
  dx: number;
  dy: number;
  half: number;
}

/**
 * The closed barriers a step may not cross outward. Barriers stop people on foot, not
 * just routes: with no wall there, the frightened ran from the dead straight past the
 * rescue's line to the end of the road and piled up against the map's edge.
 */
let fences: Fence[] = [];

/** Whether the step from (x0, y0) to (x1, y1) crosses a closed barrier outward, within its span. */
function crossesFence(x0: number, y0: number, x1: number, y1: number): boolean {
  for (const f of fences) {
    const p0 = (x0 - f.x) * f.dx + (y0 - f.y) * f.dy, p1 = (x1 - f.x) * f.dx + (y1 - f.y) * f.dy;
    if (!(p0 < 0 && p1 >= 0)) continue;
    const t = p0 / (p0 - p1);
    const cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t;
    if (Math.abs(-(cx - f.x) * f.dy + (cy - f.y) * f.dx) <= f.half) return true;
  }
  return false;
}

/** Whether this mover is held by the barriers: everyone living but soldiers, those let through to a tent, and those pressing on round. */
let fenced = false;

function tryMove(ctx: Context, e: Mover, heading: number, distance: number): boolean {
  const nx = e.x + Math.cos(heading) * distance;
  const ny = e.y + Math.sin(heading) * distance;
  if (!ctx.map.walkable(nx, ny) || ctx.cars.blocks(nx, ny)) return false;
  if (fenced && crossesFence(e.x, e.y, nx, ny)) return false;
  e.x = nx;
  e.y = ny;
  return true;
}

/** Straight on over a standing car, at `climb` of the pace: anything else in the way still stops it. */
function climbOver(ctx: Context, e: Mover, heading: number, distance: number): boolean {
  const nx = e.x + Math.cos(heading) * distance;
  const ny = e.y + Math.sin(heading) * distance;
  if (!ctx.map.walkable(nx, ny) || ctx.cars.drivingAt(nx, ny)) return false;
  if (fenced && crossesFence(e.x, e.y, nx, ny)) return false;
  e.x = nx;
  e.y = ny;
  return true;
}

/**
 * Moves along heading. When blocked, slides along the obstacle, keeping to the side
 * it chose until the direct way opens: wall-following with hysteresis, so an agent
 * neither stalls against a wall nor flips sides every tick (the zig-zag). One who can
 * climb (climb > 0, a share of its pace) goes round a standing car if a small turn
 * will do, else straight over it; on a car already, it carries on over at that pace.
 */
function step(ctx: Context, e: Mover, heading: number, distance: number, slideSpeed: number, climb = { share: 0, turn: 0 }): void {
  if (distance <= 0) return;
  if (climb.share > 0 && ctx.cars.standing(e.x, e.y)) {
    if (climbOver(ctx, e, heading, distance * climb.share)) {
      e.slide = 0;
      return;
    }
    // Straight on is a wall (or a moving car): off the car another way. Only ever
    // straight on, a cop on a car parked against a building stood on it for good.
    const sides: (-1 | 1)[] = e.slide === -1 ? [-1, 1] : [1, -1];
    for (const d of [...DEFLECT, ...SWEEP]) {
      for (const side of sides) {
        if (climbOver(ctx, e, heading + side * d, distance * climb.share)) {
          e.slide = side;
          return;
        }
      }
    }
    return;
  }
  if (tryMove(ctx, e, heading, distance)) {
    e.slide = 0;
    return;
  }
  const sides: (-1 | 1)[] = e.slide === -1 ? [-1, 1] : [1, -1];
  const deflect = (from: number, to: number): boolean => {
    for (const side of sides) {
      for (const d of DEFLECT) {
        if (d <= from || d > to) continue;
        if (tryMove(ctx, e, heading + side * d, distance * slideSpeed)) {
          e.slide = side;
          return true;
        }
      }
    }
    return false;
  };
  if (climb.share > 0) {
    if (deflect(0, climb.turn)) return;
    const ax = e.x + Math.cos(heading) * distance, ay = e.y + Math.sin(heading) * distance;
    if (ctx.cars.standing(ax, ay) && climbOver(ctx, e, heading, distance * climb.share)) {
      e.slide = 0;
      return;
    }
    if (deflect(climb.turn, Infinity)) return;
  } else if (deflect(0, Infinity)) return;
  for (const d of SWEEP) {
    for (const side of sides) {
      if (tryMove(ctx, e, heading + side * d, distance * slideSpeed * 0.5)) {
        e.slide = side;
        return;
      }
    }
  }
}

export function integrateMovement(world: World, ctx: Context): void {
  const { config } = world;
  const mv = config.movement;
  const drag = config.combat.drag;
  fences = world.exits.filter(shut).map((e) => {
    const b = barrierAt(world, e);
    return { x: b.x, y: b.y, dx: e.dx, dy: e.dy, half: world.streets[e.street]!.width / 2 + config.cordon.kerb };
  });

  for (const sim of world.sims) {
    if (!isOutdoorLiving(sim)) {
      sim.pace = 0; // indoors or in a car: out of it, from a standstill
      continue;
    }
    const g = mv.gait[sim.gait];
    const contacts = ctx.contacts[sim.id]!;
    const drain = g.stamina < 0 ? g.stamina * (1 + drag.stamina * contacts) : g.stamina;
    sim.stamina = Math.min(1, Math.max(0, sim.stamina + drain));
    const target =
      g.speed * (mv.staminaSpeedFloor + (1 - mv.staminaSpeedFloor) * sim.stamina) * ageFactor(sim.age, sim.gait, world) / (1 + drag.speed * contacts);
    const inertia = mv.inertia;
    const rate = target < sim.pace ? inertia.decel : modeOf(sim, config) === 'flight' ? inertia.flightAccel : inertia.accel;
    sim.pace += (target - sim.pace) * rate;
    if (target === 0 && sim.pace < inertia.rest) sim.pace = 0;
    fenced = fences.length > 0 && !sim.outsider && sim.tent === null && sim.crossing === null;
    step(ctx, sim, sim.heading, sim.pace, mv.slideSpeed, mv.climb);
  }
  fenced = false;

  for (const z of world.zombies) {
    if (z.state === 'destroyed' || z.state === 'occupying') continue;
    step(ctx, z, z.heading, ctx.zombieSpeed[z.id] ?? 0, mv.slideSpeed, mv.climbDead);
  }
  moveCars(world, ctx);
}
