// Judges promotion scoring rules offline. Names never change behaviour, so one
// sweep's record of every promotion stage's candidates (raw counters) and of how
// each candidate's run ended is enough to replay any scoring rule against it.
//
//   npx tsx scripts/sweep.ts --json pools.json      (records candidates and fates)
//   npx tsx scripts/roster-eval.ts pools.json
//
// For each rule: who would have been named at each stage (top 12, the final stage
// adding only the not-yet-named, as promotion does), how long they then lived,
// how many saw the end, which counter made them stand out, and the archetype mix.

import { readFileSync } from 'node:fs';
import { SCORED } from '../src/sim/systems/promotion';
import type { RunSummary } from './lib/run-one';

const file = process.argv[2];
if (!file) throw new Error('usage: roster-eval.ts <sweep --json output>');
const { results } = JSON.parse(readFileSync(file, 'utf8')) as { results: RunSummary[] };
const COUNT = 12;
const RATE_FLOOR = 1800;
const ACCUMULATING = new Set([1, 3, 4, 5, 6]); // conversions, near misses, kills, streets, materials
const STREETS = 5;

type Cand = RunSummary['stages'][number]['candidates'][number];
/** Per candidate, each counter's contribution to its score. */
type Rule = (pool: Cand[]) => number[][];

function columns(rows: number[][]): { mean: number[]; sd: number[] } {
  const k = rows[0]!.length;
  const mean = new Array<number>(k).fill(0);
  const sd = new Array<number>(k).fill(0);
  for (const r of rows) for (let i = 0; i < k; i++) mean[i]! += r[i]! / rows.length;
  for (const r of rows) for (let i = 0; i < k; i++) sd[i]! += (r[i]! - mean[i]!) ** 2 / rows.length;
  return { mean, sd: sd.map(Math.sqrt) };
}

function zRule(values: (c: Cand) => number[], cap = Infinity, drop: number[] = []): Rule {
  return (pool) => {
    const rows = pool.map(values);
    const { mean, sd } = columns(rows);
    return rows.map((r) => r.map((v, i) => (drop.includes(i) || sd[i] === 0 ? 0 : Math.min(cap, Math.abs(v - mean[i]!) / sd[i]!))));
  };
}

/** Distance from the median in percentile terms (0 at the median, 1 at either extreme): no counter can swamp the rest. */
function percentileRule(values: (c: Cand) => number[], drop: number[] = []): Rule {
  return (pool) => {
    const rows = pool.map(values);
    const k = rows[0]!.length;
    const out = rows.map(() => new Array<number>(k).fill(0));
    for (let i = 0; i < k; i++) {
      if (drop.includes(i)) continue;
      const order = rows.map((r, j) => ({ v: r[i]!, j })).sort((a, b) => a.v - b.v);
      // Average rank across ties, so a mass of zeros all sit at the same percentile.
      for (let s = 0; s < order.length; ) {
        let e = s;
        while (e + 1 < order.length && order[e + 1]!.v === order[s]!.v) e++;
        const p = (s + e) / 2 / Math.max(1, order.length - 1);
        for (let t = s; t <= e; t++) out[order[t]!.j]![i] = Math.abs(2 * p - 1);
        s = e + 1;
      }
    }
    return out;
  };
}

const totals = (c: Cand) => c.raw;
const rates = (c: Cand) => c.raw.map((v, i) => (ACCUMULATING.has(i) ? (v * 3600) / Math.max(c.raw[0]!, RATE_FLOOR) : v));

const RULES: [string, Rule, ((c: Cand) => boolean)?][] = [
  ['longest on record (for comparison)', (pool) => pool.map((c) => [c.raw[0]!, 0, 0, 0, 0, 0, 0, 0])],
  ['totals |z| (current)', zRule(totals)],
  ['rates |z|', zRule(rates)],
  ['totals |z| capped at 3', zRule(totals, 3)],
  ['totals |z| capped, no streets', zRule(totals, 3, [STREETS])],
  ['rates |z| capped, no streets', zRule(rates, 3, [STREETS])],
  ['percentile, totals, no streets', percentileRule(totals, [STREETS])],
  ['percentile, rates, no streets', percentileRule(rates, [STREETS])],
  ['rates capped, no streets, not bitten', zRule(rates, 3, [STREETS]), (c) => !c.infected],
];

interface Pick {
  stage: string;
  id: number;
  lived: number;
  alive: boolean;
  lead: string;
  archetype: string;
}

function evaluate(rule: Rule, eligible: (c: Cand) => boolean): Pick[] {
  const picks: Pick[] = [];
  for (const r of results) {
    const named = new Set<number>();
    for (const st of r.stages) {
      const pool = st.candidates.filter(eligible);
      if (pool.length === 0) continue;
      const contrib = rule(pool);
      const ranked = pool.map((c, j) => ({ c, parts: contrib[j]!, score: contrib[j]!.reduce((a, b) => a + b, 0) })).sort((a, b) => b.score - a.score || a.c.id - b.c.id);
      for (const e of ranked.slice(0, COUNT)) {
        if (named.has(e.c.id)) continue;
        named.add(e.c.id);
        const fate = r.fates[e.c.id]!;
        let lead = 0;
        for (let i = 1; i < e.parts.length; i++) if (e.parts[i]! > e.parts[lead]!) lead = i;
        picks.push({ stage: st.stage, id: e.c.id, lived: (fate.endedAt ?? r.runLength) - st.tick, alive: fate.condition === 'healthy', lead: SCORED[lead]!, archetype: e.c.archetype });
      }
    }
  }
  return picks;
}

const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(0)}%`.padStart(4);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
const top = (xs: string[], n: number) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${pct(v, xs.length).trim()}`).join(', ');
};

console.log(`${results.length} runs. Per rule: provisional / final — median ticks lived after naming, gone within 1,800, alive at the end; then what led, and who.`);

// Baseline: everyone who was a candidate at each stage, named or not. If they fare
// no better than the named, the scoring is not what is killing the roster.
{
  const part = (stage: string) => {
    const lived: number[] = [];
    let gone = 0, alive = 0;
    for (const r of results) {
      for (const st of r.stages.filter((x) => x.stage === stage)) {
        for (const c of st.candidates) {
          const f = r.fates[c.id]!;
          const l = (f.endedAt ?? r.runLength) - st.tick;
          lived.push(l);
          if (f.condition === 'healthy') alive++;
          else if (l < 1800) gone++;
        }
      }
    }
    return `${String(median(lived)).padStart(5)} ${pct(gone, lived.length)} ${pct(alive, lived.length)}  (pool ${lived.length})`;
  };
  console.log(`\neveryone who was a candidate (baseline)\n  provisional ${part('provisional')}   final ${part('final')}`);
}
for (const [name, rule, eligible] of RULES) {
  const picks = evaluate(rule, eligible ?? (() => true));
  const part = (stage: string) => {
    const p = picks.filter((x) => x.stage === stage);
    return `${String(median(p.map((x) => x.lived))).padStart(5)} ${pct(p.filter((x) => x.lived < 1800 && !x.alive).length, p.length)} ${pct(p.filter((x) => x.alive).length, p.length)}`;
  };
  console.log(`\n${name}\n  provisional ${part('provisional')}   final ${part('final')}   (${picks.length} named)`);
  console.log(`  led by: ${top(picks.map((x) => x.lead), 5)}`);
  console.log(`  archetypes: ${top(picks.map((x) => x.archetype), 5)}`);
}
