// Motion trails: a couple of seconds of fading history behind each dot, so panic
// shows as a shape and a crowd fleeing a breach shows as flow. Drawn at near zoom.
//
// Positions are sampled from snapshots on a wall-clock cadence (trail length is
// what the eye sees, whatever the speed), into a ring per agent. Segments are
// batched by age, so drawing costs a fixed number of stroke calls.

import type { Camera } from './camera';

export const SAMPLES = 12;
const SAMPLE_MS = 160; // ~2 s of history at SAMPLES
const MAX_JUMP = 12; // m; longer steps are someone appearing or going inside, not motion

export class Trails {
  private xy = new Float32Array(0);
  private seen = new Uint8Array(0); // per agent per sample: was it on the map
  private head = 0; // index of the newest sample
  private filled = 0;
  private lastSample = -Infinity;
  private lastTick = -1;

  /** Records the snapshot's positions if enough wall time has passed. */
  sample(xy: Float32Array, kinds: Uint8Array, tick: number, wallMs: number): void {
    if (tick === this.lastTick || wallMs - this.lastSample < SAMPLE_MS) return;
    this.lastTick = tick;
    this.lastSample = wallMs;
    const n = kinds.length;
    if (this.seen.length < n * SAMPLES) this.grow(n);
    this.head = (this.head + 1) % SAMPLES;
    this.filled = Math.min(SAMPLES, this.filled + 1);
    for (let i = 0; i < n; i++) {
      const k = i * SAMPLES + this.head;
      this.seen[k] = kinds[i] === 0 ? 0 : 1;
      this.xy[k * 2] = xy[i * 2]!;
      this.xy[k * 2 + 1] = xy[i * 2 + 1]!;
    }
  }

  private grow(n: number): void {
    const cap = Math.max(n, (this.seen.length / SAMPLES) * 2, 256);
    const xy = new Float32Array(cap * SAMPLES * 2);
    const seen = new Uint8Array(cap * SAMPLES);
    xy.set(this.xy);
    seen.set(this.seen);
    this.xy = xy;
    this.seen = seen;
  }

  /**
   * Draws up to `maxAge` samples of history (the full ring by default), at `alpha` for
   * the newest segment, for every agent or only the ids in `only`.
   */
  draw(
    g: CanvasRenderingContext2D,
    cam: Camera,
    dpr: number,
    rgb: readonly [number, number, number],
    width: number,
    maxAge = SAMPLES,
    alpha = 0.35,
    only?: readonly number[],
  ): void {
    if (this.filled < 2) return;
    const n = this.seen.length / SAMPLES;
    const view = { a: cam.toWorld(0, 0), b: cam.toWorld(cam.width, cam.height) };
    cam.apply(g, dpr);
    g.lineWidth = width / (cam.scale * dpr);
    g.lineCap = 'round';
    for (let age = 1; age < Math.min(this.filled, maxAge); age++) {
      const newer = (this.head - age + 1 + SAMPLES) % SAMPLES;
      const older = (this.head - age + SAMPLES) % SAMPLES;
      const path = new Path2D();
      let any = false;
      const count = only ? only.length : n;
      for (let j = 0; j < count; j++) {
        const i = only ? only[j]! : j;
        if (i >= n) continue;
        const kn = i * SAMPLES + newer, ko = i * SAMPLES + older;
        if (!this.seen[kn] || !this.seen[ko]) continue;
        const x1 = this.xy[kn * 2]!, y1 = this.xy[kn * 2 + 1]!, x0 = this.xy[ko * 2]!, y0 = this.xy[ko * 2 + 1]!;
        if (x1 < view.a.x || x1 > view.b.x || y1 < view.a.y || y1 > view.b.y) continue;
        if (Math.abs(x1 - x0) + Math.abs(y1 - y0) > MAX_JUMP) continue;
        path.moveTo(x0, y0);
        path.lineTo(x1, y1);
        any = true;
      }
      if (!any) continue;
      g.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(alpha * (1 - age / SAMPLES)).toFixed(3)})`;
      g.stroke(path);
    }
  }
}
