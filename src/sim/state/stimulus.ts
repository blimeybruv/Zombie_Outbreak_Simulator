// One noise event type, used by combat and movement. Stimuli wake dormant zombies,
// give awake ones a place to go (never a target), raise sim panic, and feed audio.

import type { Metres, Tick, Unit01 } from './units';
import type { Weapon } from './sim';

export type StimulusKind = Weapon | 'unarmed' | 'run' | 'sprint';

export interface Stimulus {
  /** @range 0–3200 @unit m @readBy zombie hearing, panic, audio */
  x: Metres;
  /** @range 0–3200 @unit m @readBy zombie hearing, panic, audio */
  y: Metres;
  /** What made it. @range weapon or gait @unit enum @readBy audio */
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
