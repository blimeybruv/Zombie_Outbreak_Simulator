// Notes on events for the ticker: who (a name only if promoted), armed or not, and
// where in words — captured when the event happens, by whoever hosts the simulation
// (the worker, or a headless script measuring the ticker).

import type { Context } from '../sim/context';
import type { Building, SimEvent, World } from '../sim/state';
import type { EventNote } from './protocol';

/** Tags that read badly as nouns get one; the rest are split: "hardwareStore" → "hardware store". */
export const NOUNS: Record<string, string> = { residential: 'house', firearmsStore: 'gun shop', office: 'office block' };
export function words(tag: string): string {
  return NOUNS[tag] ?? tag.replace(/([A-Z])/g, ' $1').toLowerCase();
}

function districtAt(w: World, x: number, y: number): string {
  const d = w.districts.find((o) => x >= o.bounds.x && x < o.bounds.x + o.bounds.w && y >= o.bounds.y && y < o.bounds.y + o.bounds.h);
  return d?.name ?? '';
}

export function centreOf(b: Building): { x: number; y: number } {
  let x = 0, y = 0;
  for (const p of b.outline) {
    x += p.x / b.outline.length;
    y += p.y / b.outline.length;
  }
  return { x, y };
}

/** Who, armed or not, and where — captured at the tick it happened. */
export function noteFor(w: World, c: Context, e: SimEvent): EventNote | null {
  let sim: number | null = null;
  let building: number | null = null;
  let x = 0, y = 0;
  switch (e.type) {
    case 'zombieDestroyed':
      return null;
    case 'simDied':
    case 'simTurned':
      if (e.sim === null) return null; // an anonymous resident, inside: no line of its own
      sim = e.sim;
      x = e.x;
      y = e.y;
      break;
    case 'materialsDelivered':
    case 'weaponFound':
      sim = e.sim;
      building = e.building;
      break;
    case 'districtChanged':
      sim = e.sim;
      break;
    default:
      sim = e.sim;
      building = e.building;
  }
  const s = sim === null ? null : w.sims[sim]!;
  let place: string;
  let district: string;
  if (building !== null) {
    const b = w.buildings[building]!;
    ({ x, y } = centreOf(b));
    place = `the ${words(b.tag)} on ${w.streets[b.street]!.name}`;
    district = w.districts[b.district]!.name;
  } else {
    if (s && e.type === 'districtChanged') ({ x, y } = s);
    const street = c.map.nearestStreet(x, y, 80);
    place = street === null ? 'open ground' : w.streets[street]!.name;
    district = districtAt(w, x, y);
  }
  const namedFor = s?.namedAt != null ? w.tick - s.namedAt : null;
  return { sim, name: s?.name ?? null, namedFor, armed: s?.weapon != null, building, place, district, x, y };
}

