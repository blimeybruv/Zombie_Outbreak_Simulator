// Small helpers shared by sim decisions, building processes and the shelter
// economy. Kept apart so those systems do not import each other.

import { functionalProfile } from '../mapgen/generate';
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

export type Stage = 'open' | 'barricaded' | 'reinforced' | 'fortified';

/**
 * How well a building's door is held. Open unless the people inside know of the
 * outbreak and nobody has opened the door for barricadeTicks; then barricaded, and
 * reinforced or fortified as fortification reaches each threshold — as far as the
 * building's integrity allows. Derived, never stored: the inputs are the door, the
 * alert, fortification and the tag.
 */
export function stageOf(world: World, b: Building): Stage {
  const st = world.config.buildings.stages;
  if (b.alertedAt === null || b.residents + b.sheltered.length === 0) return 'open';
  if (world.tick - Math.max(b.alertedAt, b.doorOpenedAt ?? b.alertedAt) < st.barricadeTicks) return 'open';
  // How far the building itself allows: integrity caps the stage.
  const integrity = world.config.tags[functionalProfile(b.tag, world.config)].integrity;
  if (b.fortification >= st.fortifiedAt && integrity >= st.fortifiableFrom) return 'fortified';
  if (b.fortification >= st.reinforcedAt && integrity >= st.reinforcibleFrom) return 'reinforced';
  return 'barricaded';
}

/** Someone came in or went out: the barricade is down until it is put back. */
export function openDoor(world: World, b: Building): void {
  b.doorOpenedAt = world.tick;
}

/** Barricades cut both ways: leaving takes fortification × exitTicksPerFortification, and longer through a barricade. */
export function exitTicks(world: World, b: Building): number {
  const bc = world.config.buildings;
  const barricade = stageOf(world, b) === 'open' ? 0 : bc.stages.barricadeExitTicks;
  return Math.round(b.fortification * bc.exitTicksPerFortification) + barricade;
}

export function isLiving(s: Sim): boolean {
  return s.condition === 'healthy' || s.condition === 'infected';
}
