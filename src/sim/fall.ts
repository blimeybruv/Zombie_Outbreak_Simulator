// A fallen city (the user's idea, B's way of building it): not a pristine map with the dead
// laid on it, but the outbreak itself, run from a first wave (setup.ts seedOutbreak,
// config.fallen.wave) until few are left. Every breach, stain, shelter, memory and
// counter is then one the run earned. The worker runs it as fast as it can and shows it
// falling; the viewer takes over once this says it has fallen.

import type { World } from './state';

/** The living in the city: everyone unturned outdoors or indoors, less the soldiers from outside. */
export function livingInCity(world: World): number {
  const c = world.counters.unturned;
  let outsiders = 0;
  for (const s of world.sims) if (s.outsider && (s.condition === 'healthy' || s.condition === 'infected')) outsiders++;
  return c.outdoors + c.indoors - outsiders;
}

/** Whether a fallen city's fall is over: the living down to its survivors, or fallen.maxTicks run. Always true for an ordinary run. */
export function fallen(world: World): boolean {
  if (world.scenario.start !== 'fallen') return true;
  return world.tick >= world.config.fallen.maxTicks || livingInCity(world) <= world.scenario.survivors;
}
