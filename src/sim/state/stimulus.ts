// One noise event type. Stimuli wake dormant zombies, give awake ones a place to
// go (never a target), raise sim panic, and feed audio. Two sources: weapons, and a
// survivor shouting a warning on sighting a zombie — which the dead hear as well as
// the living. Footsteps are not stored as stimuli: running and sprinting are heard
// only by zombies within the gait's noise radius at that moment.

import type { Metres, Tick, Unit01 } from './units';
import type { Weapon } from './sim';

export type StimulusKind = Weapon | 'shout';

export interface Stimulus {
  /** @range 0–3200 @unit m @readBy zombie hearing, panic, audio */
  x: Metres;
  /** @range 0–3200 @unit m @readBy zombie hearing, panic, audio */
  y: Metres;
  /** What made it. @range 6 weapons, or a shout @unit enum @readBy audio, resident expulsion (weapons only) */
  kind: StimulusKind;
  /** Already halved at creation if the source was indoors. @range 0–200 @unit m @readBy zombie hearing, panic */
  radius: Metres;
  /** At the origin; falls linearly to zero at `radius`. @range 0–1 @unit scalar @readBy zombie hearing (wakeThreshold, loudest wins), panic, audio */
  intensity: Unit01;
  /** @range tick @unit tick @readBy audio (onset) */
  createdAt: Tick;
  /** Removed at this tick (createdAt + decay). @range tick @unit tick @readBy stimulus expiry */
  expiresAt: Tick;
}
