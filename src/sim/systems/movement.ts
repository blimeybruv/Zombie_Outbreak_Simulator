// Tick step 9: movement integration, sims then zombies. The only place positions
// change (besides entering and leaving buildings).

import { isOutdoorLiving, type Context } from '../context';
import type { World } from '../state';

function ageFactor(age: number, world: World): number {
  const { atAge, value } = world.config.movement.ageFactor;
  const t = Math.min(1, Math.max(0, (age - atAge[0]!) / (atAge[1]! - atAge[0]!)));
  return value[0]! + (value[1]! - value[0]!) * t;
}

/** Deflection angles tried on one side when the way ahead is blocked. */
const DEFLECT = [0.4, 0.8, 1.2, 1.57, 2.0];

interface Mover {
  x: number;
  y: number;
  slide: -1 | 0 | 1;
}

function tryMove(ctx: Context, e: Mover, heading: number, distance: number): boolean {
  const nx = e.x + Math.cos(heading) * distance;
  const ny = e.y + Math.sin(heading) * distance;
  if (!ctx.map.walkable(nx, ny)) return false;
  e.x = nx;
  e.y = ny;
  return true;
}

/**
 * Moves along heading. When blocked, slides along the obstacle, keeping to the side
 * it chose until the direct way opens: wall-following with hysteresis, so an agent
 * neither stalls against a wall nor flips sides every tick (the zig-zag).
 */
function step(ctx: Context, e: Mover, heading: number, distance: number, slideSpeed: number): void {
  if (distance <= 0) return;
  if (tryMove(ctx, e, heading, distance)) {
    e.slide = 0;
    return;
  }
  const sides: (-1 | 1)[] = e.slide === -1 ? [-1, 1] : [1, -1];
  for (const side of sides) {
    for (const d of DEFLECT) {
      if (tryMove(ctx, e, heading + side * d, distance * slideSpeed)) {
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

  for (const sim of world.sims) {
    if (!isOutdoorLiving(sim)) continue;
    const g = mv.gait[sim.gait];
    const contacts = ctx.contacts[sim.id]!;
    const drain = g.stamina < 0 ? g.stamina * (1 + drag.stamina * contacts) : g.stamina;
    sim.stamina = Math.min(1, Math.max(0, sim.stamina + drain));
    const speed =
      g.speed * (mv.staminaSpeedFloor + (1 - mv.staminaSpeedFloor) * sim.stamina) * ageFactor(sim.age, world) / (1 + drag.speed * contacts);
    step(ctx, sim, sim.heading, speed, mv.slideSpeed);
  }

  for (const z of world.zombies) {
    if (z.state === 'destroyed' || z.state === 'occupying') continue;
    step(ctx, z, z.heading, ctx.zombieSpeed[z.id] ?? 0, mv.slideSpeed);
  }
}
