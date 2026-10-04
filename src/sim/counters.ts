// Incremental counter updates and the full recount the harness checks them against.

import type { Counters, Sim, World, Zombie } from './state';
import { emptyCounters } from './state';

export type Leaf =
  | 'unturned.outdoors'
  | 'unturned.indoors'
  | 'unturned.dead'
  | 'unturned.rescued'
  | 'turned.symptomatic'
  | 'turned.outdoors'
  | 'turned.occupying'
  | 'turned.destroyed';

function bump(c: Counters, leaf: Leaf, delta: number): void {
  const [group, key] = leaf.split('.') as ['unturned' | 'turned', string];
  (c[group] as unknown as Record<string, number>)[key]! += delta;
}

/** Moves n people from one leaf to another. Every state transition goes through here. */
export function transfer(world: World, from: Leaf, to: Leaf, n = 1): void {
  bump(world.counters, from, -n);
  bump(world.counters, to, n);
}

/** Adds n people to a leaf; only setup may create people. */
export function add(world: World, leaf: Leaf, n = 1): void {
  bump(world.counters, leaf, n);
}

export function simLeaf(sim: Sim): Leaf | null {
  switch (sim.condition) {
    case 'healthy':
      return sim.insideBuilding === null ? 'unturned.outdoors' : 'unturned.indoors';
    case 'infected':
      return 'turned.symptomatic';
    case 'dead':
      return 'unturned.dead';
    case 'turned':
      return null; // counted through the zombie it became
  }
}

export function zombieLeaf(z: Zombie): Leaf {
  switch (z.state) {
    case 'occupying':
      return 'turned.occupying';
    case 'destroyed':
      return 'turned.destroyed';
    default:
      return 'turned.outdoors';
  }
}

/** Counts every leaf from entity state, independently of the incremental counters. */
export function recount(world: World): Counters {
  const c = emptyCounters();
  for (const s of world.sims) {
    const leaf = simLeaf(s);
    if (leaf) bump(c, leaf, 1);
  }
  for (const z of world.zombies) bump(c, zombieLeaf(z), 1);
  for (const b of world.buildings) c.unturned.indoors += b.residents;
  c.unturned.dead += world.residentDeaths;
  return c;
}
