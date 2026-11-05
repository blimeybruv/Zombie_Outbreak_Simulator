// The frame check: where frame time goes, and what drags the frame rate down when it
// dips. Plays the viewer at each speed in turn and reads back, for every frame interval,
// the main thread's own work by phase (src/ui/frame-timing.ts), the worker's time behind
// each snapshot (protocol.ts WorkerPerf), and garbage collection from a Chrome trace. A
// slow interval is put down to whichever took most of it: a phase of ours, collection,
// or the browser's own (what none of those account for — compositing, presenting, or a
// throttled display).
//
//   npx tsx scripts/frame-check.ts [--run 1] [--advance 3500] [--speeds 1,4,8] [--seconds 8] [--scale 0.55] [--director] [--headed]
//
// Run it on the machine that matters (--headed uses the installed Chrome): in a
// container with software rendering and a shared CPU, the browser's share is inflated.

import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import type { FrameTime, Phase } from '../src/ui/frame-timing';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const speeds = opt('speeds', '1,4,8').split(',').map(Number);
const seconds = Number(opt('seconds', '8'));
const scale = Number(opt('scale', '0.55'));
const headed = args.includes('--headed');
const chrome = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/** A frame interval over this is slow (ms): two frames missed at 60 Hz. */
const SLOW = 33.4;

interface Hook {
  stats: { tick: number };
  camera: { scale: number; version: number };
  controls: { setSpeed(s: number): void; toggle(): void };
  centreOnBusiest(): void;
  director?: { enable(on: boolean): void };
  timing: { frames: FrameTime[] };
  ready(): boolean;
}
type Win = { __view?: Hook };
interface TraceEvent { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: { name?: string } }

const server = await createServer({ server: { port: 5197, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: headed ? undefined : chrome, headless: !headed, args: headed ? [] : ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const pct = (xs: number[], p: number) => (xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!);
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.addInitScript('window.__name = (f) => f');
  await page.goto(`http://localhost:5197/?start=1&run=${opt('run', '1')}&map=1&advance=${opt('advance', '3500')}&fps`);
  await page.waitForFunction(() => (window as unknown as Win).__view?.ready() ?? false, null, { timeout: 600_000 });
  await page.evaluate(
    ({ sc, d }) => {
      const v = (window as unknown as Win).__view!;
      v.camera.scale = sc;
      v.camera.version++;
      if (d && v.director) v.director.enable(true);
      else v.centreOnBusiest();
      v.controls.toggle(); // play
    },
    { sc: scale, d: args.includes('--director') },
  );
  console.log(`run ${opt('run', '1')}, from tick ${opt('advance', '3500')}, ${scale} px/m${args.includes('--director') ? ', director on' : ''}, ${headed ? 'headed' : 'headless (software rendering)'}; a slow interval is over ${SLOW} ms\n`);

  for (const speed of speeds) {
    await page.evaluate((s) => (window as unknown as Win).__view!.controls.setSpeed(s), speed);
    await page.waitForTimeout(1000); // settle at the new speed
    await browser.startTracing(page, { categories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc', 'blink.user_timing'] });
    const t0 = await page.evaluate(() => {
      performance.mark('frame-check');
      return { now: performance.now(), tick: (window as unknown as Win).__view!.stats.tick, frames: (window as unknown as Win).__view!.timing.frames.length };
    });
    await page.waitForTimeout(seconds * 1000);
    const end = await page.evaluate((from) => {
      const v = (window as unknown as Win).__view!;
      return { tick: v.stats.tick, frames: v.timing.frames.slice(-Math.max(0, v.timing.frames.length - from.frames + 0)).filter((f) => f.at > from.now) };
    }, t0);
    const trace = JSON.parse((await browser.stopTracing()).toString()) as { traceEvents: TraceEvent[] };
    report(speed, t0, end, trace.traceEvents);
  }
} finally {
  await browser.close();
  await server.close();
}

function report(speed: number, t0: { now: number; tick: number }, end: { tick: number; frames: FrameTime[] }, events: TraceEvent[]): void {
  const frames = end.frames;
  if (frames.length === 0) return console.log(`${speed}×: no frames`);
  // Align trace time (µs) to the page's clock by the mark set at the start.
  const mark = events.find((e) => e.name === 'frame-check' && (e.ph === 'R' || e.ph === 'I' || e.ph === 'n' || e.ph === 'b'));
  const threads = new Map<string, string>();
  for (const e of events) if (e.name === 'thread_name' && e.args?.name) threads.set(`${e.pid}:${e.tid}`, e.args.name);
  const main = mark ? `${mark.pid}:${mark.tid}` : [...threads.entries()].find(([, n]) => n === 'CrRendererMain')?.[0];
  const toPage = (ts: number) => (mark ? t0.now + (ts - mark.ts) / 1000 : NaN);
  const gcs = events
    .filter((e) => e.ph === 'X' && /GC|Scavenge|MarkCompact|Sweep/i.test(e.name) && /^(MinorGC|MajorGC|V8\.GC_SCAVENGER|V8\.GC_MARK_COMPACTOR|V8\.GCScavenger|V8\.GCFinalizeMC|V8\.GCIncrementalMarking)$/.test(e.name))
    .map((e) => ({ thread: `${e.pid}:${e.tid}`, start: toPage(e.ts), ms: (e.dur ?? 0) / 1000 }));
  const mainGc = gcs.filter((g) => g.thread === main);
  const workerGc = gcs.filter((g) => g.thread !== main && /Worker/i.test(threads.get(g.thread) ?? ''));
  const gcIn = (f: FrameTime) => mainGc.filter((g) => g.start >= f.at - f.gap && g.start < f.at).reduce((a, g) => a + g.ms, 0);

  const gaps = frames.map((f) => f.gap);
  const span = gaps.reduce((a, b) => a + b, 0) / 1000;
  const ticks = end.tick - t0.tick;
  const phases = Object.keys(frames[0]!.ms) as Phase[];
  const work = (f: FrameTime) => phases.reduce((a, p) => a + f.ms[p], 0);
  const slow = frames.filter((f) => f.gap > SLOW);
  const blame: Record<string, number> = {};
  for (const f of slow) {
    const parts: [string, number][] = [...phases.map((p) => [p, f.ms[p]] as [string, number]), ['GC', gcIn(f)]];
    parts.push(['browser', Math.max(0, f.gap - work(f) - gcIn(f))]);
    const top = parts.reduce((m, p) => (p[1] > m[1] ? p : m));
    blame[top[0]] = (blame[top[0]] ?? 0) + 1;
  }
  const snaps = frames.filter((f) => f.worker !== null).map((f) => f.worker!);
  console.log(`${speed}×  ${(frames.length / span).toFixed(0)} fps over ${span.toFixed(1)} s (median gap ${pct(gaps, 0.5).toFixed(1)} ms, p95 ${pct(gaps, 0.95).toFixed(0)}, worst ${Math.max(...gaps).toFixed(0)}); sim ${(ticks / span).toFixed(0)} ticks/s of ${speed * 10}; agents ~${frames[frames.length - 1]!.agents}`);
  console.log(`    slow intervals ${slow.length} of ${frames.length} (${((slow.length / frames.length) * 100).toFixed(0)}%), put down to: ${Object.entries(blame).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || '—'}`);
  console.log(`    main thread per interval, mean / p95 / worst ms: ${phases.map((p) => ({ p, xs: frames.map((f) => f.ms[p]) })).filter(({ xs }) => Math.max(...xs) >= 0.5).map(({ p, xs }) => `${p} ${mean(xs).toFixed(1)}/${pct(xs, 0.95).toFixed(1)}/${Math.max(...xs).toFixed(0)}`).join(' · ')}`);
  const layerNames = [...new Set(frames.flatMap((f) => Object.keys(f.layers)))];
  const layerStats = layerNames.map((l) => ({ l, xs: frames.map((f) => f.layers[l] ?? 0) })).sort((a, b) => mean(b.xs) - mean(a.xs));
  console.log(`    draw by layer, mean / p95 ms: ${layerStats.filter(({ xs }) => mean(xs) >= 0.2).map(({ l, xs }) => `${l} ${mean(xs).toFixed(1)}/${pct(xs, 0.95).toFixed(1)}`).join(' · ')}`);
  console.log(`    GC on the main thread ${mainGc.reduce((a, g) => a + g.ms, 0).toFixed(0)} ms in ${mainGc.length} pauses (worst ${Math.max(0, ...mainGc.map((g) => g.ms)).toFixed(0)}); in the worker ${workerGc.reduce((a, g) => a + g.ms, 0).toFixed(0)} ms in ${workerGc.length}${mark ? '' : ' (no mark in the trace: GC not lined up with frames)'}`);
  if (snaps.length > 0) {
    const perStep = snaps.filter((s) => s.steps > 0).map((s) => s.stepMs / s.steps);
    console.log(`    worker per snapshot: ${mean(snaps.map((s) => s.steps)).toFixed(1)} ticks, step mean ${mean(perStep).toFixed(1)} ms (worst ${Math.max(0, ...snaps.map((s) => s.worstStepMs)).toFixed(0)}), collect ${mean(snaps.map((s) => s.collectMs)).toFixed(1)} ms, snapshot ${mean(snaps.map((s) => s.snapshotMs)).toFixed(1)} ms; ${(frames.filter((f) => f.snapshots === 0).length / frames.length * 100).toFixed(0)}% of intervals got no new snapshot`);
  }
  const worst = [...slow].sort((a, b) => b.gap - a.gap).slice(0, 3);
  for (const f of worst) {
    const parts = phases.filter((p) => f.ms[p] >= 1).map((p) => (p === 'draw' ? `draw ${f.ms[p].toFixed(0)} (${Object.entries(f.layers).filter(([, ms]) => ms >= 1).sort((a, b) => b[1] - a[1]).map(([l, ms]) => `${l} ${ms.toFixed(0)}`).join(' ')})` : `${p} ${f.ms[p].toFixed(0)}`));
    const gc = gcIn(f);
    console.log(`    worst: ${f.gap.toFixed(0)} ms — ${[...parts, gc >= 1 ? `GC ${gc.toFixed(0)}` : '', `browser ${Math.max(0, f.gap - work(f) - gc).toFixed(0)}`].filter(Boolean).join(', ')}${f.worker ? `; worker ${f.worker.steps} ticks, worst ${f.worker.worstStepMs.toFixed(0)} ms` : ''}`);
  }
  console.log('');
}
