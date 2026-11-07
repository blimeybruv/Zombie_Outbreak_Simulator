import type { Scenario } from './state/world';

/** The viewer-facing defaults. Sweeps vary runSeed and hold mapSeed. */
export const defaultScenario: Scenario = {
  population: 6000,
  startHour: 9,
  origin: 'scattered',
  initialZombies: 10,
  start: 'outbreak',
  survivors: 200,
  archetypeMix: { civilian: 0.68, police: 0.02, prepper: 0.26, loner: 0.03, reckless: 0.01, reservist: 0 }, // reservists: config.reservists.share, drawn at instantiation (spawn.ts archetypeFor)
  homeFirearms: 0, // none: guns come from gun shops, police stations and the police
  zombieGait: 'shambler',
  power: true,
  mapSeed: 1,
  runSeed: 1,
  stalemateController: true,
};
