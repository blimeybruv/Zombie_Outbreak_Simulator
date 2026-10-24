import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { rideToCall } from '../src/sim/systems/services/dispatch';
import { rebuildHashes } from '../src/sim/systems/shared/perception';

describe('police cars', () => {
  it('first responders sent to a far call get into their station car together and drive', () => {
    const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
    const car = world.cars.find((c) => c.kind === 'cruiser')!;
    expect(world.buildings[car.home!]!.tag).toBe('policeStation');
    const officers = world.sims.filter((s) => s.station === car.home && s.squadLeader === null).slice(0, 2);
    const call = world.buildings.find((b) => Math.hypot(b.entrances[0]!.x - car.x, b.entrances[0]!.y - car.y) > config.police.carBeyond + 200)!;
    const door = call.entrances[0]!;
    for (const o of officers) {
      world.buildings[car.home!]!.sheltered = world.buildings[car.home!]!.sheltered.filter((id) => id !== o.id);
      o.insideBuilding = null;
      o.x = car.x + 1;
      o.y = car.y;
      o.answering = call.id;
      o.destinationKind = 'respond';
      o.destination = { x: door.x, y: door.y };
    }
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    expect(rideToCall(world, ctx, officers[0]!, officers[0]!.destination!)).toBe('aboard');
    expect(car.state).toBe('driving');
    expect(car.occupants).toEqual(officers.map((o) => o.id));
  });
});

describe('service yards', () => {
  it('police stations and hospitals with a yard keep their crews\' vehicles in its bays', () => {
    const { world } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
    const yards = world.lots.filter((l) => l.home !== null);
    expect(yards.length).toBeGreaterThan(0);
    for (const l of yards) {
      const home = world.buildings[l.home!]!;
      expect(['policeStation', 'hospital']).toContain(home.tag);
      const mine = world.cars.filter((c) => c.home === home.id && c.kind !== 'van');
      // A station's crews' cruisers, and one for each traffic unit waiting there.
      const traffic = world.sims.filter((s) => s.checkpoint !== null && s.squadLeader === s.id && s.station === home.id).length;
      const want = home.tag === 'policeStation' ? config.yards.policeCrews + traffic : config.yards.hospitalCrews;
      expect(mine.length).toBe(want);
    }
    // Yards are for their own vehicles: no civilian car in one.
    for (const l of yards) {
      const o = l.outline;
      const minX = Math.min(...o.map((p) => p.x)), maxX = Math.max(...o.map((p) => p.x));
      const minY = Math.min(...o.map((p) => p.y)), maxY = Math.max(...o.map((p) => p.y));
      const inside = world.cars.filter((c) => c.kind === 'car' && c.x > minX && c.x < maxX && c.y > minY && c.y < maxY);
      expect(inside.length).toBeLessThanOrEqual(1); // an axis box over a turned yard can catch a kerb car
    }
  });
});
