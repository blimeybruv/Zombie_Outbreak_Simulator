// Tick step 9: movement integration, sims then zombies. The only place positions
// change (besides entering and leaving buildings).

import { isOutdoorLiving, type Context } from '../context';
import type { World } from '../state';

function ageFactor(age: number, world: World): number {
  const { atAge, value } = world.config.movement.ageFactor;
  const t = Math.min(1, Math.max(0, (age - atAge[0]!) / (atAge[1]! - atAge[0]!)));
  return value[0]! + (value[1]! - value[0]!) * t;
}

/** Deflections tried, in order, when the way ahead is blocked: slide along walls and banks at any angle. */
const DEFLECT = [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.57, -1.57];

/** Moves along heading, sliding along walls and riverbanks rather than passing through. */
function step(ctx: Context, e: { x: number; y: number }, heading: number, distance: number): void {
  if (distance <= 0) return;
  for (const d of DEFLECT) {
    const scaleBy = Math.cos(d); // progress shrinks as the deflection grows
    const nx = e.x + Math.cos(heading + d) * distance * scaleBy;
    const ny = e.y + Math.sin(heading + d) * distance * scaleBy;
    if (ctx.map.walkable(nx, ny)) {
      e.x = nx;
      e.y = ny;
      return;
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
    step(ctx, sim, sim.heading, speed);
  }

  for (const z of world.zombies) {
    if (z.state === 'destroyed' || z.state === 'occupying') continue;
    step(ctx, z, z.heading, ctx.zombieSpeed[z.id] ?? 0);
  }
}
