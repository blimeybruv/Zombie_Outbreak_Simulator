// One headless run, summarised for the sweep. Shared by scripts/sweep.ts workers.

import { config as baseConfig, type Config } from '../../src/config';
import { defaultScenario } from '../../src/sim/scenario';
import { createWorld } from '../../src/sim/setup';
import { turnedTotal, unturnedTotal, type Counters } from '../../src/sim/state';
import { SCORED, scoreLiving, type Scored } from '../../src/sim/systems/promotion';
import { step } from '../../src/sim/tick';
import { backstory } from '../../src/worker/backstory';
import { noteFor } from '../../src/worker/notes';
import { line } from '../../src/ui/copy';
import { BASE, MAJOR, Salience } from '../../src/ui/salience';
import type { World } from '../../src/sim/state';

/**
 * What a sample window looked like beyond the counters: why a run smoulders or takes
 * off, and what there was to watch. Each entry covers the `sampleEvery` ticks up to `tick`.
 */
export interface TimelineEntry {
  tick: number;
  /** Zombies at the end of the window, by state; `intact` of those not destroyed. */
  zombies: { awake: number; dormant: number; occupying: number; intact: number };
  /** Living outdoors at the end of the window: aware, uneasy (unease ≥ 0.2, unaware), unaware. */
  outdoors: { aware: number; uneasy: number; unaware: number };
  /** Outdoors in a conversation at the end of the window, and conversations of three or more. */
  talking: number;
  gatherings: number;
  /** Cars driving and abandoned at the end of the window. */
  cars: { driving: number; abandoned: number };
  /** Noises made in the window: gunshots (and other weapon noise), shouts. */
  shots: number;
  shouts: number;
  /** Events in the window, by type. */
  events: Record<string, number>;
  /** Ticker lines a viewer at 1× would get in the window if everything were on screen (an upper bound), and how many were major. */
  lines: number;
  majorLines: number;
}

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
  /**
   * Everyone scored, with raw totals in SCORED order (whatever the scoring setting) —
   * names never change behaviour, so any scoring rule can be judged offline against
   * the same run (scripts/roster-eval.ts).
   */
  candidates: { id: number; raw: number[]; infected: boolean; archetype: string }[];
}

/** Raw totals in SCORED order, independent of promotion.scoring. */
function rawHistory(s: World['sims'][number], tick: number): number[] {
  const h = s.history;
  return [tick - h.spawnedAt, h.conversionsWitnessed, tick - h.lastCompanyAt, h.nearMisses, h.kills, h.streetsVisited, h.materialsDelivered, s.caution];
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
  const candidates = scored.map((e) => ({ id: e.sim.id, raw: rawHistory(e.sim, world.tick), infected: e.sim.condition === 'infected', archetype: e.sim.archetype }));
  stats.push({ stage, tick: world.tick, pool: scored.length, corrWithSurvived, candidates });
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
  /** The same by sociality band, counting only sims whose archetype ever joins anyone (the trait does nothing for the rest). */
  sociality: { alive: number[]; total: number[] };
  /** The same by trust band, every tracked sim. */
  trust: { alive: number[]; total: number[] };
  /** By caution band among the asocial (sociality below the lowest band edge): whether caution still matters for those who seldom talk or join. */
  cautionAsocial: { alive: number[]; total: number[] };
  /** Everyone promoted, in promotion order, as scored when named. */
  roster: RosterEntry[];
  stages: StageStats[];
  /** How everyone scored at a promotion stage ended: condition at the end, and when. */
  fates: Record<number, { condition: string; endedAt: number | null }>;
  /** One entry per sample window: zombie states, awareness outdoors, talk, noise, events, ticker lines. */
  timeline: TimelineEntry[];
  runLength: number;
}

/** The state half of a timeline entry, at the end of a window. */
function snapshot(world: World): Pick<TimelineEntry, 'zombies' | 'outdoors' | 'talking' | 'gatherings' | 'cars'> {
  const zombies = { awake: 0, dormant: 0, occupying: 0, intact: 0 };
  for (const z of world.zombies) {
    if (z.state === 'destroyed') continue;
    if (z.intact) zombies.intact++;
    if (z.state === 'dormant') zombies.dormant++;
    else if (z.state === 'occupying') zombies.occupying++;
    else zombies.awake++;
  }
  const outdoors = { aware: 0, uneasy: 0, unaware: 0 };
  let talking = 0;
  const sizes: number[] = [];
  for (const s of world.sims) {
    if ((s.condition !== 'healthy' && s.condition !== 'infected') || s.insideBuilding !== null) continue;
    if (s.awareAt !== null) outdoors.aware++;
    else if (s.unease >= 0.2) outdoors.uneasy++;
    else outdoors.unaware++;
    if (s.gathering !== null) {
      talking++;
      sizes[s.gathering] = (sizes[s.gathering] ?? 0) + 1;
    }
  }
  const cars = { driving: 0, abandoned: 0 };
  for (const c of world.cars) {
    if (c.state === 'driving') cars.driving++;
    else if (c.state === 'abandoned') cars.abandoned++;
  }
  return { zombies, outdoors, talking, gatherings: sizes.filter((n) => n >= 3).length, cars };
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

export function runOne(runSeed: number, mapSeed: number, overrides: Record<string, unknown>, sampleEvery = 600, scenario: Record<string, unknown> = {}): RunSummary {
  const config = withOverrides(overrides);
  const { world, ctx } = createWorld({ ...defaultScenario, ...scenario, runSeed, mapSeed, stalemateController: false }, config);
  const samples: Counters[] = [structuredClone(world.counters)];
  let resolvedAt: number | null = null;
  let invariantError: string | null = null;
  const shelters = { established: 0, fell: 0, reformed: 0 };
  let lastActivity = 0;
  let longestQuiet = 0;
  const roster: RosterEntry[] = [];
  const stages: StageStats[] = [];
  const timeline: TimelineEntry[] = [];
  const salience = new Salience();
  let win = { shots: 0, shouts: 0, events: {} as Record<string, number>, lines: 0, majorLines: 0 };
  const t0 = performance.now();
  try {
    while (world.tick < config.time.runLength) {
      const named = world.roster.length;
      step(world, ctx, { checkInvariant: true });
      if (world.promotedAt === world.tick) recordStage(world, 'provisional', world.roster.slice(named), roster, stages);
      else if (world.rescoredAt === world.tick) recordStage(world, 'final', world.roster.slice(named), roster, stages);
      for (const s of world.stimuli) {
        if (s.createdAt !== world.tick) continue;
        if (s.kind === 'shout') win.shouts++;
        else if (s.kind !== 'engine') win.shots++;
      }
      for (const e of world.events) {
        win.events[e.type] = (win.events[e.type] ?? 0) + 1;
        const n = noteFor(world, ctx, e);
        if (n && line(e, n) !== null) {
          const kind = salience.pass(e, n, 1, true);
          if (kind !== null) {
            win.lines++;
            if (BASE[kind] >= MAJOR) win.majorLines++;
          }
        }
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
      if (resolvedAt === null && (active === 0 || unturnedTotal(c) - c.unturned.dead - c.unturned.evacuated === 0)) {
        resolvedAt = world.tick;
      }
      if (world.tick % sampleEvery === 0) {
        samples.push(structuredClone(c));
        timeline.push({ tick: world.tick, ...snapshot(world), ...win });
        win = { shots: 0, shouts: 0, events: {}, lines: 0, majorLines: 0 };
      }
    }
  } catch (e) {
    invariantError = e instanceof Error ? e.message : String(e);
  }
  const fates: RunSummary['fates'] = {};
  for (const st of stages) {
    for (const c of st.candidates) {
      const s = world.sims[c.id]!;
      fates[c.id] = { condition: s.condition, endedAt: s.history.endedAt };
    }
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
  const cautionAsocial = { alive: [0, 0, 0], total: [0, 0, 0] };
  for (const s of world.sims) {
    if (s.sociality >= bands[0]!) continue;
    const band = s.caution < bands[0]! ? 0 : s.caution < bands[1]! ? 1 : 2;
    cautionAsocial.total[band]!++;
    if (s.condition === 'healthy') cautionAsocial.alive[band]!++;
  }
  const trust = { alive: [0, 0, 0], total: [0, 0, 0] };
  for (const s of world.sims) {
    const band = s.trust < bands[0]! ? 0 : s.trust < bands[1]! ? 1 : 2;
    trust.total[band]!++;
    if (s.condition === 'healthy') trust.alive[band]!++;
  }
  const sociality = { alive: [0, 0, 0], total: [0, 0, 0] };
  for (const s of world.sims) {
    if (config.archetypes[s.archetype].sociality <= 0) continue;
    const band = s.sociality < bands[0]! ? 0 : s.sociality < bands[1]! ? 1 : 2;
    sociality.total[band]!++;
    if (s.condition === 'healthy') sociality.alive[band]!++;
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
    timeline,
    sociality,
    trust,
    cautionAsocial,
    roster,
    stages,
    fates,
    runLength: config.time.runLength,
  };
}
