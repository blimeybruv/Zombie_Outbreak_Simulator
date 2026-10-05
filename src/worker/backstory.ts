// A promoted survivor's one-line backstory, composed from fields the simulation
// already holds: profession, age, caution band, and whichever counters made the
// history unusual. True rather than decorative — every clause is a number in state.
//
// Pure and DOM-free: composed where the simulation is held (the worker, for the
// inspector; the headless sweep, for its roster log).

import type { Config } from '../config';
import type { Sim } from '../sim/state';
import { SCORED, type ScoredCounter } from '../sim/systems/promotion';

function label(profession: string): string {
  const words = profession.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function cautionBand(caution: number, config: Config): 'bold' | 'steady' | 'cautious' {
  const [low, high] = config.promotion.cautionBands;
  return caution < low! ? 'bold' : caution < high! ? 'steady' : 'cautious';
}

const minutes = (ticks: number) => Math.round(ticks / 60);

/** How each counter reads in a sentence, given its value. */
const CLAUSE: Record<Exclude<ScoredCounter, 'caution'>, (v: number) => string> = {
  ticksSurvived: (v) => `out for ${minutes(v)} min`,
  conversionsWitnessed: (v) => (v === 0 ? 'has seen nobody turn' : `saw ${v} ${v === 1 ? 'person' : 'people'} turn`),
  ticksAlone: (v) => (v < 60 ? 'never alone for long' : `alone for ${minutes(v)} min`),
  nearMisses: (v) => (v === 0 ? 'never touched' : `${v} near ${v === 1 ? 'miss' : 'misses'}`),
  kills: (v) => (v === 0 ? 'has killed nothing' : `${v} ${v === 1 ? 'kill' : 'kills'}`),
  streetsVisited: (v) => `crossed ${v} ${v === 1 ? 'street' : 'streets'}`,
  materialsDelivered: (v) => (v === 0 ? 'carried nothing home' : `carried in ${v} materials`),
};

/**
 * "Nurse, 54, cautious; saw 14 people turn, alone for 23 min". The clauses are the
 * `clauses` counters with the largest distance from the mean, either way.
 */
export function backstory(sim: Sim, values: readonly number[], z: readonly number[], config: Config, clauses = 2): string {
  const top = SCORED.map((name, i) => ({ name, i }))
    .filter((c) => c.name !== 'caution')
    .sort((a, b) => Math.abs(z[b.i]!) - Math.abs(z[a.i]!) || a.i - b.i)
    .slice(0, clauses)
    .map((c) => CLAUSE[c.name as Exclude<ScoredCounter, 'caution'>](values[c.i]!));
  return `${label(sim.profession)}, ${sim.age}, ${cautionBand(sim.caution, config)}; ${top.join(', ')}`;
}
