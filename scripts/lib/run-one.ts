// One headless run, summarised for the sweep. Shared by scripts/sweep.ts workers.

import { config as baseConfig, type Config } from '../../src/config';
import { defaultScenario } from '../../src/sim/scenario';
import { createWorld } from '../../src/sim/setup';
import { turnedTotal, unturnedTotal, type Counters } from '../../src/sim/state';
import { step } from '../../src/sim/tick';

export interface RunSummary {
  runSeed: number;
  mapSeed: number;
  population: number;
  /** Counters every `sampleEvery` ticks, starting at tick 0. */
  samples: Counters[];
  /** Share of the population that ever turned (turned leaves at the end). */
  infection: number;
  /** First tick the outbreak was over — no infection left, or nobody left — or null. */
  resolvedAt: number | null;
  msPerTick: number;
  invariantError: string | null;
}

/** Deep-sets `a.b.c=value` overrides on a copy of the config. */
export function withOverrides(overrides: Record<string, unknown>): Config {
  const copy = structuredClone(baseConfig) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split('.');
    let node = copy;
    for (const k of keys.slice(0, -1)) {
      if (typeof node[k] !== 'object' || node[k] === null) throw new Error(`unknown config path: ${path}`);
      node = node[k] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1]!;
    if (!(last in node)) throw new Error(`unknown config path: ${path}`);
    node[last] = value;
  }
  return copy as unknown as Config;
}

export function runOne(runSeed: number, mapSeed: number, overrides: Record<string, unknown>, sampleEvery = 600): RunSummary {
  const config = withOverrides(overrides);
  const { world, ctx } = createWorld({ ...defaultScenario, runSeed, mapSeed, stalemateController: false }, config);
  const samples: Counters[] = [structuredClone(world.counters)];
  let resolvedAt: number | null = null;
  let invariantError: string | null = null;
  const t0 = performance.now();
  try {
    while (world.tick < config.time.runLength) {
      step(world, ctx, { checkInvariant: true });
      const c = world.counters;
      const active = c.turned.symptomatic + c.turned.outdoors + c.turned.occupying;
      if (resolvedAt === null && (active === 0 || unturnedTotal(c) - c.unturned.dead - c.unturned.rescued === 0)) {
        resolvedAt = world.tick;
      }
      if (world.tick % sampleEvery === 0) samples.push(structuredClone(c));
    }
  } catch (e) {
    invariantError = e instanceof Error ? e.message : String(e);
  }
  return {
    runSeed,
    mapSeed,
    population: world.scenario.population,
    samples,
    infection: turnedTotal(world.counters) / world.scenario.population,
    resolvedAt,
    msPerTick: (performance.now() - t0) / Math.max(1, world.tick),
    invariantError,
  };
}
