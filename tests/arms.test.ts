import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { spawnSim } from '../src/sim/spawn';
import type { Sim, World } from '../src/sim/state';
import { dropWeapon, loot, pickUpDrops } from '../src/sim/systems/fighting/arms';
import { rebuildHashes } from '../src/sim/systems/shared/perception';

const sure = { ...config, buildings: { ...config.buildings, lootChance: 1 } };

function fresh() {
  return createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, sure);
}

function someone(world: World, x: number, y: number): Sim {
  const s = spawnSim(world, { x, y, insideBuilding: null, sourceTag: 'office', initialPanic: 0, destinationKind: null });
  s.archetype = 'civilian';
  s.weapon = null;
  s.ammo = 0;
  return s;
}

describe('arms', () => {
  it('a house holds one thing at the start, and once it is taken there is nothing', () => {
    const { world, ctx } = fresh();
    const house = world.buildings.find((b) => b.tag === 'residential' && b.stock.length > 0)!;
    expect(house.stock).toHaveLength(config.buildings.lootStock.residential!);
    const a = someone(world, house.entrances[0]!.x, house.entrances[0]!.y);
    loot(world, ctx, a, house);
    expect(a.weapon).not.toBeNull();
    expect(house.stock).toHaveLength(0);
    const b = someone(world, house.entrances[0]!.x, house.entrances[0]!.y);
    loot(world, ctx, b, house);
    expect(b.weapon).toBeNull();
  });

  it('a weapon given up for a better one is left in its place', () => {
    const { world, ctx } = fresh();
    const house = world.buildings.find((b) => b.tag === 'residential')!;
    house.stock = [{ item: 'sledgehammer', ammo: 0 }];
    const a = someone(world, 0, 0);
    a.weapon = 'knife';
    loot(world, ctx, a, house);
    expect(a.weapon).toBe('sledgehammer');
    expect(house.stock).toEqual([{ item: 'knife', ammo: 0 }]);
  });

  it('what someone carried is left where they fell, and taken by someone passing who is better off with it', () => {
    const { world, ctx } = fresh();
    const dead = someone(world, 1600, 1600);
    dead.weapon = 'club';
    dropWeapon(world, dead);
    dead.condition = 'dead';
    expect(world.drops).toEqual([{ x: 1600, y: 1600, weapon: 'club', ammo: 0 }]);
    const inside = world.buildings.find((b) => b.tag === 'residential')!;
    const indoors = someone(world, 0, 0);
    indoors.insideBuilding = inside.id;
    indoors.weapon = 'knife';
    const before = inside.stock.length;
    dropWeapon(world, indoors);
    expect(inside.stock).toHaveLength(before + 1);
    const passer = someone(world, 1601, 1600);
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    pickUpDrops(world, ctx);
    expect(passer.weapon).toBe('club');
    expect(world.drops).toHaveLength(0);
  });
});
