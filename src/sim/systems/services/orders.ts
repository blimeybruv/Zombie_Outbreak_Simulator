// Stay at home (the user's idea, B's design; docs/proposal-stay-at-home.md). The
// authorities' first order, the cheap one that comes before the reserve and the cordon and
// mostly fails: everyone is told to stay indoors.
//
//   the order   once stayHome.calls 911 calls have come in (what the authorities know of
//               the outbreak's size, as with the call-up), on every channel
//   hearing     a telling, like a shout: believed by the listener's trust, a sceptic
//               needing it corroborated (encounters.ts toldByAuthorities)
//   obeying     compliance, rolled once: two traits with two jobs on the same event
//   in force    for someone who believes in the outbreak and obeys, until the rescue's
//               broadcast supersedes it; no timer — a breach, panic or empty larders
//               override it for whoever they reach, by the systems that already do
//   police      an officer on patrol goes to people on the street and tells them again
//               (features.policeOrders, swept apart: it empties the streets)

import type { Context } from '../../context';
import { isOutdoorLiving } from '../../context';
import { chance } from '../../lib/rng';
import type { Sim, World } from '../../state';
import { toldByAuthorities, toldByOfficer } from '../people/encounters';
import { shuns } from '../people/traits';
import { isLiving } from '../shared/common';
import { steerToward } from '../people/steering';

/** The order goes out once enough calls have come in (building processes, after dispatch). */
export function issueStayHome(world: World, ctx: Context): void {
  const { config, tick } = world;
  if (!config.features.stayHome || world.stayHomeAt !== null || world.callsTaken < config.stayHome.calls) return;
  world.stayHomeAt = tick;
  const mid = config.map.size / 2;
  ctx.events.push({ type: 'stayHomeOrdered', tick, sim: null, x: mid, y: mid });
  for (const sim of world.sims) {
    if (sim.outsider || !isLiving(sim)) continue;
    toldByAuthorities(world, sim);
    sim.obeysOrder = chance(world.rng, sim.compliance);
  }
}

/** Someone tracked after the order went out (a resident stepping out, say) hears it too. */
export function hearsStandingOrder(world: World, sim: Sim): void {
  if (world.stayHomeAt === null || sim.outsider) return;
  toldByAuthorities(world, sim);
  sim.obeysOrder = chance(world.rng, sim.compliance);
}

/** Anyone tracked who appeared after the order went out (a resident stepping out, say) hears it too. Each tick, cheap: a null check per sim. */
export function newcomersHear(world: World): void {
  if (world.stayHomeAt === null) return;
  for (const sim of world.sims) if (sim.obeysOrder === null && !sim.outsider && isLiving(sim)) hearsStandingOrder(world, sim);
}

/** Whether the order still stands: out, and not yet superseded by the rescue's broadcast. */
export function orderStands(world: World): boolean {
  if (world.stayHomeAt === null) return false;
  const rc = world.config.rescue;
  return !(world.config.features.rescue && world.tick >= rc.at + rc.broadcast);
}

/**
 * Whether this sim stays in as told: the order stands, it believes in the outbreak, and it
 * obeys. Not for those with work the order does not mean (police, reservists, squads,
 * crews, the carried), nor one who shuns shelter — that refusal is its enclosure, not
 * defiance, and leaving it to the trait keeps compliance measurable apart from it (B).
 */
export function stayingIn(world: World, sim: Sim): boolean {
  if (!orderStands(world) || sim.obeysOrder !== true || sim.awareAt === null) return false;
  if (sim.outsider || sim.archetype === 'police' || sim.archetype === 'reservist') return false;
  if (sim.crew !== null || sim.squadLeader !== null || sim.carriedBy !== null || sim.muster !== null) return false;
  return !shuns(world, sim);
}

/**
 * An officer on patrol, the order standing: to the nearest person in sight out on the
 * street and not already making for shelter, within stayHome.policeReach and not told
 * lately; at encounter range it tells them to go in — a telling from the officer, so a
 * sceptic hears it twice — and goes on. No force: the obedient go in by their own
 * decision (sims.ts), the rest carry on. True while it is about this.
 */
export function tellPeopleIn(world: World, ctx: Context, officer: Sim): boolean {
  const { config, tick } = world;
  if (!config.features.policeOrders || !orderStands(world)) return false;
  const reach = config.stayHome.policeReach;
  ctx.simHash.query(officer.x, officer.y, reach, ctx.ids2);
  let best: Sim | null = null;
  let bestD = Infinity;
  for (const id of ctx.ids2) {
    const s = world.sims[id]!;
    if (s === officer || s.outsider || s.archetype === 'police' || !isOutdoorLiving(s) || s.car !== null) continue;
    if (s.destinationKind === 'shelter' || s.crew !== null || s.squadLeader !== null) continue;
    if (s.orderedInAt !== null && tick - s.orderedInAt < config.stayHome.retell) continue;
    const d = Math.hypot(s.x - officer.x, s.y - officer.y);
    if (d > reach || d > bestD || (d === bestD && best !== null && s.id > best.id)) continue;
    if (!ctx.map.lineOfSight(officer.x, officer.y, s.x, s.y)) continue;
    best = s;
    bestD = d;
  }
  if (best === null) return false;
  if (bestD <= config.encounters.radius) {
    best.orderedInAt = tick;
    toldByOfficer(world, best, officer);
    return false;
  }
  officer.gait = 'walk';
  steerToward(officer, best.x, best.y);
  return true;
}
