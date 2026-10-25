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
  turnedInside: 40,
  quarantineCaught: 35,
  shelterFell: 40,
  suppliesRanOut: 12, // not in the reference: a shelter failing with nothing breaking in — common (most households, in time), so just over the 1× bar
  suppliesDelivered: 25,
  districtChanged: 20,
  policeDispatched: 20, // not in the reference: a 911 call answered
  simIsolating: 30, // not in the reference: a decision only the viewer sees
  carAbandoned: 25, // not in the reference: a road closing for good
  carAlarm: 30, // not in the reference: why a horde just changed direction
  vehicleTaken: 35, // not in the reference: why an ambulance is heading for the edge
  carCrashed: 35, // not in the reference: a road blocked, and maybe people dead
  swatDeployed: 60, // not in the reference: the institution answering something large
  cordonClosed: 90, // not in the reference: the city sealed — drops playback to 1×
  outOfAmmo: 20, // not in the reference: why a squad member is walking away from the fight
  checkpointSet: 60, // not in the reference: the city trying to contain itself
  checkpointFallen: 70, // not in the reference: that attempt failing, one road at a time
  cordonBreached: 70, // not in the reference: a way out open again, nobody left to hold it
  bodyRose: 40, // not in the reference: a named survivor, dead, walking again
  cordonShot: 70, // not in the reference: the cordon firing on the city's own people (killed or wounded)
  cordonEvaded: 50, // not in the reference: someone through the cordon's fire and out
  simLeft: 30, // not in the reference: a named survivor out of the city (only they make a line)
  ambulanceDispatched: 20, // not in the reference: help on the way
  patientAdmitted: 45, // not in the reference: the vector delivered
  policeRadio: 35, // not in the reference: an officer outmatched
  rescueSweep: 90, // not in the reference: the ending begins — drops playback to 1×
  rescueBroadcast: 90, // not in the reference: everyone hidden is told to move
  truckLeft: 35, // not in the reference
  firstEvacuation: 85, // not in the reference: the evacuation the world outside reacts to — drops playback to 1×
  districtEvacuating: 70, // not in the reference: a whole neighbourhood leaving at once
  reservistsCalledUp: 85, // not in the reference: the institution admitting the scale of it — drops playback to 1×
  squadFormed: 50, // not in the reference: an armed group, mid-run — rare
  squadDissolved: 40, // not in the reference
  squadEngaged: 30, // not in the reference: file to diamond
  strangerRefused: 12, // not in the reference: common once shelters fill, worth a line when rare
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
  if (e.type === 'simDied' && (e.cause === 'shot' || e.cause === 'mistaken' || e.cause === 'returned')) return 'cordonShot';
  if (e.type === 'cordonFiredOn' || e.type === 'cordonWounded') return 'cordonShot';
  if (e.type === 'districtEvacuating' && e.first) return 'firstEvacuation';
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
