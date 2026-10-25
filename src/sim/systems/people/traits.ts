// The user's four survivor traits (state/sim.ts company, enclosure, resilience,
// handiness), read through these so each rule lives in one place (config.traits).

import type { Sim, World } from '../../state';

/** Someone free to choose where it shelters: not an officer, a reservist, a squad member or a soldier from outside, who go where their duty says. */
function free(sim: Sim): boolean {
  return sim.station === null && sim.depot === null && sim.squadLeader === null && !sim.outsider;
}

/** How agoraphobic, 0–1: 0 from the middle up, 1 at the end of the scale. */
export function agoraphobia(sim: Sim): number {
  return free(sim) ? Math.max(0, 1 - 2 * sim.enclosure) : 0;
}

/** How claustrophobic, 0–1: 0 from the middle down, 1 at the end of the scale. */
export function claustrophobia(sim: Sim): number {
  return free(sim) ? Math.max(0, 2 * sim.enclosure - 1) : 0;
}

/** Knowing of the outbreak, it will not go into a building at all (cars will do). */
export function diehard(world: World, sim: Sim): boolean {
  return sim.awareAt !== null && free(sim) && sim.enclosure > world.config.traits.enclosure.diehard;
}

/** Knowing of the outbreak, it goes into a building only with danger close, and out again once it is quiet. */
export function shuns(world: World, sim: Sim): boolean {
  return sim.awareAt !== null && free(sim) && sim.enclosure > world.config.traits.enclosure.shuns;
}

/** Agoraphobic enough never to go out for supplies, sortie, or move on when the supplies run out. */
export function clings(world: World, sim: Sim): boolean {
  return agoraphobia(sim) > world.config.traits.enclosure.clings;
}

/** Where its shelter's company term peaks: few for the close-knit, many for the gregarious. */
export function groupPeak(world: World, sim: Sim): number {
  const [lo, hi] = world.config.traits.company.peak;
  return lo + (hi - lo) * sim.company;
}

/** lo to hi with t, geometrically: their geometric mean at 0.5. */
function between(lo: number, hi: number, t: number): number {
  return lo * (hi / lo) ** t;
}

/** How much longer than the drawn delay it takes to turn: under 1 for the wimpy, over for the resilient. */
export function turnFactor(world: World, sim: Sim): number {
  const [lo, hi] = world.config.traits.resilience.turnFactor;
  return between(lo, hi, sim.resilience);
}

/** How much its building work counts, against an ordinary builder's. */
export function buildSpeed(world: World, sim: Sim): number {
  const [lo, hi] = world.config.traits.handiness.speed;
  return between(lo, hi, sim.handiness);
}

/** How many supplies its building work costs, against an ordinary builder's. */
export function buildWaste(world: World, sim: Sim): number {
  const [lo, hi] = world.config.traits.handiness.waste;
  return between(lo, hi, sim.handiness);
}
