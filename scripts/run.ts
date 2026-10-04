// Headless run: one scenario for a full run, printing the eight counters every
// 600 ticks and asserting the population invariant every tick.
//
//   npx tsx scripts/run.ts [runSeed] [mapSeed] [ticks]

import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/tick';

const runSeed = Number(process.argv[2] ?? defaultScenario.runSeed);
const mapSeed = Number(process.argv[3] ?? defaultScenario.mapSeed);
const ticks = Number(process.argv[4] ?? config.time.runLength);
const scenario = { ...defaultScenario, runSeed, mapSeed, stalemateController: false };
const { world, ctx } = createWorld(scenario, config);

const cols = ['tick', 'u.out', 'u.in', 'u.dead', 'u.resc', 't.symp', 't.out', 't.occ', 't.dest', 'dorm', 'ms/tick'];
console.log(`runSeed ${runSeed}  mapSeed ${mapSeed}  population ${scenario.population}`);
console.log(cols.map((c) => c.padStart(7)).join(''));
const row = (ms: number) => {
  const { unturned: u, turned: t } = world.counters;
  const dormant = world.zombies.filter((z) => z.state === 'dormant').length;
  const values = [world.tick, u.outdoors, u.indoors, u.dead, u.rescued, t.symptomatic, t.outdoors, t.occupying, t.destroyed, dormant];
  console.log([...values.map(String), ms.toFixed(2)].map((v) => v.padStart(7)).join(''));
};
row(0);
let t0 = performance.now();
while (world.tick < ticks) {
  step(world, ctx, { checkInvariant: true });
  if (world.tick % 600 === 0) {
    const now = performance.now();
    row((now - t0) / 600);
    t0 = now;
  }
}
