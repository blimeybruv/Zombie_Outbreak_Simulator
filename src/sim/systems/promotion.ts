// Promotion: naming the survivors worth following. Two stages, so the viewer has
// names for most of the run and the names still mean something by the end.
//
//   provisional  living below half (or a fallback tick): the twelve most unusual
//                histories are named and join the roster.
//   final        living below 30%: re-score, and name the most unusual of the unnamed
//                until twelve of the named are alive again; then the same top-up every
//                `topUpEvery` ticks as the pool thins.
//
// Nobody is ever un-named or removed: the roster is append-only, so someone the
// viewer has been following stays followable, and the dead stay as a record of who
// was lost while the top-ups keep a current cast. Scoring rewards unusual histories,
// not high ones — the sum of each counter's distance from the population mean in
// standard deviations — so the interesting survivors select themselves.
//
// Promotion reads the counters reconciled this tick and changes only names and the
// roster; no behaviour reads either.

import { nextInt } from '../rng';
import { FIRST_NAMES, SURNAMES } from '../names';
import type { Sim, SimId, World } from '../state';

/** The counters a sim is scored on, in the order `historyOf` returns them. */
export const SCORED = [
  'ticksSurvived',
  'conversionsWitnessed',
  'ticksAlone',
  'nearMisses',
  'kills',
  'streetsVisited',
  'materialsDelivered',
  'caution',
] as const;
export type ScoredCounter = (typeof SCORED)[number];

/**
 * The history a sim is scored on: each value, for one sim, at this tick. Under
 * 'rates' scoring the counters that grow with exposure are per hour on record
 * (with a floor), so they measure what kind of life it was rather than its length.
 */
function historyOf(sim: Sim, tick: number, config: World['config']): number[] {
  const h = sim.history;
  const age = tick - h.spawnedAt;
  const per = config.promotion.scoring === 'rates' ? 3600 / Math.max(age, config.promotion.rateFloor) : 1;
  return [
    age, // ticksSurvived
    h.conversionsWitnessed * per,
    tick - h.lastCompanyAt, // ticksAlone: already a duration
    h.nearMisses * per,
    h.kills * per,
    h.streetsVisited * per,
    h.materialsDelivered * per,
    sim.caution,
  ];
}

export interface Scored {
  sim: Sim;
  /** Sum of |z| over the scored counters. */
  score: number;
  /** Each counter's value, in SCORED order. */
  values: number[];
  /** Each counter's signed distance from the living mean in standard deviations (0 where every sim is equal). */
  z: number[];
}

/**
 * Living sims scored by unusualness, most unusual first; ties go to the lower id.
 * Each counter contributes |z| capped at `zCap`; `unscored` counters contribute
 * nothing (their z is still reported). Unless `nameBitten`, the pool is the healthy:
 * promotion, unlike the people in the run, may see a bite, and does not name
 * someone seconds from turning. Anyone already named stays named whatever happens.
 */
export function scoreLiving(world: World): Scored[] {
  const pc = world.config.promotion;
  const skip = SCORED.map((name) => pc.unscored.includes(name));
  const pool = world.sims.filter((s) => s.condition === 'healthy' || (pc.nameBitten && s.condition === 'infected'));
  if (pool.length === 0) return [];
  const rows = pool.map((s) => historyOf(s, world.tick, world.config));
  const k = rows[0]!.length;
  const mean = new Array<number>(k).fill(0);
  const sd = new Array<number>(k).fill(0);
  for (const r of rows) for (let i = 0; i < k; i++) mean[i]! += r[i]! / rows.length;
  for (const r of rows) for (let i = 0; i < k; i++) sd[i]! += (r[i]! - mean[i]!) ** 2 / rows.length;
  for (let i = 0; i < k; i++) sd[i] = Math.sqrt(sd[i]!);
  return pool
    .map((sim, j) => {
      const values = rows[j]!;
      const z = values.map((v, i) => (sd[i]! > 0 ? (v - mean[i]!) / sd[i]! : 0));
      const score = z.reduce((sum, zi, i) => (skip[i] ? sum : sum + Math.min(pc.zCap, Math.abs(zi))), 0);
      return { sim, score, values, z };
    })
    .sort((a, b) => b.score - a.score || a.sim.id - b.sim.id);
}

/** Living sims ranked by unusualness, most unusual first; ties go to the lower id. */
export function rankByUnusualness(world: World): Sim[] {
  return scoreLiving(world).map((e) => e.sim);
}

function nameFor(world: World): string {
  const taken = new Set(world.roster.map((id) => world.sims[id]!.name));
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = `${FIRST_NAMES[nextInt(world.rng, 0, FIRST_NAMES.length - 1)]} ${SURNAMES[nextInt(world.rng, 0, SURNAMES.length - 1)]}`;
    if (!taken.has(name)) return name;
  }
  return `Survivor ${world.roster.length + 1}`;
}

function name(world: World, sim: Sim): void {
  sim.name = nameFor(world);
  sim.namedAt = world.tick;
  world.roster.push(sim.id);
}

/** Names whoever in the current top `count` is not yet named. */
function promoteTop(world: World): SimId[] {
  const added: SimId[] = [];
  for (const sim of rankByUnusualness(world).slice(0, world.config.promotion.count)) {
    if (sim.name !== null || world.roster.length >= world.config.promotion.rosterCap) continue;
    name(world, sim);
    added.push(sim.id);
  }
  return added;
}

/** Names the most unusual of the unnamed until `count` of the named are alive (as far as anyone can see). */
function topUp(world: World): SimId[] {
  const { count, rosterCap } = world.config.promotion;
  let living = world.roster.filter((id) => {
    const c = world.sims[id]!.condition;
    return c === 'healthy' || c === 'infected';
  }).length;
  const added: SimId[] = [];
  for (const sim of rankByUnusualness(world)) {
    if (living >= count || world.roster.length >= rosterCap) break;
    if (sim.name !== null) continue;
    name(world, sim);
    added.push(sim.id);
    living++;
  }
  return added;
}

export function updatePromotion(world: World): void {
  const { config, tick, counters, scenario } = world;
  const living = (counters.unturned.outdoors + counters.unturned.indoors) / scenario.population;
  const { provisional, final } = config.promotion;
  if (world.promotedAt === null) {
    if (living < provisional.livingFraction || tick >= provisional.fallbackTick) {
      promoteTop(world);
      world.promotedAt = tick;
    }
  } else if (world.rescoredAt === null) {
    if (living < final.livingFraction || tick >= final.fallbackTick) {
      topUp(world);
      world.rescoredAt = tick;
    }
  } else if ((tick - world.rescoredAt) % final.topUpEvery === 0) {
    topUp(world);
  }
}
