import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { recount } from '../src/sim/counters';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { populationTotal, type Scenario } from '../src/sim/state';
import { assertInvariant, step } from '../src/sim/tick';

function run(scenario: Scenario, ticks: number) {
  const { world, ctx } = createWorld(scenario, config);
  while (world.tick < ticks) step(world, ctx, { checkInvariant: true });
  return world;
}

/** A compact fingerprint of everything that moves. */
function fingerprint(world: ReturnType<typeof run>): string {
  return JSON.stringify({
    tick: world.tick,
    rng: world.rng,
    counters: world.counters,
    sims: world.sims.map((s) => [s.condition, s.x.toFixed(6), s.y.toFixed(6), s.panic.toFixed(9), s.insideBuilding]),
    zombies: world.zombies.map((z) => [z.state, z.x.toFixed(6), z.y.toFixed(6)]),
  });
}

describe('setup', () => {
  const { world } = createWorld(defaultScenario, config);

  it('places exactly the scenario population, consistently with a recount', () => {
    expect(populationTotal(world.counters)).toBe(defaultScenario.population);
    expect(recount(world)).toEqual(world.counters);
    assertInvariant(world);
  });

  it('starts the outbreak inside one high-occupancy building', () => {
    const origins = world.buildings.filter((b) => b.zombiesInside > 0);
    expect(origins).toHaveLength(1);
    expect(['hospital', 'office', 'school']).toContain(origins[0]!.tag);
    expect(origins[0]!.pendingTurn + origins[0]!.pendingDie + origins[0]!.pendingExpel).toBeGreaterThan(0);
  });

  it('schedules each district release within the jitter of the release tick', () => {
    const { atTick, jitter } = config.release;
    for (const d of world.districts) expect(Math.abs(d.releaseAt - atTick)).toBeLessThanOrEqual(jitter);
  });

  it.each(['enclosed', 'scattered', 'street'] as const)('places the initial zombies %s, taken from the population', (origin) => {
    const w = createWorld({ ...defaultScenario, origin, initialZombies: 12 }, config).world;
    assertInvariant(w);
    expect(w.zombies.length).toBe(12);
    const inside = new Set(w.zombies.filter((z) => z.insideBuilding !== null).map((z) => z.insideBuilding));
    if (origin === 'enclosed') expect(inside.size).toBe(1);
    if (origin === 'scattered') expect(inside.size).toBe(12);
    if (origin === 'street') expect(w.zombies.every((z) => z.state === 'active')).toBe(true);
  });
});

describe('the tick', () => {
  it('holds the invariant every tick through the opening, release and first spread', () => {
    const world = run({ ...defaultScenario, runSeed: 3 }, 2500);
    expect(world.counters.turned.outdoors + world.counters.turned.occupying + world.counters.turned.destroyed).toBeGreaterThan(5);
  }, 60_000);

  it('reproduces a run exactly from its seeds', () => {
    const scenario = { ...defaultScenario, runSeed: 5 };
    expect(fingerprint(run(scenario, 1200))).toBe(fingerprint(run(scenario, 1200)));
  }, 60_000);

  it('diverges for a different runSeed on the same map', () => {
    expect(fingerprint(run({ ...defaultScenario, runSeed: 5 }, 300))).not.toBe(fingerprint(run({ ...defaultScenario, runSeed: 6 }, 300)));
  }, 60_000);

  it('keeps the map fixed when only the runSeed changes', () => {
    const a = createWorld({ ...defaultScenario, runSeed: 1 }, config).world;
    const b = createWorld({ ...defaultScenario, runSeed: 2 }, config).world;
    expect(a.streets).toEqual(b.streets);
    expect(a.buildings.map((x) => x.outline)).toEqual(b.buildings.map((x) => x.outline));
  });
});
