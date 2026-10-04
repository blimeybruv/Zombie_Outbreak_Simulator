// Small helpers shared by sim decisions, building processes and the shelter
// economy. Kept apart so those systems do not import each other.

import type { Building, Sim, World } from '../state';

export function entranceNearest(b: Building, x: number, y: number): { x: number; y: number } {
  let best = b.entrances[0]!;
  let bestD = Infinity;
  for (const e of b.entrances) {
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** Engagement capacity: zombies this sim can expect to stop with what it carries. */
export function capacity(world: World, sim: Sim): number {
  const { combat } = world.config;
  const w = sim.weapon;
  if (w === null) return 0;
  if (w === 'pistol' || w === 'smg' || w === 'shotgun') return Math.floor(sim.ammo * combat.ranged[w].baseKill);
  return combat.melee[w].capacity;
}

export function setDestination(sim: Sim, b: Building, kind: Sim['destinationKind']): void {
  const e = entranceNearest(b, sim.x, sim.y);
  sim.destination = { x: e.x, y: e.y };
  sim.destinationBuilding = b.id;
  sim.destinationKind = kind;
  sim.route = [];
  sim.routeIndex = 0;
}

export function clearDestination(sim: Sim): void {
  sim.destination = null;
  sim.destinationBuilding = null;
  sim.route = [];
  sim.routeIndex = 0;
}

/** Barricades cut both ways: leaving takes fortification × exitTicksPerFortification. */
export function exitTicks(world: World, b: Building): number {
  return Math.round(b.fortification * world.config.buildings.exitTicksPerFortification);
}

export function isLiving(s: Sim): boolean {
  return s.condition === 'healthy' || s.condition === 'infected';
}
