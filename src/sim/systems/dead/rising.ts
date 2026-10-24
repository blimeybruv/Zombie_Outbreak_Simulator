// Rising: some of those the dead kill get up again, late, where they fell. Feeding
// stays what it was — the swarm mostly kills, the lone bite is the vector — but the
// eaten are no longer lost to the outbreak for good, and nowhere people died is safe
// for good: a street a shelter stands on, a building breached and then cleared.
//
//   mark    a tracked sim fed on (combat.ts killSim) — or a resident killed in a breach
//           (buildings.ts) — rises at rising.chance, rising.delay ticks later
//   rise    step 8, after conversions: in the street, an awake zombie where it lay;
//           indoors, an occupier of the building it died in
//
// A zombie destroyed stays destroyed, and anyone shot stays dead: only the dead's own
// kills rise.

import type { Context } from '../../context';
import { transfer } from '../../counters';
import { chance, nextInt } from '../../lib/rng';
import { spawnZombie } from '../../spawn';
import type { Building, Sim, World } from '../../state';
import { occupierAppeared } from '../buildings/buildings';

function delay(world: World): number {
  const d = world.config.rising.delay;
  return nextInt(world.rng, d[0], d[1]);
}

/** A tracked sim the dead have just killed: whether, and when, it will get up. */
export function markRising(world: World, sim: Sim): void {
  if (chance(world.rng, world.config.rising.chance)) sim.risesAt = world.tick + delay(world);
}

/** A resident killed in a breach: whether, and when, it will get up, inside. */
export function markResidentRising(world: World, b: Building): void {
  if (!chance(world.rng, world.config.rising.chance)) return;
  const at = world.tick + delay(world);
  let i = b.risings.length;
  while (i > 0 && b.risings[i - 1]! > at) i--;
  b.risings.splice(i, 0, at);
}

/** An occupier getting up inside: counted, and the building treated as newly occupied. */
function riseInside(world: World, ctx: Context, b: Building, x: number, y: number, from: Sim | null): void {
  spawnZombie(world, x, y, 'occupying', b.id, from?.id ?? null);
  const first = b.zombiesInside === 0;
  b.zombiesInside++;
  b.occupiedAt ??= world.tick;
  transfer(world, 'unturned.dead', 'turned.occupying');
  world.lastConversionAt = world.tick;
  ctx.events.push({ type: 'bodyRose', tick: world.tick, sim: from?.id ?? null, x, y });
  if (first) occupierAppeared(world, ctx, b, 'inside', from);
}

/** Step 8, after conversions: the dead whose time has come get up. */
export function riseDue(world: World, ctx: Context): void {
  const { tick } = world;
  const count = world.sims.length;
  for (let i = 0; i < count; i++) {
    const sim = world.sims[i]!;
    if (sim.risesAt === null || sim.risesAt > tick) continue;
    sim.risesAt = null;
    if (sim.condition !== 'dead') continue;
    sim.condition = 'turned';
    if (sim.insideBuilding !== null) {
      riseInside(world, ctx, world.buildings[sim.insideBuilding]!, sim.x, sim.y, sim);
      continue;
    }
    spawnZombie(world, sim.x, sim.y, 'active', null, sim.id);
    transfer(world, 'unturned.dead', 'turned.outdoors');
    world.lastConversionAt = tick;
    ctx.events.push({ type: 'bodyRose', tick, sim: sim.id, x: sim.x, y: sim.y });
  }
  for (const b of world.buildings) {
    while (b.risings.length > 0 && b.risings[0]! <= tick) {
      b.risings.shift();
      world.residentDeaths--;
      const cx = (b.outline[0]!.x + b.outline[2]!.x) / 2, cy = (b.outline[0]!.y + b.outline[2]!.y) / 2;
      riseInside(world, ctx, b, cx, cy, null);
    }
  }
}
