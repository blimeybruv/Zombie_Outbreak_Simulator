// The observation check: watch the viewer as a spectator would — playing, the camera on
// where things are happening — and keep what was on screen, for a reviewer (the user, or
// Claude) to look at and say what could be better. The oddity check finds what is wrong
// in the simulation; this keeps what the viewer actually saw.
//
//   npx tsx scripts/observe.ts [--run 1] [--map 1] [--advance 3600] [--play 4] [--frames 8] [--every 6] [--scale 1.6] [--out dir] [--director]
//
// Fast-forwards to --advance, plays at --play×, and every --every seconds of real time
// takes a frame: centred on the busiest place on screen (or, with --director, wherever
// the viewer's director has put the camera), at --scale px/m. Writes the frames and
// observe.json beside them: for each frame the tick, the camera, the frame counter and
// the ticker's lines on screen, so a review can say what was showing and what was said.

import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const out = opt('out', 'observe-shots');
const frames = Number(opt('frames', '8'));
const every = Number(opt('every', '6'));
const speed = Number(opt('play', '4'));
const scale = Number(opt('scale', '1.6'));
const director = args.includes('--director');

interface ViewHook {
  stats: { tick: number };
  camera: { scale: number; version: number; x: number; y: number; centreOn(x: number, y: number): void };
  controls: { setSpeed(s: number): void; toggle(): void };
  centreOnBusiest(): void;
  director?: { enable(on: boolean): void; focus(): string | null };
  ready(): boolean;
}
type Win = { __view?: ViewHook };

const chrome = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
mkdirSync(out, { recursive: true });
const server = await createServer({ server: { port: 5198, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: chrome, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const log: { frame: string; tick: number; x: number; y: number; scale: number; fps: string; focus: string | null; ticker: string[] }[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.addInitScript('window.__name = (f) => f');
  await page.goto(`http://localhost:5198/?start=1&run=${opt('run', '1')}&map=${opt('map', '1')}&advance=${opt('advance', '3600')}`);
  await page.waitForFunction(() => (window as unknown as Win).__view?.ready() ?? false, null, { timeout: 600_000 });
  const hasDirector = await page.evaluate(() => (window as unknown as Win).__view!.director !== undefined);
  if (director && !hasDirector) console.warn('no director in this build: following the busiest place instead');
  await page.evaluate(
    ({ s, d, sc }) => {
      const v = (window as unknown as Win).__view!;
      v.camera.scale = sc;
      v.camera.version++;
      if (d && v.director) v.director.enable(true);
      else v.centreOnBusiest();
      v.controls.setSpeed(s);
      v.controls.toggle();
    },
    { s: speed, d: director, sc: scale },
  );
  for (let k = 0; k < frames; k++) {
    await page.waitForTimeout(every * 1000);
    if (!(director && hasDirector)) await page.evaluate(() => (window as unknown as Win).__view!.centreOnBusiest());
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => {
      const v = (window as unknown as Win).__view!;
      const ticker = [...document.querySelectorAll('#ticker .line, #ticker li, #ticker p')].map((e) => (e.textContent ?? '').trim()).filter(Boolean).slice(-6);
      return { tick: v.stats.tick, x: v.camera.x, y: v.camera.y, scale: v.camera.scale, fps: document.querySelector('#fps')?.textContent ?? '', focus: v.director?.focus() ?? null, ticker };
    });
    const frame = `${out}/frame-${String(k + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: frame });
    log.push({ frame, ...info });
    console.log(`${frame}  tick ${info.tick}  at ${info.x.toFixed(0)},${info.y.toFixed(0)}  ${info.focus ?? ''}`);
  }
} finally {
  writeFileSync(`${out}/observe.json`, JSON.stringify(log, null, 1));
  await browser.close();
  await server.close();
}
