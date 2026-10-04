import type { Scenario } from './state/world';

/** The viewer-facing defaults. Sweeps vary runSeed and hold mapSeed. */
export const defaultScenario: Scenario = {
  population: 6000,
  startHour: 9,
  origin: 'enclosed',
  archetypeMix: { civilian: 0.68, police: 0.02, hunkerDown: 0.26, loner: 0.03, reckless: 0.01 },
  zombieGait: 'shambler',
  power: true,
  mapSeed: 1,
  runSeed: 1,
  stalemateController: true,
};
