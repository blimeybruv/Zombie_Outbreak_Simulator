// A development frame counter: frames per second, the worst frame, the main
// thread's draw time, and the simulation's achieved tick rate against its target —
// at 8× the simulation, not the drawing, is the likelier limit. Updated twice a
// second over the last second's frames. On by default under the dev server; F
// toggles it; ?fps shows it in a built page.

import type { FrameSnapshot } from '../worker/protocol';

const WINDOW_MS = 1000;
const REFRESH_MS = 500;

export class FrameCounter {
  private readonly frames: { at: number; interval: number; draw: number }[] = [];
  private last = 0;
  private shownAt = 0;
  private visible: boolean;

  constructor(
    private readonly el: HTMLElement,
    visible: boolean,
  ) {
    this.visible = visible;
    this.el.hidden = !visible;
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.key.toLowerCase() !== 'f' || e.ctrlKey || e.metaKey) return;
      this.visible = !this.visible;
      this.el.hidden = !this.visible;
    });
  }

  /** Call once per animation frame with its timestamp and the time spent drawing it. */
  tick(now: number, drawMs: number, frame: FrameSnapshot | null, targetRate: number): void {
    if (this.last > 0) this.frames.push({ at: now, interval: now - this.last, draw: drawMs });
    this.last = now;
    while (this.frames.length > 0 && now - this.frames[0]!.at > WINDOW_MS) this.frames.shift();
    if (!this.visible || now - this.shownAt < REFRESH_MS || this.frames.length === 0) return;
    this.shownAt = now;

    const span = this.frames.reduce((a, f) => a + f.interval, 0);
    const fps = (this.frames.length / span) * 1000;
    const worst = Math.max(...this.frames.map((f) => f.interval));
    const draw = this.frames.reduce((a, f) => a + f.draw, 0) / this.frames.length;
    const sim = frame ? (targetRate > 0 ? `${frame.achievedRate}/${targetRate} ticks/s` : 'paused') : '—';
    this.el.textContent = `${fps.toFixed(0)} fps · worst ${worst.toFixed(0)} ms · draw ${draw.toFixed(1)} ms · sim ${sim}`;
    this.el.classList.toggle('slow', fps < 30 || (targetRate > 0 && frame !== null && frame.achievedRate < targetRate * 0.9));
  }
}
