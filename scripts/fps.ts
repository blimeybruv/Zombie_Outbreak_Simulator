// Measures the renderer gate: 2,000 agents hold 30 fps at 8×.
//
//   npx tsx scripts/fps.ts [--advance 3500] [--seconds 20] [--scale 0.55] [--headed]
//
// Serves the viewer, fast-forwards to the busiest stretch of a run (most agents on
// the map), plays at 8× at mid zoom and records every animation frame's interval in
// the page, plus the main thread's draw time and the tick rate the worker achieved.
// Run it on the machine that matters: inside a container with software rendering
// and a shared CPU, the number says little about a real browser.

import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const advance = Number(opt('advance', '3500'));
const seconds = Number(opt('seconds', '20'));
const scale = Number(opt('scale', '0.55'));
const headed = args.includes('--headed');
const chrome = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

interface Hook {
  stats: { frames: number; drawMs: number; tick: number };
  camera: { scale: number; version: number; centreOn(x: number, y: number): void };
  controls: { setSpeed(s: number): void; toggle(): void };
  ready(): boolean;
}
type Win = { __view?: Hook; __fps?: { intervals: number[]; agents: number[] } };

const server = await createServer({ server: { port: 5198, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ? chrome : headed ? undefined : chrome, headless: !headed });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  // tsx keeps function names with a helper that serialised callbacks carry into the page.
  await page.addInitScript('window.__name = (f) => f');
  await page.goto(`http://localhost:5198/?advance=${advance}`);
  await page.waitForFunction(() => (window as unknown as Win).__view?.ready() ?? false, null, { timeout: 900_000 });
  const start = await page.evaluate((s) => {
    const v = (window as unknown as Win).__view!;
    v.camera.scale = s;
    v.camera.centreOn(1600, 1600);
    v.controls.setSpeed(8);
    v.controls.toggle();
    const w = window as unknown as Win;
    w.__fps = { intervals: [], agents: [] };
    let last = performance.now();
    const tickFrame = (now: number) => {
      w.__fps!.intervals.push(now - last);
      last = now;
      requestAnimationFrame(tickFrame);
    };
    requestAnimationFrame(tickFrame);
    return { tick: v.stats.tick, drawMs: v.stats.drawMs, frames: v.stats.frames };
  }, scale);
  const t0 = Date.now();
  await page.waitForTimeout(seconds * 1000);
  const end = await page.evaluate(() => {
    const v = (window as unknown as Win).__view!;
    return { tick: v.stats.tick, drawMs: v.stats.drawMs, frames: v.stats.frames, intervals: (window as unknown as Win).__fps!.intervals };
  });
  const wall = (Date.now() - t0) / 1000;
  const iv = end.intervals.slice(5).sort((a, b) => a - b);
  const fps = iv.length / (iv.reduce((a, b) => a + b, 0) / 1000);
  const p95 = iv[Math.floor(iv.length * 0.95)]!;
  const drawPerFrame = (end.drawMs - start.drawMs) / Math.max(1, end.frames - start.frames);
  const ticksPerSecond = (end.tick - start.tick) / wall;
  console.log(`8× at ${scale} px/m from tick ${start.tick}: ${fps.toFixed(1)} fps (p95 frame ${p95.toFixed(1)} ms), draw ${drawPerFrame.toFixed(2)} ms/frame, simulation ${ticksPerSecond.toFixed(0)} ticks/s of 80`);
  console.log(fps >= 30 && ticksPerSecond >= 76 ? 'gate: PASS' : 'gate: FAIL (on this machine)');
} finally {
  await browser.close();
  await server.close();
}
