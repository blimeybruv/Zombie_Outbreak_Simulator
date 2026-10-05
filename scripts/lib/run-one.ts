// One headless run, summarised for the sweep. Shared by scripts/sweep.ts workers.

import { config as baseConfig, type Config } from '../../src/config';
import { defaultScenario } from '../../src/sim/scenario';
import { createWorld } from '../../src/sim/setup';
import { turnedTotal, unturnedTotal, type Counters } from '../../src/sim/state';
import { SCORED, scoreLiving, type Scored } from '../../src/sim/systems/promotion';
import { step } from '../../src/sim/tick';
import { backstory } from '../../src/ui/backstory';
import type { World } from '../../src/sim/state';

export interface RosterEntry {
  stage: 'provisional' | 'final';
  tick: number;
  /** Place in the ranking that named them (1 = most unusual). */
  rank: number;
  id: number;
  name: string;
  archetype: string;
  score: number;
  /** The three counters furthest from the mean, either way. */
  top: { counter: string; z: number; value: number }[];
  backstory: string;
  /** Condition at the end of the run, and the tick it ended if it did. */
  fate: string;
  endedAt: number | null;
}

/** At each promotion stage: how many were scored, and how ticksSurvived correlates with every other counter among them. */
export interface StageStats {
  stage: 'provisional' | 'final';
  tick: number;
  pool: number;
  corrWithSurvived: Record<string, number>;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Records who a promotion stage just named, with what made them unusual, from the same state it scored. */
function recordStage(world: World, stage: 'provisional' | 'final', named: number[], roster: RosterEntry[], stats: StageStats[]): void {
  const scored = scoreLiving(world);
  const byId = new Map<number, { e: Scored; rank: number }>(scored.map((e, i) => [e.sim.id, { e, rank: i + 1 }]));
  for (const id of named) {
    const { e, rank } = byId.get(id)!;
    const top = SCORED.map((counter, i) => ({ counter, z: e.z[i]!, value: e.values[i]! }))
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
      .slice(0, 3);
    roster.push({ stage, tick: world.tick, rank, id, name: e.sim.name!, archetype: e.sim.archetype, score: e.score, top, backstory: backstory(e.sim, e.values, e.z, world.config), fate: '', endedAt: null });
  }
  const corrWithSurvived: Record<string, number> = {};
  for (let i = 1; i < SCORED.length; i++) corrWithSurvived[SCORED[i]!] = pearson(scored.map((e) => e.values[0]!), scored.map((e) => e.values[i]!));
  stats.push({ stage, tick: world.tick, pool: scored.length, corrWithSurvived });
}

export interface RunSummary {
  runSeed: number;
  mapSeed: number;
  population: number;
  /** Counters every `sampleEvery` ticks, starting at tick 0. */
  samples: Counters[];
  /** Share of the population that ever turned (turned leaves at the end). */
  infection: number;
  /** First tick the outbreak was over — no infection left, or nobody left — or null. */
  resolvedAt: number | null;
  msPerTick: number;
  invariantError: string | null;
  /** Garrisons established and fallen, and those established after the first fall. */
  shelters: { established: number; fell: number; reformed: number };
  /** Longest stretch with no conversion, death, kill, delivery or breach while anyone was alive. */
  longestQuiet: number;
  /** Tracked sims alive and healthy at the end, and in total, by caution band (low, mid, high). */
  caution: { alive: number[]; total: number[] };
  /** Everyone promoted, in promotion order, as scored when named. */
  roster: RosterEntry[];
  stages: StageStats[];
}

/** Events that count as something happening, for the stasis check. */
const ACTIVITY = new Set(['simTurned', 'simDied', 'zombieDestroyed', 'materialsDelivered', 'buildingBreached']);

/** Deep-sets `a.b.c=value` overrides on a copy of the config. */
export function withOverrides(overrides: Record<string, unknown>): Config {
  const copy = structuredClone(baseConfig) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split('.');
    let node = copy;
    for (const k of keys.slice(0, -1)) {
      if (typeof node[k] !== 'object' || node[k] === null) throw new Error(`unknown config path: ${path}`);
      node = node[k] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1]!;
    if (!(last in node)) throw new Error(`unknown config path: ${path}`);
    node[last] = value;
  }
  return copy as unknown as Config;
}

export function runOne(runSeed: number, mapSeed: number, overrides: Record<string, unknown>, sampleEvery = 600): RunSummary {
  const config = withOverrides(overrides);
  const { world, ctx } = createWorld({ ...defaultScenario, runSeed, mapSeed, stalemateController: false }, config);
  const samples: Counters[] = [structuredClone(world.counters)];
  let resolvedAt: number | null = null;
  let invariantError: string | null = null;
  const shelters = { established: 0, fell: 0, reformed: 0 };
  let lastActivity = 0;
  let longestQuiet = 0;
  const roster: RosterEntry[] = [];
  const stages: StageStats[] = [];
  const t0 = performance.now();
  try {
    while (world.tick < config.time.runLength) {
      const named = world.roster.length;
      step(world, ctx, { checkInvariant: true });
      if (world.promotedAt === world.tick) recordStage(world, 'provisional', world.roster.slice(named), roster, stages);
      else if (world.rescoredAt === world.tick) recordStage(world, 'final', world.roster.slice(named), roster, stages);
      for (const e of world.events) {
        if (ACTIVITY.has(e.type)) lastActivity = world.tick;
        if (e.type === 'shelterFell') shelters.fell++;
        if (e.type === 'shelterEstablished') {
          shelters.established++;
          if (shelters.fell > 0) shelters.reformed++;
        }
      }
      const c = world.counters;
      if (c.unturned.outdoors + c.unturned.indoors > 0) longestQuiet = Math.max(longestQuiet, world.tick - lastActivity);
      const active = c.turned.symptomatic + c.turned.outdoors + c.turned.occupying;
      if (resolvedAt === null && (active === 0 || unturnedTotal(c) - c.unturned.dead - c.unturned.rescued === 0)) {
        resolvedAt = world.tick;
      }
      if (world.tick % sampleEvery === 0) samples.push(structuredClone(c));
    }
  } catch (e) {
    invariantError = e instanceof Error ? e.message : String(e);
  }
  for (const r of roster) {
    const s = world.sims[r.id]!;
    r.fate = s.condition === 'healthy' ? 'alive' : s.condition;
    r.endedAt = s.history.endedAt;
  }
  const bands = config.promotion.cautionBands;
  const caution = { alive: [0, 0, 0], total: [0, 0, 0] };
  for (const s of world.sims) {
    const band = s.caution < bands[0]! ? 0 : s.caution < bands[1]! ? 1 : 2;
    caution.total[band]!++;
    if (s.condition === 'healthy') caution.alive[band]!++;
  }
  return {
    runSeed,
    mapSeed,
    population: world.scenario.population,
    samples,
    infection: turnedTotal(world.counters) / world.scenario.population,
    resolvedAt,
    msPerTick: (performance.now() - t0) / Math.max(1, world.tick),
    invariantError,
    shelters,
    longestQuiet,
    caution,
    roster,
    stages,
  };
}
