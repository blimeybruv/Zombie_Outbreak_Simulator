import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { nextRun, runnerArrives } from '../src/sim/systems/people/runners';

describe('runners', () => {
  it('one who will not shelter fetches from a store nobody is in and hands the load in at a shelter door, trading news', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
    const s = world.sims.find((x) => x.condition === 'healthy' && x.insideBuilding === null && x.car === null && !x.outsider)!;
    const [store, shelter] = world.buildings.filter((b) => b.zombiesInside === 0 && b.sheltered.length === 0);
    if (!store || !shelter) throw new Error('two buildings needed');
    store.supplies = 40;
    store.residents = 0;
    shelter.supplies = 0;
    const inside = world.sims.find((x) => x !== s && x.condition === 'healthy' && x.insideBuilding === null)!;
    inside.insideBuilding = shelter.id;
    shelter.sheltered.push(inside.id);
    const rumour = world.sims.find((x) => x !== s && x !== inside)!.id;
    inside.knownInfected.add(rumour); // news it has
    const belief = (supplies: number, occupants: number) => ({ believedOccupants: occupants, supplies, fortification: 0, observedAt: world.tick, visited: false });
    s.buildingMemory.clear();
    s.buildingMemory.set(store.id, belief(40, 0));
    s.buildingMemory.set(shelter.id, belief(0, 1));
    s.supplies = 0;
    s.trust = 1; // takes what it is told

    expect(nextRun(world, s)).toBe(true);
    expect(s.destinationKind).toBe('fetch');
    expect(s.destinationBuilding).toBe(store.id);
    runnerArrives(world, ctx, s, store);
    expect(s.insideBuilding).toBeNull(); // at the door, not in
    expect(s.supplies).toBe(config.buildings.carryCap);
    expect(store.supplies).toBe(40 - config.buildings.carryCap);
    expect(s.destinationKind).toBe('deliver');
    expect(s.destinationBuilding).toBe(shelter.id);
    runnerArrives(world, ctx, s, shelter);
    expect(s.insideBuilding).toBeNull();
    expect(shelter.supplies).toBe(config.buildings.carryCap);
    expect(s.supplies).toBe(0);
    expect(ctx.events.some((e) => e.type === 'suppliesDelivered' && e.sim === s.id && e.building === shelter.id)).toBe(true);
    expect(s.knownInfected.has(rumour)).toBe(true); // what they knew, now its (trust 1)
  });
});
