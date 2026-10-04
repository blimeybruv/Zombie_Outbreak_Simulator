// Movement health: how often moving agents make no progress (stuck against a wall)
// and how often they reverse direction tick-to-tick (zig-zag), sampled over a run.
//
//   npx tsx scripts/movement-check.ts [ticks] [runSeed]

import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { step } from '../src/sim/tick';

const ticks = Number(process.argv[2] ?? 6000);
const runSeed = Number(process.argv[3] ?? 1);
const { world, ctx } = createWorld({ ...defaultScenario, runSeed, stalemateController: false }, config);
const prevSim = new Map<number, [number, number]>();
const prevZom = new Map<number, [number, number]>();
const stats = { sim: { moving: 0, stuck: 0, reversals: 0, offMap: 0 }, zombie: { moving: 0, stuck: 0, reversals: 0, offMap: 0 } };

function track(kind: 'sim' | 'zombie', id: number, x0: number, y0: number, x1: number, y1: number, prev: Map<number, [number, number]>, trying: boolean) {
  const s = stats[kind];
  if (!trying) return prev.delete(id);
  s.moving++;
  if (!ctx.map.walkable(x1, y1)) s.offMap++;
  const dx = x1 - x0, dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d < 0.05) s.stuck++;
  const last = prev.get(id);
  if (last && d > 0.05) {
    const l = Math.hypot(last[0], last[1]);
    if (l > 0.05 && (dx * last[0] + dy * last[1]) / (d * l) < -0.5) s.reversals++;
  }
  prev.set(id, [dx, dy]);
}

while (world.tick < ticks) {
  const sims = world.sims.map((s) => [s.x, s.y] as const);
  const zoms = world.zombies.map((z) => [z.x, z.y] as const);
  step(world, ctx, { checkInvariant: false });
  if (world.tick < 600) continue;
  for (const s of world.sims) {
    const before = sims[s.id];
    const moving = before !== undefined && s.insideBuilding === null && (s.condition === 'healthy' || s.condition === 'infected') && s.gait !== 'still';
    if (before) track('sim', s.id, before[0], before[1], s.x, s.y, prevSim, moving);
  }
  for (const z of world.zombies) {
    const before = zoms[z.id];
    const moving = before !== undefined && (z.state === 'active' || z.state === 'wandering') && (ctx.zombieSpeed[z.id] ?? 0) > 0;
    if (before) track('zombie', z.id, before[0], before[1], z.x, z.y, prevZom, moving);
  }
}
for (const [kind, s] of Object.entries(stats)) {
  const pct = (n: number) => `${((100 * n) / Math.max(1, s.moving)).toFixed(1)}%`;
  console.log(`${kind.padEnd(7)} moving agent-ticks ${s.moving}  stuck ${pct(s.stuck)}  reversals ${pct(s.reversals)}  off-walkable ${pct(s.offMap)}`);
}
