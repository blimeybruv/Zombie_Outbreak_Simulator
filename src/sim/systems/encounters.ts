// Tick step 11: proximity encounters, from final positions. First, warnings shouted
// this tick are heard (a street's danger, by everyone within earshot). Then, between
// two sims who come within range of each other, passing:
//   panic averages toward the higher value, damped, so calm spreads slower than fear
//   awareness of the outbreak: if either knows, both do (word of mouth)
// and, only if they stop to talk (conversations, below), what they know:
//   street memory and building memory merge by recency, per key
//   knownInfected merges by union
// and an invitation: a sociable sim bound for shelter goes along with someone bound
// for a nearer one ("come with us").
//
// Conversations: two who meet stop at a chance from their sociality and stand facing
// each other; a sociable passer may join one already going, up to a cap; each member
// leaves when its own time is up, the least sociable first, and what the conversation
// knows is pooled among those still in it. Nobody stops with danger in sight, in
// flight or on a call; decisions break a conversation up when anyone in it sees danger.
// One of three files allowed to read `panic`.

import type { Context } from '../context';
import { remember, trim } from '../memory';
import { chance } from '../rng';
import type { Sim, World } from '../state';
import { entranceNearest, leaveTalk, setDestination } from './common';
import { modeOf } from './panic';
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

/** What passes between two who meet, talking or not: fear, and that there is an outbreak. */
function pass(world: World, a: Sim, b: Sim): void {
  const damping = world.config.panic.encounterDamping;
  if (a.panic < b.panic) a.panic += (b.panic - a.panic) * damping;
  else if (b.panic < a.panic) b.panic += (a.panic - b.panic) * damping;
  if (a.awareAt !== null || b.awareAt !== null) {
    a.awareAt ??= world.tick;
    b.awareAt ??= world.tick;
  }
}

/** Everything two sims trade when they talk. Also used when a sim walks into a building where others shelter. */
export function merge(world: World, a: Sim, b: Sim): void {
  pass(world, a, b);
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

/** Free to stop and talk: outdoors, not already talking, nothing in sight, not in flight, fighting, backing off or on a call. */
function canTalk(world: World, ctx: Context, s: Sim): boolean {
  return (
    s.gathering === null &&
    s.insideBuilding === null &&
    s.exitingUntil === null &&
    s.stand === null &&
    s.avoidUntil === null &&
    s.sortieUntil === null &&
    s.answering === null &&
    s.destinationKind !== 'respond' &&
    ctx.threat[s.id]! === 0 &&
    modeOf(s, world.config) !== 'flight'
  );
}

/** Stops `s` for a conversation, for as long as its sociality keeps it there. */
function enterTalk(world: World, ctx: Context, s: Sim, host: number): void {
  const [lo, hi] = world.config.talk.ticks;
  s.gathering = host as Sim['id'];
  s.talkUntil = world.tick + Math.round(lo! + (hi! - lo!) * s.sociality);
  ctx.talkSize[host]!++;
}

/** Each member in id order trades with the first, then the first with each again: everyone ends with what anyone knew. */
function pool(world: World, members: Sim[]): void {
  const first = members[0]!;
  for (let i = 1; i < members.length; i++) merge(world, first, members[i]!);
  for (let i = 1; i < members.length - 1; i++) merge(world, first, members[i]!);
}

/**
 * Limited sociality: `a`, aware and on its way to a shelter it has not yet made its
 * own, meets `b` bound for a different one that is nearer to `a` than its own goal,
 * and goes with them, at 2 × its own sociality × the archetype's (up to 1: the
 * archetype's figure is the chance at middling sociality). Nobody stops to talk
 * with danger in sight; loners never go. The two then walk the same way, which is
 * as much grouping as there is: no leader, no formation, no keeping together (that
 * is for squads, later).
 */
function join(world: World, ctx: Context, a: Sim, b: Sim): boolean {
  const { config, buildings } = world;
  const arch = config.archetypes[a.archetype];
  if (arch.sociality <= 0 || a.awareAt === null || a.shelter !== null) return false;
  if (a.destinationKind !== 'shelter' || a.destination === null || b.destinationKind !== 'shelter') return false;
  const x = b.destinationBuilding;
  if (x === null || x === a.destinationBuilding || x === a.refusedBy) return false;
  if (a.church !== null && buildings[x]!.tag !== 'church') return false; // the faithful go only to church
  if (ctx.threat[a.id]! >= arch.shelterSeekThreshold) return false;
  const e = entranceNearest(buildings[x]!, a.x, a.y);
  if (Math.hypot(e.x - a.x, e.y - a.y) >= Math.hypot(a.destination.x - a.x, a.destination.y - a.y)) return false;
  if (!chance(world.rng, Math.min(1, 2 * a.sociality * arch.sociality))) return false;
  setDestination(a, buildings[x]!, 'shelter');
  return true;
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
      s.awareAt ??= tick;
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
  const tc = config.talk;
  const radius = config.encounters.radius;
  const cooldown = config.encounters.cooldown;
  rebuildSimHash(world, ctx);
  hearWarnings(world, ctx);

  // Time up, gone indoors, dead or turned: out of the conversation.
  ctx.talkSize.fill(0, 0, sims.length);
  for (const s of sims) {
    if (s.gathering === null) continue;
    if (tick >= s.talkUntil! || s.insideBuilding !== null || (s.condition !== 'healthy' && s.condition !== 'infected')) leaveTalk(s, tick);
    else ctx.talkSize[s.gathering]!++;
  }

  const ids = ctx.ids;
  for (const a of sims) {
    if ((a.condition !== 'healthy' && a.condition !== 'infected') || a.insideBuilding !== null) continue;
    ctx.simHash.query(a.x, a.y, radius, ids);
    for (const bid of ids) {
      if (bid <= a.id) continue;
      const b = sims[bid]!;
      a.history.lastCompanyAt = tick;
      b.history.lastCompanyAt = tick;
      if (a.gathering !== null || b.gathering !== null) continue; // passing a conversation: below
      if (tick - a.lastMergeAt < cooldown || tick - b.lastMergeAt < cooldown) continue;
      pass(world, a, b);
      // A conversation is named by whoever started it; not by one whose last is still going.
      const host = ctx.talkSize[a.id] === 0 ? a.id : ctx.talkSize[b.id] === 0 ? b.id : null;
      if (host !== null && canTalk(world, ctx, a) && canTalk(world, ctx, b) && chance(world.rng, Math.min(1, (tc.chance * (a.sociality + b.sociality)) / 2))) {
        enterTalk(world, ctx, a, host);
        enterTalk(world, ctx, b, host);
        merge(world, a, b);
      }
      if (!join(world, ctx, a, b)) join(world, ctx, b, a);
      a.lastMergeAt = tick;
      b.lastMergeAt = tick;
    }
  }

  // Passers drawn into a conversation within joinRadius: the nearest member's (ties to
  // the lower id), once per cooldown, at the passer's own sociality.
  for (const a of sims) {
    if (a.gathering !== null || (a.condition !== 'healthy' && a.condition !== 'infected') || a.insideBuilding !== null) continue;
    if (tick - a.lastMergeAt < cooldown) continue;
    ctx.simHash.query(a.x, a.y, tc.joinRadius, ids);
    let member: Sim | null = null;
    let best = Infinity;
    for (const bid of ids) {
      const b = sims[bid]!;
      if (b.gathering === null || ctx.talkSize[b.gathering]! >= tc.cap) continue;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d < best || (d === best && b.id < member!.id)) {
        best = d;
        member = b;
      }
    }
    if (member === null) continue;
    a.lastMergeAt = tick;
    pass(world, a, member);
    if (canTalk(world, ctx, a) && chance(world.rng, Math.min(1, tc.joinChance * a.sociality))) {
      enterTalk(world, ctx, a, member.gathering!);
      merge(world, a, member);
    }
  }

  // Pooling, each conversation on its own beat, in the order of the ids that name them.
  const groups: Sim[][] = [];
  for (const s of sims) if (s.gathering !== null && (tick + s.gathering) % tc.poolInterval === 0) (groups[s.gathering] ??= []).push(s);
  for (const g of groups) if (g !== undefined && g.length > 1) pool(world, g);
}
