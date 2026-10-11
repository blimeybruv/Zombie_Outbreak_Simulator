// Tick step 11: proximity encounters, from final positions. First, warnings shouted
// this tick are heard: a street's danger, by everyone within earshot, and that there
// is an outbreak only by those who see the shouter — to the rest a shout is a telling,
// raising unease (config.unease). Then, between
// two sims who come within range of each other, passing:
//   panic averages toward the higher value, damped, so calm spreads slower than fear
// and, only if they stop to talk (conversations, below), what they know, as each
// listener judges it by its trust (config.trust):
//   awareness of the outbreak: told by enough different people, it believes
//   street memory and building memory merge by recency as heard, per key: a
//     sceptic hears everything as older than it is
//   knownInfected merges by union, each side taking it on at its own trust
// and an invitation: a sociable sim bound for shelter goes along with someone bound
// for a nearer one ("come with us").
//
// Conversations: two who meet stop at a chance from their sociality and stand facing
// each other; a sociable passer may join one already going, up to a cap; each member
// leaves when its own time is up, the least sociable first, and what the conversation
// knows is pooled among those still in it. Nobody stops with danger in sight, in
// flight or on a call; decisions break a conversation up when anyone in it sees danger.
// One of three files allowed to read `panic`.

import { isOutdoorLiving, type Context } from '../context';
import { noteStreet, settleDanger, trim } from '../memory';
import { chance } from '../rng';
import type { Sim, World } from '../state';
import { entranceNearest, leaveTalk, setDestination } from './common';
import { modeOf } from './panic';
import { rebuildSimHash } from './perception';

/**
 * Takes what `from` knows that is newer, as the listener hears it: `shift` ticks older
 * than it is. With `quietLook`, danger is settled rather than replaced (memory.ts
 * settleDanger): newer news of a quiet street lowers a warning only part of the way.
 */
function mergeNewer<K, V extends { observedAt: number; visited: boolean; danger?: number }>(into: Map<K, V>, from: Map<K, V>, shift: number, quietLook?: number): void {
  for (const [key, theirs] of from) {
    const mine = into.get(key);
    const heard = theirs.observedAt - shift;
    if (mine === undefined) into.set(key, { ...theirs, observedAt: heard, visited: false });
    else if (heard > mine.observedAt) {
      const believed = mine.danger;
      Object.assign(mine, theirs, { observedAt: heard, visited: mine.visited });
      if (quietLook !== undefined && believed !== undefined) mine.danger = settleDanger(believed, theirs.danger!, quietLook);
    }
  }
}

/**
 * Both ways, newer (as heard) wins. The second pass cannot undo the first: a copied
 * entry is no newer than the original it came from.
 */
function mergeBoth<K, V extends { observedAt: number; visited: boolean; danger?: number }>(a: Map<K, V>, b: Map<K, V>, shiftA: number, shiftB: number, quietLook?: number): void {
  mergeNewer(a, b, shiftA, quietLook);
  mergeNewer(b, a, shiftB, quietLook);
}

/** How much older hearsay seems to this listener. */
function hearsayAge(world: World, s: Sim): number {
  return Math.round((1 - trustOf(world, s)) * world.config.trust.ageShift);
}

/** A sim's trust, or full trust with the feature off. */
function trustOf(world: World, s: Sim): number {
  return world.config.features.trust ? s.trust : 1;
}

/**
 * `listener`, unaware, is told by `teller` that there is an outbreak: unease rises by
 * the listener's trust, once per teller, and at `believeAt` it believes.
 */
function told(world: World, listener: Sim, teller: Sim): void {
  if (listener.awareAt !== null || teller.awareAt === null || listener.toldBy.has(teller.id)) return;
  const uc = world.config.unease;
  listener.toldBy.add(teller.id);
  if (!world.config.features.unease) {
    listener.awareAt = world.tick;
    listener.toldBy.clear();
    return;
  }
  const gain = uc.tellingGain[0]! + (uc.tellingGain[1]! - uc.tellingGain[0]!) * trustOf(world, listener);
  listener.unease = Math.min(1, listener.unease + (1 - listener.unease) * gain);
  if (listener.unease < uc.believeAt) return;
  listener.awareAt = world.tick;
  listener.toldBy.clear();
}

/**
 * What passes between two who meet, talking or not: fear. That there is an outbreak
 * takes a conversation — a passer-by's frightened look is not news.
 */
function pass(world: World, a: Sim, b: Sim): void {
  const damping = world.config.panic.encounterDamping;
  if (a.panic < b.panic) a.panic += (b.panic - a.panic) * damping;
  else if (b.panic < a.panic) b.panic += (a.panic - b.panic) * damping;
}

/** How recent its news is of where it is heading: its street and the building, summed; -1 with no building in view. */
function headingNews(world: World, s: Sim): number {
  if (s.destinationBuilding === null) return -1;
  const b = world.buildings[s.destinationBuilding]!;
  return (s.streetMemory.get(b.street)?.observedAt ?? 0) + (s.buildingMemory.get(b.id)?.observedAt ?? 0);
}

/** Everything two sims trade when they talk. Also used when a sim walks into a building where others shelter. */
export function merge(world: World, a: Sim, b: Sim): void {
  const newsA = headingNews(world, a), newsB = headingNews(world, b);
  pass(world, a, b);
  const aWasAware = a.awareAt !== null;
  told(world, a, b);
  if (aWasAware) told(world, b, a);
  const { streetCap, buildingCap } = world.config.memory;
  const shiftA = hearsayAge(world, a), shiftB = hearsayAge(world, b);
  mergeBoth(a.streetMemory, b.streetMemory, shiftA, shiftB, world.config.memory.quietLook);
  mergeBoth(a.buildingMemory, b.buildingMemory, shiftA, shiftB);
  trim(a.streetMemory, streetCap);
  trim(b.streetMemory, streetCap);
  trim(a.buildingMemory, buildingCap);
  trim(b.buildingMemory, buildingCap);
  // News of where either is heading: weigh it again (awareness.ts reconsider).
  if (headingNews(world, a) !== newsA) a.reconsider = true;
  if (headingNews(world, b) !== newsB) b.reconsider = true;

  // Who is said to be bitten: each takes it on at its own trust, judged on what the
  // other knew before they met.
  const fromB = b.knownInfected.size > 0 && chance(world.rng, trustOf(world, a)) ? [...b.knownInfected] : [];
  if (a.knownInfected.size > 0 && chance(world.rng, trustOf(world, b))) for (const id of a.knownInfected) if (id !== b.id) b.knownInfected.add(id);
  for (const id of fromB) if (id !== a.id) a.knownInfected.add(id);
}

/** Free to stop and talk: outdoors, not already talking, nothing in sight, not in flight, fighting, backing off or on a call. */
function canTalk(world: World, ctx: Context, s: Sim): boolean {
  return (
    world.config.features.conversations &&
    s.gathering === null &&
    s.insideBuilding === null &&
    s.car === null &&
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
    const shouter = sims[w.from]!;
    ctx.simHash.query(w.x, w.y, config.encounters.warnRadius, ctx.ids2);
    for (const id of ctx.ids2) {
      if (id === w.from) continue;
      const s = sims[id]!;
      // A shout says something is wrong here, not what. Seeing the one who shouted,
      // fleeing or set upon, is a sighting; hearing alone is a telling.
      if (s.awareAt === null) {
        if (Math.hypot(w.x - s.x, w.y - s.y) <= ctx.radius[id]! && ctx.map.lineOfSight(s.x, s.y, w.x, w.y)) s.awareAt = tick;
        else told(world, s, shouter);
      }
      if (s.destinationBuilding !== null && world.buildings[s.destinationBuilding]!.street === w.street) s.reconsider = true;
      if ((s.streetMemory.get(w.street)?.observedAt ?? -Infinity) >= tick) continue;
      noteStreet(s.streetMemory, w.street, w.danger, tick, config.memory);
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
  const talking = config.features.conversations;
  const radius = config.encounters.radius;
  const cooldown = config.encounters.cooldown;
  rebuildSimHash(world, ctx);
  hearWarnings(world, ctx);

  // Time up, gone indoors, dead or turned: out of the conversation.
  ctx.talkSize.fill(0, 0, sims.length);
  for (const s of sims) {
    if (s.gathering === null) continue;
    if (tick >= s.talkUntil! || s.insideBuilding !== null || s.car !== null || (s.condition !== 'healthy' && s.condition !== 'infected')) leaveTalk(s, tick);
    else ctx.talkSize[s.gathering]!++;
  }

  const ids = ctx.ids;
  for (const a of sims) {
    if (!isOutdoorLiving(a)) continue;
    ctx.simHash.query(a.x, a.y, radius, ids);
    for (const bid of ids) {
      if (bid <= a.id) continue;
      const b = sims[bid]!;
      a.history.lastCompanyAt = tick;
      b.history.lastCompanyAt = tick;
      if (a.gathering !== null || b.gathering !== null) continue; // passing a conversation: below
      if (tick - a.lastMergeAt < cooldown || tick - b.lastMergeAt < cooldown) continue;
      // Without conversations, every meeting trades everything.
      if (!talking) merge(world, a, b);
      else pass(world, a, b);
      // A conversation is named by whoever started it; not by one whose last is still going.
      const host = ctx.talkSize[a.id] === 0 ? a.id : ctx.talkSize[b.id] === 0 ? b.id : null;
      if (talking && host !== null && canTalk(world, ctx, a) && canTalk(world, ctx, b) && chance(world.rng, Math.min(1, (tc.chance * (a.sociality + b.sociality)) / 2))) {
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
  for (const a of talking ? sims : []) {
    if (a.gathering !== null || !isOutdoorLiving(a)) continue;
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
