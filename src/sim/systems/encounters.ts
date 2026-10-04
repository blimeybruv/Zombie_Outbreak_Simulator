// Tick step 11: proximity encounters, from final positions. One handler does
// every transfer between two sims who come within range of each other:
//   street memory and building memory merge by recency, per key
//   knownInfected merges by union
//   panic averages toward the higher value, damped, so calm spreads slower than fear
// One of three files allowed to read `panic`.

import type { Context } from '../context';
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

function merge(world: World, a: Sim, b: Sim): void {
  const damping = world.config.panic.encounterDamping;
  if (a.panic < b.panic) a.panic += (b.panic - a.panic) * damping;
  else if (b.panic < a.panic) b.panic += (a.panic - b.panic) * damping;

  mergeBoth(a.streetMemory, b.streetMemory);
  mergeBoth(a.buildingMemory, b.buildingMemory);

  for (const id of b.knownInfected) if (id !== a.id) a.knownInfected.add(id);
  for (const id of a.knownInfected) if (id !== b.id) b.knownInfected.add(id);
}

export function resolveEncounters(world: World, ctx: Context): void {
  const { config, tick, sims } = world;
  const radius = config.encounters.radius;
  const cooldown = config.encounters.cooldown;
  rebuildSimHash(world, ctx);
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
