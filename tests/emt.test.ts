import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { spawnSim } from '../src/sim/spawn';
import type { Building, Sim, World } from '../src/sim/state';
import { callAmbulance, dispatchAmbulances, emtEnter } from '../src/sim/systems/services/emt';

const always = { ...config, emt: { ...config.emt, answer: 1, answerHalfLife: 1e12 } };

function fresh() {
  return createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, always);
}

/** A bitten sim inside an ordinary building some way from any hospital. */
function bittenIndoors(world: World): { sim: Sim; b: Building } {
  const b = world.buildings.find((x) => x.tag === 'residential' && x.zombiesInside === 0)!;
  const e = b.entrances[0]!;
  const sim = spawnSim(world, { x: e.x, y: e.y, insideBuilding: b.id, sourceTag: b.tag, from: b.id, initialPanic: 0, destinationKind: 'shelter' });
  b.sheltered.push(sim.id);
  sim.condition = 'infected';
  sim.infectedChoice = 'conceal';
  return { sim, b };
}

describe('EMTs', () => {
  it('a crew and an ambulance wait at each hospital', () => {
    const { world } = fresh();
    const amb = world.cars.filter((c) => c.kind === 'ambulance');
    expect(amb.length).toBeGreaterThan(0);
    for (const c of amb) {
      expect(world.buildings[c.home!]!.tag).toBe('hospital');
      expect(world.sims.filter((s) => s.crew === c.id)).toHaveLength(config.emt.crew);
    }
  });

  it('only the bitten who think they are merely hurt call, once', () => {
    const { world } = fresh();
    const { sim, b } = bittenIndoors(world);
    const { sim: knows, b: b2 } = bittenIndoors(world);
    knows.history.conversionsWitnessed = 1;
    callAmbulance(world, sim);
    callAmbulance(world, knows);
    expect(b.ambulanceAt).not.toBeNull();
    expect(b.ambulancePatient).toBe(sim.id);
    expect(b2.ambulanceAt === null || b2 === b).toBe(true);
    b.ambulanceAt = null;
    callAmbulance(world, sim);
    expect(b.ambulanceAt).toBeNull();
  });

  it('a crew is sent, and on walking in takes the patient without looking: nobody screens', () => {
    const { world, ctx } = fresh();
    const { sim, b } = bittenIndoors(world);
    callAmbulance(world, sim);
    world.tick = config.dispatch.interval;
    dispatchAmbulances(world, ctx);
    const car = world.cars.find((c) => c.kind === 'ambulance' && c.job === b.id);
    expect(car).toBeDefined();
    const emt = world.sims.find((s) => s.crew === car!.id)!;
    emt.insideBuilding = b.id;
    emtEnter(world, ctx, emt, b);
    expect(car!.patient).toBe(sim.id);
    expect(sim.carriedBy).not.toBeNull();
    expect(car!.job).toBe(car!.home);
    expect(b.ambulanceAt).toBeNull();
  });
});
