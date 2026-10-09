// Serves the viewer, opens it in headless Chromium and screenshots it: a way to see
// the renderer from a container with no display.
//
//   npx tsx scripts/view.ts [--advance 6000] [--play 8] [--seconds 5] [--out dir] [--run 1] [--map 1] [--click] [--at x,y] [--query k=v&...] [--flagged 1]
//
// Shots are taken at far, mid and near zoom (near centred on the busiest spot, or
// on --at, a world point in metres, or with --flagged on the first survivor outdoors
// carrying those SIM_* flag bits: 1 infected, 2 frozen, 4 fighting).
// --click then clicks the middle of the near view and takes a fourth shot, with the
// inspector open on whatever was there.

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const advance = Number(opt('advance', '6000'));
const speed = Number(opt('play', '0'));
const seconds = Number(opt('seconds', '5'));
const out = opt('out', 'view-shots');
const runSeed = opt('run', '1');
const mapSeed = opt('map', '1');
const at = args.includes('--at') ? opt('at', '0,0').split(',').map(Number) : null;
/** What the page exposes for scripting (src/main.ts). */
interface ViewHook {
  stats: { frames: number; drawMs: number; since: number; tick: number };
  camera: { scale: number; version: number; centreOn(x: number, y: number): void };
  controls: { setSpeed(s: number): void; toggle(): void };
  centreOnBusiest(): void;
  centreOnFlagged(flags: number): boolean;
  ready(): boolean;
}
// Callbacks passed to page.evaluate run inside the page, so each reaches the hook itself.
type Win = { __view?: ViewHook };

const chrome = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

mkdirSync(out, { recursive: true });
const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: chrome, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  // tsx keeps function names with a helper that serialised callbacks carry into the page.
  await page.addInitScript('window.__name = (f) => f');
  await page.goto(`http://localhost:5199/?run=${runSeed}&map=${mapSeed}&advance=${advance}&${opt('query', '')}`);
  await page.waitForFunction(() => (window as unknown as Win).__view?.ready() ?? false, null, { timeout: 600_000 });
  if (speed > 0) {
    await page.evaluate((s) => {
      const v = (window as unknown as Win).__view!;
      v.controls.setSpeed(s);
      v.controls.toggle();
    }, speed);
    await page.waitForTimeout(seconds * 1000);
  }
  type Shot = { name: string; scale: number; busiest?: boolean; at?: number[] | null };
  const shots: Shot[] = [
    { name: 'far', scale: 0.26 },
    { name: 'mid', scale: 0.55 },
    { name: 'near', scale: 2.4, busiest: at === null, at },
  ];
  for (const shot of shots) {
    await page.evaluate(({ scale, busiest, at }) => {
      const v = (window as unknown as Win).__view!;
      v.camera.scale = scale;
      v.camera.version++;
      if (at) v.camera.centreOn(at[0]!, at[1]!);
      else if (!busiest) v.camera.centreOn(1600, 1600);
    }, shot);
    if (shot.busiest) {
      // Centre on the densest cluster of agents in the current frame, or on someone flagged.
      const flagged = Number(opt('flagged', '0'));
      const found = flagged > 0 && (await page.evaluate((f) => (window as unknown as Win).__view!.centreOnFlagged(f), flagged));
      if (!found) await page.evaluate(() => (window as unknown as Win).__view!.centreOnBusiest());
    }
    await page.waitForTimeout(400);
    const tick = await page.evaluate(() => (window as unknown as Win).__view!.stats.tick);
    await page.screenshot({ path: `${out}/${shot.name}.png` });
    console.log(`${out}/${shot.name}.png  (tick ${tick}, ${shot.scale} px/m)`);
  }
  if (args.includes('--click')) {
    // Try a few points around the middle until something is picked.
    for (const [dx, dy] of [[0, 0], [12, 0], [0, 12], [-12, 0], [0, -12], [30, 30], [-30, 30]] as const) {
      await page.mouse.click(720 + dx, 450 + dy);
      await page.waitForTimeout(300);
      if (await page.evaluate(() => (document.querySelector('#inspector')?.childElementCount ?? 0) > 0)) break;
    }
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/inspect.png` });
    console.log(`${out}/inspect.png`);
  }
} finally {
  await browser.close();
  await server.close();
}
