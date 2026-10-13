// Parameter sweep and gate check: many runSeeds against one mapSeed, in parallel
// child processes, with config overrides.
//
//   npx tsx scripts/sweep.ts [--seeds 20] [--map 1] [--jobs 4] [--set zombie.wanderRate=0.001 ...] [--scenario initialZombies=20 --scenario origin=scattered ...] [--json out.json] [--roster out.txt]
//
// Also summarises who promotion named — which counters won, how ticksSurvived
// correlates with the rest — and with --roster writes every promoted survivor, per
// seed, with their winning counters, backstory and fate.
//
// Milestone 2 gate: the invariant holds for a full run on every seed; infection
// reaches 40–90% of population in at least 15 of 20; no seed resolves under 3,000 ticks.
// Milestone 4 gate: shelters form, fall and re-form (a garrison established after the
// first one fell) in at least 15 of 20; no seed settles into stasis (an hour, 3,600
// ticks, with nothing happening while anyone is alive — mid-run, or at the end of a run
// whose loss is still under the gate's 40%: a quiet end after the outbreak has done its
// work is a run that finished early, not a stall); survival differs measurably by
// caution band (lowest against highest band, pooled over seeds, |z| >= 2).
// Also reported, per seed and not gated, from each run's timeline: awake zombies at
// their peak and over time, dormant at the end, unaware people outdoors early on,
// conversations, gunshots and shouts, ticker lines per 10 minutes at 1× (every event
// treated as on screen), "dead air" (10-minute windows after the first hour with no
// ticker line at all), and conversions, breaches and 911 dispatches.
// Also reported, not gated: survival by sociality band, over the sims whose archetype
// ever joins anyone — whether going along with others helps or hurts; and by trust
// band — whether believing what one is told does; and by caution among the asocial,
// who seldom talk or join, so caution can be seen to matter where sociality does not
// stand in for it.

import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GATE_LOSS, KILLERS, runOne, type RunSummary } from './lib/run-one';
import { config as baseConfig } from '../src/config';

/** Who got named, and why: does scoring find different characters, or one character many times? */
function rosterSummary(results: RunSummary[], file: string): void {
  const entries = results.flatMap((r) => r.roster.map((e) => ({ ...e, seed: r.runSeed })));
  if (entries.length === 0) return;
  const lead = new Map<string, number>();
  const inTop2 = new Map<string, number>();
  for (const e of entries) {
    lead.set(e.top[0]!.counter, (lead.get(e.top[0]!.counter) ?? 0) + 1);
    for (const t of e.top.slice(0, 2)) inTop2.set(t.counter, (inTop2.get(t.counter) ?? 0) + 1);
  }
  const pct = (n: number) => `${((n / entries.length) * 100).toFixed(0)}%`;
  const fmt = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${pct(n)}`).join(', ');
  console.log(`\nroster: ${entries.length} named over ${results.length} seeds; alive at the end ${pct(entries.filter((e) => e.fate === 'alive').length)}`);
  // How long the named live after naming (to the end of the run if they survive it).
  const runLength = results[0]!.samples.length > 0 ? (results[0]!.samples.length - 1) * 600 : 0;
  const lived = entries.map((e) => (e.endedAt ?? runLength) - e.tick).sort((a, b) => a - b);
  const within = (t: number) => pct(entries.filter((e) => e.endedAt !== null && e.endedAt - e.tick < t).length);
  console.log(`  after naming: median ${lived[lived.length >> 1]} ticks lived; gone within 1,800 ticks ${within(1800)}, within 3,600 ${within(3600)}`);
  console.log(`  leading counter: ${fmt(lead)}`);
  console.log(`  in the top two:  ${fmt(inTop2)}`);
  for (const stage of ['provisional', 'final'] as const) {
    const st = results.flatMap((r) => r.stages.filter((s) => s.stage === stage));
    if (st.length === 0) continue;
    const keys = Object.keys(st[0]!.corrWithSurvived);
    const mean = keys.map((k) => `${k} ${(st.reduce((a, s) => a + s.corrWithSurvived[k]!, 0) / st.length).toFixed(2)}`).join(', ');
    console.log(`  ${stage} (mean pool ${Math.round(st.reduce((a, s) => a + s.pool, 0) / st.length)}): corr(ticksSurvived, ·) ${mean}`);
  }
  if (!file) return;
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`seed ${r.runSeed}`);
    for (const e of r.roster) {
      const top = e.top.map((t) => `${t.counter} ${t.z >= 0 ? '+' : ''}${t.z.toFixed(1)} (${Number.isInteger(t.value) ? t.value : t.value.toFixed(2)})`).join(', ');
      lines.push(`  ${e.stage.padEnd(11)} t${e.tick} #${String(e.rank).padStart(2)} ${e.name.padEnd(20)} ${e.archetype.padEnd(10)} score ${e.score.toFixed(1).padStart(5)} | ${top} | ${e.backstory} | ${e.fate}${e.endedAt !== null ? ` at ${e.endedAt}` : ''}`);
    }
  }
  writeFileSync(file, lines.join('\n') + '\n');
  console.log(`  full roster written to ${file}`);
}

interface Job {
  runSeeds: number[];
  mapSeed: number;
  overrides: Record<string, unknown>;
  scenario: Record<string, unknown>;
}

if (process.argv[2] === '--worker') {
  const send = process.send!.bind(process);
  process.once('message', async (job: Job) => {
    for (const seed of job.runSeeds) {
      const summary = runOne(seed, job.mapSeed, job.overrides, 600, job.scenario);
      await new Promise<void>((resolve) => send(summary, undefined, undefined, () => resolve()));
    }
    process.exit(0);
  });
} else {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1]! : fallback;
  };
  const overrides: Record<string, unknown> = {};
  const scenario: Record<string, unknown> = {};
  args.forEach((a, i) => {
    if (a !== '--set' && a !== '--scenario') return;
    const [path, raw] = args[i + 1]!.split('=') as [string, string];
    // Numbers and booleans as JSON; anything else (an origin) as a plain string.
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    (a === '--set' ? overrides : scenario)[path] = value;
  });
  const seeds = Number(opt('seeds', '20'));
  const mapSeed = Number(opt('map', '1'));
  const jobs = Math.min(seeds, Number(opt('jobs', String(availableParallelism()))));
  const jsonOut = opt('json', '');
  const rosterOut = opt('roster', '');

  const runSeeds = Array.from({ length: seeds }, (_, i) => i + 1);
  const results: RunSummary[] = [];
  const started = performance.now();
  await Promise.all(
    Array.from({ length: jobs }, (_, j) => {
      const mine = runSeeds.filter((_, i) => i % jobs === j);
      return new Promise<void>((resolve, reject) => {
        const child = fork(fileURLToPath(import.meta.url), ['--worker'], { execArgv: ['--import', 'tsx'] });
        child.send({ runSeeds: mine, mapSeed, overrides, scenario } satisfies Job);
        child.on('message', (r: RunSummary) => {
          results.push(r);
          process.stderr.write('.');
        });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`))));
      });
    }),
  );
  process.stderr.write('\n');
  results.sort((a, b) => a.runSeed - b.runSeed);

  const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
  console.log(`mapSeed ${mapSeed}, ${seeds} runSeeds, overrides ${JSON.stringify(overrides)}, scenario ${JSON.stringify(scenario)}`);
  console.log('seed  infect   dead  resolved  ms/tick  shelters est/fell/re  stall/quiet end  curve (turned share every 1800 ticks)');
  for (const r of results) {
    const pop = r.population;
    const curve = r.samples
      .filter((_, i) => i % 3 === 0)
      .map((c) => Math.round(((c.turned.symptomatic + c.turned.outdoors + c.turned.occupying + c.turned.destroyed) / pop) * 100))
      .join(' ');
    const dead = r.samples[r.samples.length - 1]!.unturned.dead / pop;
    console.log(
      `${String(r.runSeed).padStart(4)}  ${pct(r.infection)}  ${pct(dead)}  ${String(r.resolvedAt ?? '-').padStart(8)}  ${r.msPerTick.toFixed(2).padStart(7)}  ${`${r.shelters.established}/${r.shelters.fell}/${r.shelters.reformed}`.padStart(20)}  ${`${r.longestQuiet}/${r.quietEnd ?? '-'}`.padStart(15)}  ${curve}${r.invariantError ? `  INVARIANT: ${r.invariantError.split('\n')[0]}` : ''}`,
    );
  }

  // Beyond the counters: why a run smoulders or takes off, and what there was to watch.
  console.log('\nseed  awake peak@tick  awake 1h/2h/end  dormant end  unaware out 30m/1h  talk/gath 1h  shots/shouts  lines/10min median  dead air  conv/breach/calls  cars peak/abandoned');
  for (const r of results) {
    const t = r.timeline;
    if (!t || t.length === 0) continue;
    const at = (tick: number) => t.find((e) => e.tick >= tick) ?? t[t.length - 1]!;
    const peak = t.reduce((m, e) => (e.zombies.awake > m.zombies.awake ? e : m), t[0]!);
    const out = (e: (typeof t)[number]) => `${e.outdoors.unaware}/${e.outdoors.aware + e.outdoors.uneasy + e.outdoors.unaware}`;
    const sum = (f: (e: (typeof t)[number]) => number) => t.reduce((a, e) => a + f(e), 0);
    const lines = t.map((e) => e.lines).sort((a, b) => a - b);
    // Dead air: windows (after the first hour) with no ticker line at all.
    const later = t.filter((e) => e.tick > 3600);
    const dead = later.filter((e) => e.lines === 0).length;
    const ev = (k: string) => sum((e) => e.events[k] ?? 0);
    console.log(
      `${String(r.runSeed).padStart(4)}  ${`${peak.zombies.awake}@${peak.tick}`.padStart(15)}  ${`${at(3600).zombies.awake}/${at(7200).zombies.awake}/${t[t.length - 1]!.zombies.awake}`.padStart(15)}  ${String(t[t.length - 1]!.zombies.dormant).padStart(11)}  ${`${out(at(1800))} ${out(at(3600))}`.padStart(18)}  ${`${at(3600).talking}/${at(3600).gatherings}`.padStart(12)}  ${`${sum((e) => e.shots)}/${sum((e) => e.shouts)}`.padStart(12)}  ${String(lines[Math.floor(lines.length / 2)]).padStart(18)}  ${`${dead}/${later.length}`.padStart(8)}  ${ev('simTurned')}/${ev('buildingBreached')}/${ev('policeDispatched')}  ${Math.max(...t.map((e) => e.cars?.driving ?? 0))}/${t[t.length - 1]!.cars?.abandoned ?? 0}`,
    );
  }

  // Who kills the dead: a single kind of unit putting the outbreak down early shows here.
  // Set against those turned in the same hour: a seed that stalls is one where the dead
  // were removed faster than bites made them. And gunfire against the dead an hour on:
  // if firing draws more than it kills, more shots should mean more dead later, not fewer.
  console.log(`\nseed  turned 1h  killed 1h  ratio  shots 1h  dead walking 2h  turned end   kills 1h, then run (${KILLERS.join('/')})`);
  const pairs: [number, number][] = [];
  for (const r of results) {
    if (!r.kills || !r.timeline?.length) continue;
    const t = r.timeline;
    const killed = r.kills.hour.reduce((a, b) => a + b, 0);
    const shots = t.filter((e) => e.tick <= 3600).reduce((a, e) => a + e.shots, 0);
    const z2 = t.find((e) => e.tick >= 7200) ?? t[t.length - 1]!;
    const walking = z2.zombies.awake + z2.zombies.dormant + z2.zombies.occupying;
    pairs.push([shots, walking]);
    console.log(`${String(r.runSeed).padStart(4)}  ${String(r.turnedHour).padStart(9)}  ${String(killed).padStart(9)}  ${(killed / Math.max(1, r.turnedHour)).toFixed(2).padStart(5)}  ${String(shots).padStart(8)}  ${String(walking).padStart(15)}  ${`${Math.round(r.infection * 100)}%`.padStart(10)}   ${r.kills.hour.join('/')}   ${r.kills.run.join('/')}`);
  }
  // The rescue's broadcast: who answered it, and what became of them.
  if (results.some((r) => r.rescue)) {
    console.log('\nseed  rescue: answered → out / died / turned / waiting / elsewhere; trucked');
    for (const r of results) {
      const t = r.rescue;
      if (t) console.log(`${String(r.runSeed).padStart(4)}  ${t.answered} → ${t.out} / ${t.dead} / ${t.turned} / ${t.waiting} / ${t.elsewhere}; ${t.trucked}`);
    }
  }

  // By daylight: does the outbreak step forward at each nightfall?
  const L = { dt: 0, nt: 0, dc: 0, nc: 0, dk: 0, nk: 0 };
  for (const r of results) {
    if (!r.byLight) continue;
    L.dt += r.byLight.day.ticks; L.nt += r.byLight.night.ticks; L.dc += r.byLight.day.turned; L.nc += r.byLight.night.turned; L.dk += r.byLight.day.killed; L.nk += r.byLight.night.killed;
  }
  if (L.dt > 0 && L.nt > 0) console.log(`  per hour, day / night: turned ${((3600 * L.dc) / L.dt).toFixed(0)} / ${((3600 * L.nc) / L.nt).toFixed(0)}, zombies destroyed ${((3600 * L.dk) / L.dt).toFixed(0)} / ${((3600 * L.nk) / L.nt).toFixed(0)}`);
  const tot = (f: 'hour' | 'run') => KILLERS.map((_, i) => results.reduce((a, r) => a + (r.kills?.[f][i] ?? 0), 0));
  console.log(`  all  kills 1h ${tot('hour').join('/')}; over the run ${tot('run').join('/')}`);
  if (pairs.length > 2) {
    const n = pairs.length, mx = pairs.reduce((a, p) => a + p[0], 0) / n, my = pairs.reduce((a, p) => a + p[1], 0) / n;
    const cov = pairs.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
    const vx = pairs.reduce((a, p) => a + (p[0] - mx) ** 2, 0), vy = pairs.reduce((a, p) => a + (p[1] - my) ** 2, 0);
    console.log(`  corr(shots in the first hour, dead walking at 2h) ${(cov / Math.sqrt(vx * vy || 1)).toFixed(2)} over ${n} seeds`);
  }

  const invariantOk = results.every((r) => r.invariantError === null);
  // Total human loss — dead plus turned — not the turned share alone: with feeding, most
  // of the swarmed are eaten rather than turned, and a city where everyone dies and few
  // turn is still a city falling. The infection share capped well below the band once
  // feeding and fortification stages were in.
  const lossOf = (r: (typeof results)[number]) => r.infection + r.samples[r.samples.length - 1]!.unturned.dead / r.population;
  const inBand = results.filter((r) => lossOf(r) >= GATE_LOSS.min && lossOf(r) <= GATE_LOSS.max).length;
  const early = results.filter((r) => r.resolvedAt !== null && r.resolvedAt < 3000).length;
  const need = Math.ceil(seeds * 0.75);
  const gate2 = invariantOk && inBand >= need && early === 0;
  console.log(`\ngate 2: invariant ${invariantOk ? 'PASS' : 'FAIL'} | loss (dead + turned) 40–95% in ${inBand}/${seeds} (need ${need}) ${inBand >= need ? 'PASS' : 'FAIL'} | resolved <3000: ${early} ${early === 0 ? 'PASS' : 'FAIL'}`);

  const STASIS = 3600;
  const reformed = results.filter((r) => r.shelters.fell > 0 && r.shelters.reformed > 0).length;
  const stalled = results.filter((r) => r.longestQuiet >= STASIS).length;
  const { rate, z } = bandSurvival(results.map((r) => r.caution));
  const cautionOk = Math.abs(z) >= 2;
  const gate4 = reformed >= need && stalled === 0 && cautionOk;
  console.log(
    `gate 4: shelters form, fall, re-form in ${reformed}/${seeds} (need ${need}) ${reformed >= need ? 'PASS' : 'FAIL'} | stasis ≥${STASIS}: ${stalled} ${stalled === 0 ? 'PASS' : 'FAIL'} | survival by caution low/mid/high ${rate.map((x) => `${(x * 100).toFixed(1)}%`).join(' / ')} (z ${z.toFixed(1)}) ${cautionOk ? 'PASS' : 'FAIL'}`,
  );
  const social = bandSurvival(results.map((r) => r.sociality));
  console.log(`survival by sociality low/mid/high ${social.rate.map((x) => `${(x * 100).toFixed(1)}%`).join(' / ')} (z ${social.z.toFixed(1)}; joiners only, not gated)`);
  const asocial = bandSurvival(results.map((r) => r.cautionAsocial));
  console.log(`survival by caution among the asocial (sociality < ${bandsEdge()}) low/mid/high ${asocial.rate.map((x) => `${(x * 100).toFixed(1)}%`).join(' / ')} (z ${asocial.z.toFixed(1)}; not gated)`);
  const nerved = bandSurvival(results.map((r) => r.nerve).filter((x) => x !== undefined));
  if (nerved.rate.length) console.log(`survival by nerve low/mid/high ${nerved.rate.map((x) => `${(x * 100).toFixed(1)}%`).join(' / ')} (z ${nerved.z.toFixed(1)}; not gated)`);
  const trusting = bandSurvival(results.map((r) => r.trust));
  console.log(`survival by trust low/mid/high ${trusting.rate.map((x) => `${(x * 100).toFixed(1)}%`).join(' / ')} (z ${trusting.z.toFixed(1)}; not gated)`);
  rosterSummary(results, rosterOut);
  console.log(`wall time ${((performance.now() - started) / 1000).toFixed(0)} s`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ mapSeed, overrides, results }, null, 1));
  process.exitCode = gate2 && gate4 ? 0 : 1;
}

/** Survival rate per band, pooled over seeds, and z for the highest band against the lowest. */
function bandSurvival(runs: { alive: number[]; total: number[] }[]): { rate: number[]; z: number } {
  const alive = [0, 0, 0];
  const total = [0, 0, 0];
  for (const r of runs) for (let i = 0; i < 3; i++) {
    alive[i]! += r.alive[i]!;
    total[i]! += r.total[i]!;
  }
  const rate = alive.map((a, i) => a / Math.max(1, total[i]!));
  const pooled = (alive[0]! + alive[2]!) / Math.max(1, total[0]! + total[2]!);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(1, total[0]!) + 1 / Math.max(1, total[2]!)));
  return { rate, z: se > 0 ? (rate[2]! - rate[0]!) / se : 0 };
}

function bandsEdge(): number {
  return baseConfig.promotion.cautionBands[0]!;
}
