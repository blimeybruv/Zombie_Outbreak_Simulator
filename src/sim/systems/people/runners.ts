// Runners: work for those who will not shelter (the user's choice, from "make it better").
// A claustrophobe who wants out of the city and knows every way out is held had nothing
// to do but stand in the open. Now it runs supplies: from a store nobody is in to a
// shelter it believes is short, both at the door — a diehard never goes in, and nobody
// has to let it in — and at the shelter it trades what it knows for what they know.
//
//   fetch     to a building it believes holds supplies and nobody, to take a load
//   deliver   to a shelter it believes has people in it, the shorter of supplies the
//             better, the nearer the better; handed in at the door, and news traded
//
// Called from sim decisions (sims.ts, those who shun shelter) and building processes
// (buildings.ts arrivals, in place of going in).

import type { Context } from '../../context';
import { nextInt } from '../../lib/rng';
import { remember } from '../../navigation/memory';
import type { Building, Sim, World } from '../../state';
import { isLiving, refusedLately, setDestination } from '../shared/common';
import { merge } from './encounters';

/** Whether the sim is on a runner's errand. */
export function running(sim: Sim): boolean {
  return sim.destinationKind === 'fetch' || sim.destinationKind === 'deliver';
}

/** The next errand: a shelter to take a load to, or a store to fetch one from. False with none it knows of. */
export function nextRun(world: World, sim: Sim): boolean {
  const { config, buildings } = world;
  const scale = config.roles.scavengeDistanceScale;
  const cap = config.buildings.suppliesCap;
  let best: Building | null = null;
  let bestScore = 0;
  const loaded = sim.supplies > 0;
  for (const [bid, belief] of [...sim.buildingMemory.entries()].sort((a, b) => a[0] - b[0])) {
    if (refusedLately(world, sim, bid)) continue;
    const b = buildings[bid]!;
    const e = b.entrances[0]!;
    const near = 1 / (1 + Math.hypot(e.x - sim.x, e.y - sim.y) / scale);
    // Loaded: where people are, the shorter the better. Empty: what nobody holds.
    const score = loaded
      ? belief.believedOccupants > 0 ? (1 - Math.min(1, belief.supplies / cap)) * near : 0
      : belief.believedOccupants === 0 && belief.supplies > 0 ? Math.min(config.buildings.carryCap, belief.supplies) * near : 0;
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  if (best === null) return false;
  setDestination(sim, best, loaded ? 'deliver' : 'fetch');
  return true;
}

/** At the door of the building it ran to: the load taken or handed in, news traded, and on to the next. Building processes (arrivals). */
export function runnerArrives(world: World, ctx: Context, sim: Sim, b: Building): void {
  const { config, tick } = world;
  const seen = (supplies: number, occupants: number) =>
    remember(sim.buildingMemory, b.id, { believedOccupants: occupants, supplies, fortification: b.fortification, observedAt: tick, visited: sim.buildingMemory.get(b.id)?.visited ?? false }, config.memory.buildingCap);
  const people = b.sheltered.filter((id) => isLiving(world.sims[id]!));
  if (b.zombiesInside > 0) {
    // The dead in there: not this door, for a while (from outside they look like people).
    seen(b.supplies, b.zombiesInside);
    sim.refusals.set(b.id, tick + config.behaviour.refusedHold);
  } else if (sim.destinationKind === 'fetch') {
    const take = Math.min(config.buildings.carryCap - sim.supplies, b.supplies);
    b.supplies -= take;
    sim.supplies += take;
    seen(b.supplies, people.length + b.residents);
  } else if (people.length + b.residents > 0) {
    const amount = Math.min(sim.supplies, config.buildings.suppliesCap - b.supplies);
    if (amount > 0) {
      b.supplies += amount;
      sim.supplies -= amount;
      sim.history.suppliesDelivered += amount;
      ctx.events.push({ type: 'suppliesDelivered', tick, sim: sim.id, building: b.id, amount });
    }
    seen(b.supplies, people.length + b.residents);
    // What it has seen out there for what they know: with whoever comes to the door.
    if (people.length > 0) merge(world, sim, world.sims[Math.min(...people)]!);
  } else {
    seen(b.supplies, 0);
  }
  // A while at the door — loading up, or handing over and trading news — before the
  // next. Straight off again, a runner between a store and a shelter across the road
  // paced to and fro like someone lost (the oddity check: lap).
  const [lo, hi] = config.runners.pause;
  sim.idleUntil = tick + nextInt(world.rng, lo!, hi!);
  if (!nextRun(world, sim)) {
    sim.destinationKind = null;
    sim.destinationBuilding = null;
    sim.destination = null;
  }
}
