// Quarantine (B's design, the user's go): a shelter holds a newcomer apart for a while
// before letting it mix. Nothing reads its infection: the shelter learns by waiting. One
// that turns while held is put out of the door, and the shelter is spared. The most
// cautious person inside decides, and how long it holds them; if that one trusts readily,
// it holds nobody. A very cautious household also turns away anyone who comes running
// from the dead — a poor signal, but a cautious one (config.quarantine).

import type { Context } from '../../context';
import type { Building, Sim, World } from '../../state';
import { isLiving } from '../shared/common';

/** Whether it is held apart now. */
export function quarantined(world: World, sim: Sim): boolean {
  return sim.quarantinedUntil !== null && world.tick < sim.quarantinedUntil;
}

/** The one who decides for the household: the most cautious tracked person inside not itself held apart, ties to the lower id; null if none. */
function decider(world: World, b: Building): Sim | null {
  let best: Sim | null = null;
  for (const id of b.sheltered) {
    const o = world.sims[id]!;
    if (!isLiving(o) || quarantined(world, o)) continue;
    if (best === null || o.caution > best.caution || (o.caution === best.caution && o.id < best.id)) best = o;
  }
  return best;
}

/** How cautious the household is: its most cautious member's caution, or an ordinary resident's with nobody tracked inside. */
export function householdCaution(world: World, b: Building): number {
  return decider(world, b)?.caution ?? world.config.quarantine.residentCaution;
}

/** No stranger here: coming home, to its church, station or depot, a crew, a squad, someone carried in, a soldier. */
function belongs(sim: Sim, b: Building): boolean {
  return sim.home === b.id || sim.shelter === b.id || sim.church === b.id || sim.station === b.id || sim.depot === b.id || sim.crew !== null || sim.carriedBy !== null || sim.squadLeader !== null || sim.outsider;
}

/** How long a household that knows of the outbreak holds this newcomer apart: its caution × maxTicks, unless whoever decides trusts readily; 0 for one who belongs. */
export function holdFor(world: World, sim: Sim, b: Building): number {
  const q = world.config.quarantine;
  if (b.alertedAt === null || belongs(sim, b)) return 0;
  const d = decider(world, b);
  if (d !== null && d.trust > q.trustAbove) return 0;
  return Math.round(q.maxTicks * (d?.caution ?? q.residentCaution));
}

/** A very cautious household turns away a newcomer who comes running. */
export function refusesRunner(world: World, sim: Sim, b: Building): boolean {
  if (b.alertedAt === null || belongs(sim, b)) return false;
  if (sim.gait !== 'run' && sim.gait !== 'sprint') return false;
  return householdCaution(world, b) > world.config.quarantine.refuseRunnersAbove;
}

/** Where one who turned while held is put out: just outside the nearest door. */
export function putOutAt(world: World, ctx: Context, b: Building, x: number, y: number): { x: number; y: number } {
  let k = 0, best = Infinity;
  for (const [i, e] of b.entrances.entries()) {
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < best) {
      best = d;
      k = i;
    }
  }
  return ctx.map.outside(b.id, k, world.config.quarantine.putOut);
}
