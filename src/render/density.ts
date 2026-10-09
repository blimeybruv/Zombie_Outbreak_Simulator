// Far zoom: no individuals, a weather map. The living and the dead are binned on a
// coarse grid and drawn blurred — white where people are, red where the dead walk —
// so a whole district's fortunes read at a glance.

import type { FrameSnapshot } from '../worker/protocol';
import { SIM_HIDDEN, ZOMBIE_HIDDEN } from '../worker/protocol';
import type { Camera } from './camera';

const CELL = 80; // m (the user's look note: an 80 m blurred weather map)
const SATURATE = 12; // agents in a cell at full strength
// The blur is done on a small canvas, BLUR_PX pixels per cell, then scaled up with
// smoothing: blurring at screen resolution every frame cost more than everything
// else drawn at mid zoom (11 fps against 30 in the build container).
const BLUR_PX = 4;
const BLUR_RADIUS = 0.45; // cells

export class DensityField {
  private readonly cols: number;
  private readonly living: Float32Array;
  private readonly dead: Float32Array;
  private readonly image: HTMLCanvasElement;
  private readonly blurred: HTMLCanvasElement;
  private readonly pixels: ImageData;

  constructor(size: number) {
    this.cols = Math.ceil(size / CELL);
    this.living = new Float32Array(this.cols * this.cols);
    this.dead = new Float32Array(this.cols * this.cols);
    this.image = document.createElement('canvas');
    this.image.width = this.cols;
    this.image.height = this.cols;
    this.pixels = this.image.getContext('2d')!.createImageData(this.cols, this.cols);
    this.blurred = document.createElement('canvas');
    this.blurred.width = this.cols * BLUR_PX;
    this.blurred.height = this.cols * BLUR_PX;
  }

  private bin(target: Float32Array, xy: Float32Array, kinds: Uint8Array, hidden: number): void {
    target.fill(0);
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] === hidden) continue;
      const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(xy[i * 2]! / CELL)));
      const cy = Math.min(this.cols - 1, Math.max(0, Math.floor(xy[i * 2 + 1]! / CELL)));
      target[cy * this.cols + cx]!++;
    }
  }

  /** `strength` scales the whole field: 1 at far zoom, fainter as an underlay at mid zoom. */
  draw(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number, strength = 1): void {
    this.bin(this.living, frame.simXY, frame.simKind, SIM_HIDDEN);
    this.bin(this.dead, frame.zombieXY, frame.zombieKind, ZOMBIE_HIDDEN);
    const px = this.pixels.data;
    for (let i = 0; i < this.living.length; i++) {
      const l = Math.min(1, this.living[i]! / SATURATE);
      const d = Math.min(1, this.dead[i]! / SATURATE);
      const a = Math.max(l, d);
      // Mix toward red where the dead outnumber the living.
      const share = l + d > 0 ? d / (l + d) : 0;
      px[i * 4] = 225 - 45 * share;
      px[i * 4 + 1] = 232 - 180 * share;
      px[i * 4 + 2] = 240 - 175 * share;
      // The living as a pale haze, the dead stronger: the run reads as white draining to red.
      px[i * 4 + 3] = Math.round(255 * Math.sqrt(a) * (0.28 + 0.42 * share));
    }
    this.image.getContext('2d')!.putImageData(this.pixels, 0, 0);
    const b = this.blurred.getContext('2d')!;
    b.clearRect(0, 0, this.blurred.width, this.blurred.height);
    b.imageSmoothingEnabled = true;
    b.filter = `blur(${BLUR_RADIUS * BLUR_PX}px)`;
    b.drawImage(this.image, 0, 0, this.blurred.width, this.blurred.height);
    b.filter = 'none';
    cam.apply(g, dpr);
    g.imageSmoothingEnabled = true;
    g.globalAlpha = strength;
    g.drawImage(this.blurred, 0, 0, this.cols * CELL, this.cols * CELL);
    g.globalAlpha = 1;
  }
}
