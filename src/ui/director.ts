// The director: a curator for the viewer, toggled on (D, or the controls' button). It
// takes the camera to a scene of interest and stays while the dead and the living are
// both there, until a little after the danger subsides or the person it follows is lost
// (dead, turned, indoors); then it finds the next. The user's design.
//
// Scenes come from two places. What the ticker would report — every event worth
// director.minWeight or more by the ticker's own weights (salience.ts BASE), at its
// place, with its person if it has one — offered as it happens. And, with nothing
// offered, what is on screen: where the most living are within director.radius of the
// awake dead. All in ticks, so it watches the same at any speed. Reads snapshots and
// notes only; it moves nothing but the camera.

import { config } from '../config';
import type { SimEvent } from '../sim/state';
import { SIM_FIGHTING, SIM_FLEEING, ZOMBIE_AWAKE, type EventNote, type FrameSnapshot } from '../worker/protocol';
import { BASE, kindOf } from './salience';

export interface Scene {
  x: number;
  y: number;
  /** Where it was offered: a place scene looks at what is happening around here. */
  ax: number;
  ay: number;
  /** The person it follows, if any. */
  sim: number | null;
  /** What it came for, in words (the event's type, or 'on screen'). */
  why: string;
  weight: number;
  /** When it was taken up, when the danger there was last seen, and when its person was lost (ticks; null while not). */
  since: number;
  lastDanger: number;
  lostAt: number | null;
}

interface Offer {
  x: number;
  y: number;
  sim: number | null;
  why: string;
  weight: number;
  tick: number;
}

export class Director {
  enabled = false;
  scene: Scene | null = null;
  private offers: Offer[] = [];

  enable(on: boolean): void {
    this.enabled = on;
    if (!on) this.scene = null;
  }

  /** The events of a snapshot, as offers. */
  offer(events: readonly SimEvent[], notes: readonly (EventNote | null)[], tick: number): void {
    const dc = config.director;
    for (let i = 0; i < events.length; i++) {
      const n = notes[i];
      if (!n) continue;
      const kind = kindOf(events[i]!, n);
      if (kind === null || BASE[kind] < dc.minWeight) continue;
      this.offers.push({ x: n.x, y: n.y, sim: n.sim, why: events[i]!.type, weight: BASE[kind], tick });
    }
    this.offers = this.offers.filter((o) => tick - o.tick <= dc.forget);
  }

  /** Where the camera should look this frame, or null to leave it be. */
  update(frame: FrameSnapshot): { x: number; y: number } | null {
    if (!this.enabled) return null;
    const dc = config.director;
    const tick = frame.tick;
    const s = this.scene;
    if (s !== null) {
      // Follow its person while it is on the map.
      const inSight = s.sim !== null && frame.simKind[s.sim] !== 0;
      if (inSight) {
        s.x = frame.simXY[s.sim! * 2]!;
        s.y = frame.simXY[s.sim! * 2 + 1]!;
      } else if (s.sim === null) {
        // A place (a horde at a building): the middle of who is there, not the building's —
        // out to twice the radius, to reach the doors of a large building from its middle.
        const c = middle(frame, s.ax, s.ay, 2 * config.director.radius);
        if (c !== null) {
          s.x = c.x;
          s.y = c.y;
        }
      }
      if (s.sim !== null && !inSight) s.lostAt ??= tick;
      if (danger(frame, s.x, s.y) > 0 || (s.sim === null && danger(frame, s.ax, s.ay) > 0)) s.lastDanger = tick;
      const held = tick - s.since;
      const calm = tick - s.lastDanger;
      // Its person gone a moment (a third of `after`): nothing left here to watch.
      const lost = s.lostAt !== null && tick - s.lostAt >= dc.after / 3;
      const better = this.offers.some((o) => o.weight > s.weight && o.tick >= s.since);
      const done = held >= dc.minTicks && (calm >= dc.after || lost || (held >= dc.maxTicks && this.offers.length > 0) || (better && calm > 0));
      if (!done) return { x: s.x, y: s.y };
    }
    this.scene = this.next(frame);
    return this.scene === null ? null : { x: this.scene.x, y: this.scene.y };
  }

  /** The best offer still fresh, else the liveliest place on screen. */
  private next(frame: FrameSnapshot): Scene | null {
    const tick = frame.tick;
    let best: Offer | null = null;
    for (const o of this.offers) if (best === null || o.weight > best.weight || (o.weight === best.weight && o.tick > best.tick)) best = o;
    if (best !== null) {
      this.offers = this.offers.filter((o) => o !== best);
      return { x: best.x, y: best.y, ax: best.x, ay: best.y, sim: best.sim, why: best.why, weight: best.weight, since: tick, lastDanger: tick, lostAt: null };
    }
    const hot = liveliest(frame);
    return hot === null ? null : { x: hot.x, y: hot.y, ax: hot.x, ay: hot.y, sim: hot.sim, why: 'on screen', weight: 0, since: tick, lastDanger: tick, lostAt: null };
  }

  /** What it is watching, in words, for the observation check and the controls. */
  focus(): string | null {
    return this.scene === null ? null : this.scene.why;
  }
}

/** The living within director.radius of (x, y) while any of the awake dead are too: 0 when either is missing. */
export function danger(frame: FrameSnapshot, x: number, y: number): number {
  const r = config.director.radius;
  let dead = 0;
  for (let i = 0; i < frame.zombieKind.length; i++) {
    if (frame.zombieKind[i] !== ZOMBIE_AWAKE) continue;
    if (Math.hypot(frame.zombieXY[i * 2]! - x, frame.zombieXY[i * 2 + 1]! - y) <= r) dead++;
  }
  if (dead === 0) return 0;
  let living = 0;
  for (let i = 0; i < frame.simKind.length; i++) {
    if (!frame.simKind[i]) continue;
    if (Math.hypot(frame.simXY[i * 2]! - x, frame.simXY[i * 2 + 1]! - y) <= r) living++;
  }
  return living;
}

/** The person in the most trouble: fighting or fleeing, with the most of the awake dead about them. */
function liveliest(frame: FrameSnapshot): { x: number; y: number; sim: number } | null {
  let best = -1;
  let bestN = 0;
  for (let i = 0; i < frame.simKind.length; i++) {
    if (!frame.simKind[i] || !(frame.simFlags[i]! & (SIM_FIGHTING | SIM_FLEEING))) continue;
    const n = danger(frame, frame.simXY[i * 2]!, frame.simXY[i * 2 + 1]!);
    if (n > bestN) {
      bestN = n;
      best = i;
    }
  }
  return best < 0 ? null : { x: frame.simXY[best * 2]!, y: frame.simXY[best * 2 + 1]!, sim: best };
}

/** The middle of the living and the awake dead within r of (x, y); null with nobody there. */
function middle(frame: FrameSnapshot, x: number, y: number, r: number): { x: number; y: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  const add = (px: number, py: number) => {
    if (Math.hypot(px - x, py - y) > r) return;
    sx += px;
    sy += py;
    n++;
  };
  for (let i = 0; i < frame.zombieKind.length; i++) if (frame.zombieKind[i] === ZOMBIE_AWAKE) add(frame.zombieXY[i * 2]!, frame.zombieXY[i * 2 + 1]!);
  for (let i = 0; i < frame.simKind.length; i++) if (frame.simKind[i]) add(frame.simXY[i * 2]!, frame.simXY[i * 2 + 1]!);
  return n === 0 ? null : { x: sx / n, y: sy / n };
}
