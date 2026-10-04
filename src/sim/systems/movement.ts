// Tick step 9: movement integration, sims then zombies. The only place positions
// change (besides entering and leaving buildings).

import { isOutdoorLiving, type Context } from '../context';
import type { World } from '../state';

function ageFactor(age: number, world: World): number {
  const { atAge, value } = world.config.movement.ageFactor;
  const t = Math.min(1, Math.max(0, (age - atAge[0]!) / (atAge[1]! - atAge[0]!)));
  return value[0]! + (value[1]! - value[0]!) * t;
}

/** Moves along heading, sliding along walls and riverbanks rather than passing through. */
function step(ctx: Context, e: { x: number; y: number }, heading: number, distance: number): void {
  if (distance <= 0) return;
  const nx = e.x + Math.cos(heading) * distance;
  const ny = e.y + Math.sin(heading) * distance;
  const map = ctx.map;
  if (map.walkable(nx, ny)) {
    e.x = nx;
    e.y = ny;
  } else if (map.walkable(nx, e.y)) {
    e.x = nx;
  } else if (map.walkable(e.x, ny)) {
    e.y = ny;
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
