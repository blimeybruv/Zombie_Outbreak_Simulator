// The ticker: a filtering problem, not a logging problem. Thousands of events, a
// handful of lines. Scoring is in salience.ts; this shows what passes. The largest
// events drop the speed back to 1×. Every line is a button that centres on (and
// follows) its subject.

import type { SimEvent } from '../sim/state';
import type { EventNote } from '../worker/protocol';
import { line } from './copy';
import { BASE, MAJOR, Salience } from './salience';

const SHOWN = 8;
const LINE_LIFE_MS = 30_000;

export interface TickerOptions {
  /** Whether a world point is on screen. */
  inView: (x: number, y: number) => boolean;
  onSelect: (note: EventNote) => void;
  /** Called for events big enough to drop playback to 1×. */
  onMajor: () => void;
}

export class Ticker {
  private readonly salience = new Salience();
  private readonly lines: { el: HTMLElement; at: number }[] = [];
  /** Lines shown so far, for measuring the gate (fewer than 6 per second at 1×). */
  shownCount = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: TickerOptions,
  ) {}

  /** Scores this frame's events and shows the ones that clear the bar at this speed. */
  take(events: readonly SimEvent[], notes: readonly (EventNote | null)[], speed: number, wallMs: number): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!, n = notes[i];
      if (!n) continue;
      const kind = this.salience.pass(e, n, speed, this.options.inView(n.x, n.y));
      if (kind === null) continue;
      const text = line(e, n);
      if (text === null) continue;
      this.show(text, n, wallMs);
      if (BASE[kind] >= MAJOR) this.options.onMajor();
    }
    this.expire(wallMs);
  }

  private show(text: string, note: EventNote, wallMs: number): void {
    const el = document.createElement('button');
    el.className = 'line';
    el.textContent = text;
    if (note.district) {
      const d = document.createElement('span');
      d.className = 'where';
      d.textContent = ` ${note.district}`;
      el.append(d);
    }
    el.addEventListener('click', () => this.options.onSelect(note));
    this.root.prepend(el);
    this.lines.unshift({ el, at: wallMs });
    this.shownCount++;
    while (this.lines.length > SHOWN) this.lines.pop()!.el.remove();
  }

  private expire(wallMs: number): void {
    for (const l of this.lines) l.el.style.opacity = String(Math.max(0.25, 1 - (wallMs - l.at) / LINE_LIFE_MS));
  }
}
