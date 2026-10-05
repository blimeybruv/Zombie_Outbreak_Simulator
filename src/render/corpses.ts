// Corpses are paint, not entities. Each death is drawn once into world-space
// buffers composited under the live layer and never touched again, so the cost is
// constant however many accumulate.
//
// Two buffers make the fade: every death goes into a floor buffer at 0.25 and a
// recent buffer at full strength; the recent buffer is faded as a whole every so
// often, so recent deaths read clearly and older ones sink to the floor over about
// 1,200 ticks. Destroyed zombies and dead people share one grey.

import type { SimEvent } from '../sim/state';
import type { Camera } from './camera';
import { CORPSE } from './palette';

const RESOLUTION = 0.5; // buffer pixels per metre
const FLOOR_ALPHA = 0.25;
const FADE_EVERY = 120; // ticks
const FADE_TO = 1200; // ticks for the recent layer to sink to ~5%
const DOT = 1.6; // m

export class CorpseLayer {
  private readonly floor: HTMLCanvasElement;
  private readonly recent: HTMLCanvasElement;
  private lastFade = 0;

  constructor(private readonly size: number) {
    const px = Math.ceil(size * RESOLUTION);
    this.floor = document.createElement('canvas');
    this.recent = document.createElement('canvas');
    for (const c of [this.floor, this.recent]) {
      c.width = px;
      c.height = px;
    }
  }

  /** Paints this frame's deaths, and fades the recent layer as ticks pass. */
  add(events: readonly SimEvent[], tick: number): void {
    const f = this.floor.getContext('2d')!;
    const r = this.recent.getContext('2d')!;
    const [cr, cg, cb] = CORPSE;
    f.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${FLOOR_ALPHA})`;
    r.fillStyle = `rgb(${cr}, ${cg}, ${cb})`;
    const d = DOT * RESOLUTION;
    for (const e of events) {
      if (e.type !== 'simDied' && e.type !== 'zombieDestroyed') continue;
      const x = e.x * RESOLUTION - d / 2, y = e.y * RESOLUTION - d / 2;
      f.fillRect(x, y, d, d);
      r.fillRect(x, y, d, d);
    }
    if (tick - this.lastFade >= FADE_EVERY) {
      const steps = Math.floor((tick - this.lastFade) / FADE_EVERY);
      this.lastFade += steps * FADE_EVERY;
      // Keep k of the alpha per step, so that after FADE_TO ticks about 5% is left.
      const keep = Math.pow(0.05, FADE_EVERY / FADE_TO);
      r.globalCompositeOperation = 'destination-out';
      r.fillStyle = `rgba(0, 0, 0, ${(1 - Math.pow(keep, steps)).toFixed(4)})`;
      r.fillRect(0, 0, this.recent.width, this.recent.height);
      r.globalCompositeOperation = 'source-over';
    }
  }

  draw(g: CanvasRenderingContext2D, cam: Camera, dpr: number): void {
    cam.apply(g, dpr);
    g.imageSmoothingEnabled = cam.scale * dpr < RESOLUTION * 2;
    g.drawImage(this.floor, 0, 0, this.size, this.size);
    g.drawImage(this.recent, 0, 0, this.size, this.size);
    g.imageSmoothingEnabled = true;
  }
}
