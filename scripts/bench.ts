// Whole-run timing: the yardstick for "did this change make the simulation faster".
//
//   npx tsx scripts/bench.ts [--ticks 15000] [--runs 5] [--seed 1] [--map 1] [--population 6000]
//
// Runs the headless loop from fixed seeds for a fixed number of ticks, each run in a
// fresh process so every run pays the same JIT warm-up, one after another so they
// never compete for a core. Reports each run's wall time and the minimum: noise from
// a shared host only ever adds time, so the minimum is the best estimate of the cost
// and is far steadier than the mean. Setup (map generation) is timed separately.
//
// Playback needs a sustained rate through the busiest part of a run, not a good
// average, so the run is also timed in windows of 1,000 ticks. Each window takes its
// minimum across runs, and the slowest of those is reported as the peak.
//
// The harness owns the clock; nothing in sim/ reads it. Every run also prints a
// fingerprint of the final state, so two versions being compared can be confirmed to
// have simulated the same thing — a speed-up that changes behaviour is not a speed-up.
//
// Per-stage timing (scripts/profile.ts) is for finding where to look; this decides
// whether a change worked.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/tick';

interface Result {
  setupMs: number;
  runMs: number;
  /** Wall time of each consecutive window of WINDOW ticks. */
  windowMs: number[];
  fingerprint: string;
}

const WINDOW = 1000;

const args = process.argv.slice(2);
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const ticks = opt('ticks', 15000);
const runs = opt('runs', 5);
const runSeed = opt('seed', 1);
const mapSeed = opt('map', 1);
const population = opt('population', defaultScenario.population);

/** A cheap digest of the final state: counters plus a hash over every agent's position. */
function fingerprint(world: ReturnType<typeof createWorld>['world']): string {
  let h = 2166136261;
  const mix = (x: number) => {
    h ^= Math.round(x * 1000) | 0;
    h = Math.imul(h, 16777619);
  };
  for (const s of world.sims) {
    mix(s.x);
    mix(s.y);
  }
  for (const z of world.zombies) {
    mix(z.x);
    mix(z.y);
  }
  for (const b of world.buildings) mix(b.fortification * 1000 + b.materials);
  const c = world.counters;
  return `${Object.values(c.unturned).join('/')}|${Object.values(c.turned).join('/')}|${world.sims.length}|${(h >>> 0).toString(16)}`;
}

function once(): Result {
  const t0 = performance.now();
  const { world, ctx } = createWorld({ ...defaultScenario, runSeed, mapSeed, population, stalemateController: false }, config);
  const t1 = performance.now();
  const windowMs: number[] = [];
  let w = t1;
  while (world.tick < ticks) {
    step(world, ctx, { checkInvariant: false });
    if (world.tick % WINDOW === 0) {
      const now = performance.now();
      windowMs.push(now - w);
      w = now;
    }
  }
  const t2 = performance.now();
  return { setupMs: t1 - t0, runMs: t2 - t1, windowMs, fingerprint: fingerprint(world) };
}

if (args.includes('--once')) {
  const r = once();
  process.send!(r, undefined, undefined, () => process.exit(0));
} else {
  console.log(`bench: ${ticks} ticks, runSeed ${runSeed}, mapSeed ${mapSeed}, population ${population}, ${runs} runs`);
  const results: Result[] = [];
  for (let i = 0; i < runs; i++) {
    const r = await new Promise<Result>((resolve, reject) => {
      const child = fork(fileURLToPath(import.meta.url), [...args, '--once'], { execArgv: ['--import', 'tsx'] });
      child.once('message', (m: Result) => resolve(m));
      child.on('error', reject);
      child.on('exit', (code) => code !== 0 && reject(new Error(`run exited with ${code}`)));
    });
    results.push(r);
    console.log(`  run ${i + 1}: ${(r.runMs / 1000).toFixed(2)} s (${(r.runMs / ticks).toFixed(3)} ms/tick), setup ${r.setupMs.toFixed(0)} ms  ${r.fingerprint}`);
  }
  const min = Math.min(...results.map((r) => r.runMs));
  const max = Math.max(...results.map((r) => r.runMs));
  const same = results.every((r) => r.fingerprint === results[0]!.fingerprint);
  console.log(`min ${(min / 1000).toFixed(2)} s = ${(min / ticks).toFixed(3)} ms/tick (spread ${(((max - min) / min) * 100).toFixed(1)}%)${same ? '' : '  WARNING: runs disagree — nondeterminism'}`);
  const windows = results[0]!.windowMs.map((_, i) => Math.min(...results.map((r) => r.windowMs[i]!)));
  let peak = 0;
  for (let i = 1; i < windows.length; i++) if (windows[i]! > windows[peak]!) peak = i;
  if (windows.length > 0) {
    console.log(`peak window: ticks ${peak * WINDOW}–${(peak + 1) * WINDOW} at ${(windows[peak]! / WINDOW).toFixed(3)} ms/tick`);
    console.log(`windows (ms/tick, min across runs): ${windows.map((x) => (x / WINDOW).toFixed(1)).join(' ')}`);
  }
}
