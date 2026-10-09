// Salience scoring for the ticker, apart from any DOM so a headless script can
// replay a run through exactly the same filter (scripts/ticker-rate.ts).
//
//   salience = baseWeight × rarity × involvement × proximity
//
// rarity      1 / (1 + occurrences of this kind in the last 600 ticks)
// involvement 3 promoted survivor, 1.5 armed, 1 otherwise
// proximity   1.5 inside the viewport, 1 outside
//
// The bar scales with speed, so 8× surfaces only the large events. A repeat of
// the same kind at the same building within the rarity window is not news.

import { config } from '../config';
import type { SimEvent } from '../sim/state';
import type { EventNote } from '../worker/protocol';

/** Base weights (reference: Salience), keyed by event kind. Kinds the reference does not list are marked. */
export const BASE = {
  promotedLoss: 100, // a promoted survivor dies or turns
  cascadeCrossed: 80,
  occupationContested: 60,
  buildingRetaken: 50, // not in the reference: the rarest good news there is
  buildingBreached: 40,
  shelterFell: 40,
  materialsDelivered: 25,
  districtChanged: 20,
  weaponFound: 15,
  shelterEstablished: 10, // not in the reference: common, worth a line only when rare
  simTurned: 2,
  simDied: 1, // not in the reference
} as const;
export type Kind = keyof typeof BASE;

const RARITY_WINDOW = 600; // ticks
const THRESHOLD_AT_1X = 10;
/** Events at or above this base weight may pull playback back to 1× (see `dropsTo1x`). */
export const MAJOR = 80;

/**
 * Whether an event that cleared the bar should drop playback to 1×: a cascade
 * always; a named survivor's death or conversion only if the viewer has had time to
 * follow them (`playback.dropTo1xNamedFor`).
 */
export function dropsTo1x(kind: Kind, n: EventNote): boolean {
  if (BASE[kind] < MAJOR) return false;
  if (kind === 'promotedLoss') return n.namedFor !== null && n.namedFor >= config.playback.dropTo1xNamedFor;
  return true;
}

function kindOf(e: SimEvent, n: EventNote): Kind | null {
  if ((e.type === 'simDied' || e.type === 'simTurned') && n.name !== null) return 'promotedLoss';
  return e.type in BASE ? (e.type as Kind) : null;
}

export class Salience {
  private readonly seen = new Map<Kind, number[]>(); // ticks of recent occurrences, per kind
  private readonly lastAt = new Map<string, number>(); // kind@building → tick last shown

  /** Every event counts toward rarity; returns the kind if this one clears the bar at `speed`. */
  pass(e: SimEvent, n: EventNote, speed: number, inView: boolean): Kind | null {
    const kind = kindOf(e, n);
    if (kind === null) return null;
    const recent = this.seen.get(kind) ?? [];
    while (recent.length > 0 && e.tick - recent[0]! > RARITY_WINDOW) recent.shift();
    const rarity = 1 / (1 + recent.length);
    recent.push(e.tick);
    this.seen.set(kind, recent);
    const involvement = n.name !== null ? 3 : n.armed ? 1.5 : 1;
    const salience = BASE[kind] * rarity * involvement * (inView ? 1.5 : 1);
    if (salience < THRESHOLD_AT_1X * Math.max(1, speed)) return null;
    if (n.building !== null) {
      const key = `${kind}@${n.building}`;
      const last = this.lastAt.get(key);
      if (last !== undefined && e.tick - last < RARITY_WINDOW) return null;
      this.lastAt.set(key, e.tick);
    }
    return kind;
  }
}
