// Parameter sweep and gate check: many runSeeds against one mapSeed, in parallel
// child processes, with config overrides.
//
//   npx tsx scripts/sweep.ts [--seeds 20] [--map 1] [--jobs 4] [--set zombie.wanderRate=0.001 ...] [--json out.json]
//
// Milestone 2 gate: the invariant holds for a full run on every seed; infection
// reaches 40–90% of population in at least 15 of 20; no seed resolves under 3,000 ticks.
// Milestone 4 gate: shelters form, fall and re-form (a garrison established after the
// first one fell) in at least 15 of 20; no seed settles into stasis (an hour, 3,600
// ticks, with nothing happening while anyone is alive); survival differs measurably by
// caution band (lowest against highest band, pooled over seeds, |z| >= 2).

import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runOne, type RunSummary } from './lib/run-one';

interface Job {
  runSeeds: number[];
  mapSeed: number;
  overrides: Record<string, unknown>;
}

if (process.argv[2] === '--worker') {
  const send = process.send!.bind(process);
  process.once('message', async (job: Job) => {
    for (const seed of job.runSeeds) {
      const summary = runOne(seed, job.mapSeed, job.overrides);
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
  args.forEach((a, i) => {
    if (a !== '--set') return;
    const [path, raw] = args[i + 1]!.split('=') as [string, string];
    overrides[path] = JSON.parse(raw);
  });
  const seeds = Number(opt('seeds', '20'));
  const mapSeed = Number(opt('map', '1'));
  const jobs = Math.min(seeds, Number(opt('jobs', String(availableParallelism()))));
  const jsonOut = opt('json', '');

  const runSeeds = Array.from({ length: seeds }, (_, i) => i + 1);
  const results: RunSummary[] = [];
  const started = performance.now();
  await Promise.all(
    Array.from({ length: jobs }, (_, j) => {
      const mine = runSeeds.filter((_, i) => i % jobs === j);
      return new Promise<void>((resolve, reject) => {
        const child = fork(fileURLToPath(import.meta.url), ['--worker'], { execArgv: ['--import', 'tsx'] });
        child.send({ runSeeds: mine, mapSeed, overrides } satisfies Job);
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
  console.log(`mapSeed ${mapSeed}, ${seeds} runSeeds, overrides ${JSON.stringify(overrides)}`);
  console.log('seed  infect   dead  resolved  ms/tick  shelters est/fell/re  quiet  curve (turned share every 1800 ticks)');
  for (const r of results) {
    const pop = r.population;
    const curve = r.samples
      .filter((_, i) => i % 3 === 0)
      .map((c) => Math.round(((c.turned.symptomatic + c.turned.outdoors + c.turned.occupying + c.turned.destroyed) / pop) * 100))
      .join(' ');
    const dead = r.samples[r.samples.length - 1]!.unturned.dead / pop;
    console.log(
      `${String(r.runSeed).padStart(4)}  ${pct(r.infection)}  ${pct(dead)}  ${String(r.resolvedAt ?? '-').padStart(8)}  ${r.msPerTick.toFixed(2).padStart(7)}  ${`${r.shelters.established}/${r.shelters.fell}/${r.shelters.reformed}`.padStart(20)}  ${String(r.longestQuiet).padStart(5)}  ${curve}${r.invariantError ? `  INVARIANT: ${r.invariantError.split('\n')[0]}` : ''}`,
    );
  }

  const invariantOk = results.every((r) => r.invariantError === null);
  const inBand = results.filter((r) => r.infection >= 0.4 && r.infection <= 0.9).length;
  const early = results.filter((r) => r.resolvedAt !== null && r.resolvedAt < 3000).length;
  const need = Math.ceil(seeds * 0.75);
  const gate2 = invariantOk && inBand >= need && early === 0;
  console.log(`\ngate 2: invariant ${invariantOk ? 'PASS' : 'FAIL'} | infection 40–90% in ${inBand}/${seeds} (need ${need}) ${inBand >= need ? 'PASS' : 'FAIL'} | resolved <3000: ${early} ${early === 0 ? 'PASS' : 'FAIL'}`);

  const STASIS = 3600;
  const reformed = results.filter((r) => r.shelters.fell > 0 && r.shelters.reformed > 0).length;
  const stalled = results.filter((r) => r.longestQuiet >= STASIS).length;
  const alive = [0, 0, 0];
  const total = [0, 0, 0];
  for (const r of results) for (let i = 0; i < 3; i++) {
    alive[i]! += r.caution.alive[i]!;
    total[i]! += r.caution.total[i]!;
  }
  const rate = alive.map((a, i) => a / Math.max(1, total[i]!));
  const pooled = (alive[0]! + alive[2]!) / Math.max(1, total[0]! + total[2]!);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(1, total[0]!) + 1 / Math.max(1, total[2]!)));
  const z = se > 0 ? (rate[2]! - rate[0]!) / se : 0;
  const cautionOk = Math.abs(z) >= 2;
  const gate4 = reformed >= need && stalled === 0 && cautionOk;
  console.log(
    `gate 4: shelters form, fall, re-form in ${reformed}/${seeds} (need ${need}) ${reformed >= need ? 'PASS' : 'FAIL'} | stasis ≥${STASIS}: ${stalled} ${stalled === 0 ? 'PASS' : 'FAIL'} | survival by caution low/mid/high ${rate.map((x) => `${(x * 100).toFixed(1)}%`).join(' / ')} (z ${z.toFixed(1)}) ${cautionOk ? 'PASS' : 'FAIL'}`,
  );
  console.log(`wall time ${((performance.now() - started) / 1000).toFixed(0)} s`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ mapSeed, overrides, results }, null, 1));
  process.exitCode = gate2 && gate4 ? 0 : 1;
}
