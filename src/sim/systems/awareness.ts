// Knowing there is an outbreak, and what a sim does about it.
//
// Unaware, a sim keeps its routine: errands, idling, the next stop. It becomes aware
// by seeing a zombie, a bite or a conversion, hearing gunfire or a shout, meeting
// someone who knows, or being indoors when the house is alerted. Aware, it drops the
// routine for an objective, chosen once and kept until something changes it:
//
//   respond   those who engage go toward the trouble they believe in nearby
//   home      within the archetype's reach, unless home is believed dangerous
//   shelter   the best building it knows (shelter.ts desirability); for the
//             faithful, the best church it knows
//
// Without this, survivors ran errands in a falling city until a zombie came into
// view, and the only purpose on the streets was a reaction.

import type { Context } from '../context';
import { confidence } from '../derived';
import type { Building, Sim, World } from '../state';
import { capacity, entranceNearest, setDestination } from './common';
import { chooseShelter } from './shelter';

export type Objective = { kind: 'respond'; x: number; y: number } | { kind: 'home' | 'shelter'; building: Building };

/**
 * The street nearby this sim most believes is in trouble, as its midpoint: believed
 * danger × confidence, at least `respondMin`, within `respondRadius` and not where
 * it already stands. Ties go to the lower street id, so the order the memory was
 * filled in does not matter.
 */
function trouble(world: World, sim: Sim): { x: number; y: number } | null {
  const { config, tick, streets, nodes } = world;
  const ac = config.awareness;
  let best: { x: number; y: number } | null = null;
  let bestScore = ac.respondMin;
  let bestId = Infinity;
  for (const [sid, belief] of sim.streetMemory) {
    const score = belief.danger * confidence(belief.observedAt, tick, config);
    if (score < bestScore || (score === bestScore && sid > bestId)) continue;
    const s = streets[sid]!;
    const a = nodes[s.a]!, b = nodes[s.b]!;
    const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
    const d = Math.hypot(x - sim.x, y - sim.y);
    if (d > ac.respondRadius || d <= ac.respondArrival) continue;
    best = { x, y };
    bestScore = score;
    bestId = sid;
  }
  return best;
}

/** Whether this sim believes its home street is dangerous now. */
function homeDangerous(world: World, sim: Sim, home: Building): boolean {
  const belief = sim.streetMemory.get(home.street);
  if (!belief) return false;
  return belief.danger * confidence(belief.observedAt, world.tick, world.config) >= world.config.awareness.homeDangerous;
}

/**
 * What an aware sim sets out to do. Null when it has nothing better than its
 * routine: someone who engages with no trouble known keeps patrolling.
 */
export function chooseObjective(world: World, ctx: Context, sim: Sim): Objective | null {
  const { config, buildings } = world;
  const arch = config.archetypes[sim.archetype];
  if (arch.engageThreshold > 0 && capacity(world, sim) > 0) {
    const p = trouble(world, sim);
    return p === null ? null : { kind: 'respond', ...p };
  }
  // (The faithful go to church, not home: chooseShelter keeps them to churches.)
  if (sim.church === null && sim.home !== null && sim.home !== sim.refusedBy) {
    const home = buildings[sim.home]!;
    const e = entranceNearest(home, sim.x, sim.y);
    if (Math.hypot(e.x - sim.x, e.y - sim.y) <= arch.homeReach && !homeDangerous(world, sim, home)) return { kind: 'home', building: home };
  }
  const b = chooseShelter(world, ctx, sim, sim.refusedBy);
  return b === null ? null : { kind: 'shelter', building: b };
}

/** Sets out for an objective: a point to respond to, or a building to shelter in. */
export function setObjective(sim: Sim, o: Objective): void {
  sim.idleUntil = null;
  if (o.kind === 'respond') {
    sim.destination = { x: o.x, y: o.y };
    sim.destinationBuilding = null;
    sim.destinationKind = 'respond';
    sim.route = [];
    sim.routeIndex = 0;
    return;
  }
  setDestination(sim, o.building, 'shelter');
}
