// The oddity check (scripts/lib/oddities.ts): one headless run, the same the viewer would
// show for these seeds, with what would look wrong to someone watching listed by kind and
// by place, each with a link that opens the viewer there.
//
//   npx tsx scripts/oddities.ts [runSeed] [mapSeed] [--ticks 64800] [--top 4] [--json file]
//
// The viewer must be running for the links (npm run dev).

import { writeFileSync } from 'node:fs';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/tick';
import { settingsFrom } from '../src/ui/setup';
import { ODDITY, OddityCheck, viewerLink, type Oddity, type OddityKind } from './lib/oddities';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const plain = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1]!.startsWith('--')));
const runSeed = Number(plain[0] ?? defaultScenario.runSeed);
const mapSeed = Number(plain[1] ?? defaultScenario.mapSeed);
const ticks = Number(opt('ticks', String(config.time.runLength)));
const top = Number(opt('top', '4'));

// As the viewer builds it (src/worker/sim-worker.ts), so the links show the same run.
const settings = settingsFrom(new URLSearchParams(`run=${runSeed}&map=${mapSeed}`));
const { world, ctx } = createWorld({ ...defaultScenario, ...settings, runSeed, mapSeed }, config);
const check = new OddityCheck();
while (world.tick < ticks) {
  step(world, ctx, { checkInvariant: false });
  check.observe(world, ctx);
}

const kinds: OddityKind[] = ['lap', 'stuck', 'jitter', 'wallPress', 'noDoor', 'repeated', 'freezes'];
const hours = (t: number) => `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
const show = (o: Oddity) => `  ${hours(o.tick).padStart(5)}  ${o.who.padEnd(12)} ${o.detail}\n         ${viewerLink(o, runSeed, mapSeed)}`;

console.log(`runSeed ${runSeed}  mapSeed ${mapSeed}  ${ticks} ticks (h:mm since the start)\n`);
console.log('kind        agents  ticks seen');
for (const k of kinds) console.log(`${k.padEnd(11)} ${String(check.found.filter((o) => o.kind === k).length).padStart(6)}  ${String(check.raw[k] * (k === 'repeated' || k === 'freezes' ? 1 : ODDITY.every)).padStart(10)}`);

// Places where several agents were odd at once: a ring round a block, a crowd at a wall.
const cell = 100;
const spots = new Map<string, Oddity[]>();
for (const o of check.found) {
  const k = `${Math.floor(o.x / cell)},${Math.floor(o.y / cell)},${Math.floor(o.tick / ODDITY.quiet)}`;
  spots.set(k, [...(spots.get(k) ?? []), o]);
}
const busy = [...spots.values()].filter((v) => v.length >= 3).sort((a, b) => b.length - a.length).slice(0, top * 2);
if (busy.length > 0) {
  console.log(`\nWhere several were odd together (${cell} m, within ${ODDITY.quiet} ticks):`);
  for (const v of busy) {
    const by: Record<string, number> = {};
    for (const o of v) by[o.kind] = (by[o.kind] ?? 0) + 1;
    console.log(`  ${String(v.length).padStart(3)} findings  ${Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ')}\n         ${viewerLink(v[0]!, runSeed, mapSeed)}`);
  }
}

for (const k of kinds) {
  const of = check.found.filter((o) => o.kind === k);
  if (of.length === 0) continue;
  console.log(`\n${k} — the first ${Math.min(top, of.length)} of ${of.length}:`);
  for (const o of of.slice(0, top)) console.log(show(o));
}

const json = opt('json', '');
if (json !== '') writeFileSync(json, JSON.stringify({ runSeed, mapSeed, ticks, found: check.found, raw: check.raw }, null, 1));
