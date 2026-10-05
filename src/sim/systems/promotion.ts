// Promotion: naming the survivors worth following. Two stages, so the viewer has
// names for most of the run and the names still mean something by the end.
//
//   provisional  living below half (or a fallback tick): the twelve most unusual
//                histories are named and join the roster.
//   final        living below 30%: re-score; anyone now in the top twelve who has no
//                name is named and joins the roster.
//
// Nobody is ever un-named or removed: the roster is append-only, so someone the
// viewer has been following stays followable. Scoring rewards unusual histories,
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

/** The history a sim is scored on: each value, for one sim, at this tick. */
function historyOf(sim: Sim, tick: number): number[] {
  const h = sim.history;
  return [
    tick - h.spawnedAt, // ticksSurvived
    h.conversionsWitnessed,
    tick - h.lastCompanyAt, // ticksAlone
    h.nearMisses,
    h.kills,
    h.streetsVisited,
    h.materialsDelivered,
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

/** Living sims scored by unusualness, most unusual first; ties go to the lower id. */
export function scoreLiving(world: World): Scored[] {
  const pool = world.sims.filter((s) => s.condition === 'healthy' || s.condition === 'infected');
  if (pool.length === 0) return [];
  const rows = pool.map((s) => historyOf(s, world.tick));
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
      const score = values.reduce((sum, v, i) => (sd[i]! > 0 ? sum + Math.abs(v - mean[i]!) / sd[i]! : sum), 0);
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

/** Names whoever in the current top `count` is not yet named. */
function promoteTop(world: World): SimId[] {
  const added: SimId[] = [];
  for (const sim of rankByUnusualness(world).slice(0, world.config.promotion.count)) {
    if (sim.name !== null) continue;
    sim.name = nameFor(world);
    world.roster.push(sim.id);
    added.push(sim.id);
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
      promoteTop(world);
      world.rescoredAt = tick;
    }
  }
}
