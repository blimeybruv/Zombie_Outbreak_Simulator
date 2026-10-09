// Tick step 11: proximity encounters, from final positions. First, warnings shouted
// this tick are heard (a street's danger, by everyone within earshot). Then one
// handler does every transfer between two sims who come within range of each other:
//   street memory and building memory merge by recency, per key
//   knownInfected merges by union
//   panic averages toward the higher value, damped, so calm spreads slower than fear
// One of three files allowed to read `panic`.

import type { Context } from '../context';
import { remember, trim } from '../memory';
import type { Sim, World } from '../state';
import { rebuildSimHash } from './perception';

function mergeNewer<K, V extends { observedAt: number; visited: boolean }>(into: Map<K, V>, from: Map<K, V>): void {
  for (const [key, theirs] of from) {
    const mine = into.get(key);
    if (mine === undefined) into.set(key, { ...theirs, visited: false });
    else if (theirs.observedAt > mine.observedAt) Object.assign(mine, theirs, { visited: mine.visited });
  }
}

/** Both ways, newer wins. The second pass cannot undo the first: copied entries tie on observedAt. */
function mergeBoth<K, V extends { observedAt: number; visited: boolean }>(a: Map<K, V>, b: Map<K, V>): void {
  mergeNewer(a, b);
  mergeNewer(b, a);
}

/** Everything two sims trade when they meet. Also used when a sim walks into a building where others shelter. */
export function merge(world: World, a: Sim, b: Sim): void {
  const damping = world.config.panic.encounterDamping;
  if (a.panic < b.panic) a.panic += (b.panic - a.panic) * damping;
  else if (b.panic < a.panic) b.panic += (a.panic - b.panic) * damping;

  const { streetCap, buildingCap } = world.config.memory;
  mergeBoth(a.streetMemory, b.streetMemory);
  mergeBoth(a.buildingMemory, b.buildingMemory);
  trim(a.streetMemory, streetCap);
  trim(b.streetMemory, streetCap);
  trim(a.buildingMemory, buildingCap);
  trim(b.buildingMemory, buildingCap);

  for (const id of b.knownInfected) if (id !== a.id) a.knownInfected.add(id);
  for (const id of a.knownInfected) if (id !== b.id) b.knownInfected.add(id);
}

/**
 * Warnings shouted this tick: everyone outdoors within earshot of the one who saw the
 * zombie learns its street is dangerous (newer news wins, as in a merge), and anyone
 * whose route uses that street plans again — a list intersection, not a search.
 */
function hearWarnings(world: World, ctx: Context): void {
  const { config, tick, sims } = world;
  for (const w of ctx.warnings) {
    ctx.simHash.query(w.x, w.y, config.encounters.warnRadius, ctx.ids2);
    for (const id of ctx.ids2) {
      if (id === w.from) continue;
      const s = sims[id]!;
      const belief = s.streetMemory.get(w.street);
      if (belief) {
        if (belief.observedAt >= tick) continue;
        belief.danger = w.danger;
        belief.observedAt = tick;
      } else {
        remember(s.streetMemory, w.street, { danger: w.danger, observedAt: tick, visited: false }, config.memory.streetCap);
      }
      if (s.destination !== null && !ctx.queued[id] && tick >= s.nextRepathAt && s.route.includes(w.street)) {
        ctx.queued[id] = 1;
        world.repathQueue.push(s.id);
      }
    }
  }
  ctx.warnings.length = 0;
}

export function resolveEncounters(world: World, ctx: Context): void {
  const { config, tick, sims } = world;
  const radius = config.encounters.radius;
  const cooldown = config.encounters.cooldown;
  rebuildSimHash(world, ctx);
  hearWarnings(world, ctx);
  const ids = ctx.ids;
  for (const a of sims) {
    if ((a.condition !== 'healthy' && a.condition !== 'infected') || a.insideBuilding !== null) continue;
    ctx.simHash.query(a.x, a.y, radius, ids);
    for (const bid of ids) {
      if (bid <= a.id) continue;
      const b = sims[bid]!;
      a.history.lastCompanyAt = tick;
      b.history.lastCompanyAt = tick;
      if (tick - a.lastMergeAt < cooldown || tick - b.lastMergeAt < cooldown) continue;
      merge(world, a, b);
      a.lastMergeAt = tick;
      b.lastMergeAt = tick;
    }
  }
}
