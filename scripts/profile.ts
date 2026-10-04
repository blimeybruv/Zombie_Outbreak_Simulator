// Per-stage timing of the tick, alongside what each population is doing. For finding
// where to look; whether a change helped is decided by whole-run time (scripts/bench.ts).
//
//   npx tsx scripts/profile.ts [ticks] [population] [runSeed]

import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/tick';

const ticks = Number(process.argv[2] ?? 12000);
const population = Number(process.argv[3] ?? defaultScenario.population);
const runSeed = Number(process.argv[4] ?? 1);
const { world, ctx } = createWorld({ ...defaultScenario, population, runSeed, stalemateController: false }, config);

const totals = new Map<string, number>();
let window = new Map<string, number>();
let last = 0;
let previous = 'start';
const probe = (stage: string) => {
  const now = performance.now();
  if (stage !== 'start') window.set(stage, (window.get(stage) ?? 0) + now - last);
  last = now;
  previous = stage;
};

const header = ['tick', 'ms/tick', 'hashes', 'percep', 'zombies', 'panic', 'sims', 'combat', 'move', 'build', 'encount', '| out', 'in', 'zAwake', 'zDorm', 'zOcc'];
console.log(header.map((h) => h.padStart(7)).join(''));
const every = Math.max(1, Math.floor(ticks / 12));
while (world.tick < ticks) {
  step(world, ctx, { checkInvariant: false, probe });
  if (world.tick % every === 0) {
    const ms = (k: string) => (window.get(k) ?? 0) / every;
    const total = [...window.values()].reduce((a, b) => a + b, 0) / every;
    const living = world.sims.filter((s) => s.condition === 'healthy' || s.condition === 'infected');
    const out = living.filter((s) => s.insideBuilding === null).length;
    const z = world.zombies;
    const awake = z.filter((q) => q.state === 'active' || q.state === 'wandering' || q.state === 'feeding').length;
    const dorm = z.filter((q) => q.state === 'dormant').length;
    const occ = z.filter((q) => q.state === 'occupying').length;
    const row = [world.tick, total, ms('hashes'), ms('perception'), ms('zombies'), ms('panic'), ms('sims'), ms('combat'), ms('movement'), ms('buildings'), ms('encounters')];
    console.log([...row.map((v, i) => (i === 0 ? String(v) : v.toFixed(2))), '|', out, living.length - out, awake, dorm, occ].map((v) => String(v).padStart(7)).join(''));
    for (const [k, v] of window) totals.set(k, (totals.get(k) ?? 0) + v);
    window = new Map();
  }
}
void previous;
