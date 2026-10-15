// How each person's story ended, as it happened: the cause, the place, the tick. The
// simulation does not keep these on the Sim (nothing in it reads them); the worker
// notes them from the events it already sees, for the inspector to tell a viewer who
// clicks someone dead what happened to them rather than what they were like.

import type { Context } from '../sim/context';
import type { SimEvent, World } from '../sim/state';
import { noteFor, words } from './notes';

export interface Ending {
  how: 'fedOn' | 'breach' | 'shot' | 'mistaken' | 'returned' | 'turned' | 'evacuated';
  place: string;
  tick: number;
  /** The tick the body got up again, if it did. */
  roseAt: number | null;
}

const endings = new Map<number, Ending>();

export function clearEndings(): void {
  endings.clear();
}

export function endingOf(id: number): Ending | null {
  return endings.get(id) ?? null;
}

/** Notes any endings among this tick's events. Called after every step, fast-forwarding included. */
export function noteEndings(w: World, c: Context, events: readonly SimEvent[]): void {
  for (const e of events) {
    if (e.type === 'bodyRose') {
      if (e.sim === null) continue;
      const end = endings.get(e.sim);
      if (end) end.roseAt = e.tick;
      continue;
    }
    if (e.type !== 'simDied' && e.type !== 'simTurned' && e.type !== 'simLeft') continue;
    if (e.sim === null) continue;
    const how = e.type === 'simDied' ? e.cause : e.type === 'simTurned' ? 'turned' : 'evacuated';
    // Indoors, the building it was in; outdoors, the street (as the ticker would put it).
    const s = w.sims[e.sim]!;
    const b = s.insideBuilding === null ? null : w.buildings[s.insideBuilding]!;
    const place = b ? `the ${words(b.tag)} on ${w.streets[b.street]!.name}` : (noteFor(w, c, e)?.place ?? 'somewhere in the city');
    endings.set(e.sim, { how, place, tick: e.tick, roseAt: null });
  }
}
