// Measures the ticker gate headlessly: fewer than 6 lines per second at 1×.
//
//   npx tsx scripts/ticker-rate.ts [--seed 1] [--map 1] [--ticks 36000]
//
// Replays one run through the same notes and salience filter the viewer uses, at
// each playback speed, assuming the worst case for proximity (every event on
// screen). Lines per wall-clock second at speed s are lines per s × ticksPerSecondAt1x
// ticks. Reports the mean, the busiest second, and how many seconds exceed 6 —
// plus how often an event would pull 8× back to 1×.

import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/tick';
import { line } from '../src/ui/copy';
import { BASE, dropsTo1x, MAJOR, Salience } from '../src/ui/salience';
import { noteFor } from '../src/worker/notes';

const args = process.argv.slice(2);
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const ticks = opt('ticks', config.time.runLength);
const GATE = 6;

const { world, ctx } = createWorld({ ...defaultScenario, runSeed: opt('seed', 1), mapSeed: opt('map', 1) }, config);
const speeds = config.playback.speeds.filter((s) => s >= 1);
const filters = speeds.map(() => new Salience());
const linesPerTick = speeds.map(() => new Uint16Array(ticks + 1));
const majors = new Map<string, number[]>(); // at 8×: kind → how long the subject had been named
let drops = 0;

while (world.tick < ticks) {
  step(world, ctx, { checkInvariant: false });
  for (const e of world.events) {
    const n = noteFor(world, ctx, e);
    if (!n || line(e, n) === null) continue;
    speeds.forEach((s, i) => {
      const kind = filters[i]!.pass(e, n, s, true);
      if (kind === null) return;
      linesPerTick[i]![world.tick]!++;
      if (s === 8 && BASE[kind] >= MAJOR) majors.set(kind, [...(majors.get(kind) ?? []), n.namedFor ?? -1]);
      if (s === 8 && dropsTo1x(kind, n)) drops++;
    });
  }
}

console.log(`ticker rate, runSeed ${opt('seed', 1)}, ${ticks} ticks, every event treated as on screen`);
speeds.forEach((s, i) => {
  const per = s * config.playback.ticksPerSecondAt1x; // ticks per wall second
  const seconds: number[] = [];
  for (let t = 1; t + per - 1 <= ticks; t += per) {
    let n = 0;
    for (let k = t; k < t + per; k++) n += linesPerTick[i]![k]!;
    seconds.push(n);
  }
  const total = seconds.reduce((a, b) => a + b, 0);
  const over = seconds.filter((n) => n >= GATE).length;
  console.log(`  ${String(s).padStart(2)}×: ${(total / seconds.length).toFixed(2)} lines/s mean, busiest second ${Math.max(...seconds)}, seconds at ${GATE}+: ${over} of ${seconds.length}${s === 1 ? (Math.max(...seconds) < GATE ? '  PASS' : '  FAIL') : ''}`);
});
for (const [kind, named] of majors) {
  const sorted = [...named].sort((a, b) => a - b);
  console.log(`  ${kind} at 8× (major): ${named.length}; named for (ticks): ${sorted.join(' ')}`);
}
console.log(`  drops to 1× in a run at 8×: ${drops} (one per ${(ticks / 80 / Math.max(1, drops)).toFixed(0)} s of an 8× run)`);
