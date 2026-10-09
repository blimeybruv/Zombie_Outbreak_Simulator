// Positions between ticks. The simulation advances in whole ticks — ten a second at
// 1×, two and a half at 0.25× — and drawing each tick's positions as they arrive
// makes the dots step, which reads as a performance problem when it is not. So the
// drawing runs one snapshot behind and blends from the previous snapshot to the
// latest over the time those ticks take at the current rate.
//
// Only last and current positions are kept. An agent that appeared, went inside or
// jumped (more than MAX_JUMP) is drawn where it is now, not slid there.

import type { FrameSnapshot } from '../worker/protocol';

const MAX_JUMP = 12; // m, as for trails

export class Interpolator {
  private prev: FrameSnapshot | null = null;
  private last: FrameSnapshot | null = null;
  private at = 0; // wall ms the latest tick arrived
  private span = 0; // wall ms the ticks between the two snapshots take
  sim: Float32Array = new Float32Array(0);
  zombie: Float32Array = new Float32Array(0);

  /** Call once per animation frame with the latest snapshot; fills `sim` and `zombie`. */
  update(frame: FrameSnapshot, now: number, ticksPerSecond: number): void {
    if (this.last === null || frame.tick !== this.last.tick) {
      this.prev = this.last;
      this.last = frame;
      this.at = now;
      this.span = this.prev !== null && ticksPerSecond > 0 ? ((frame.tick - this.prev.tick) * 1000) / ticksPerSecond : 0;
    } else {
      this.last = frame; // same tick, fresher kinds and flags
    }
    const t = this.span > 0 ? Math.min(1, (now - this.at) / this.span) : 1;
    this.sim = blend(this.sim, this.prev?.simXY, this.prev?.simKind, frame.simXY, frame.simKind, t);
    this.zombie = blend(this.zombie, this.prev?.zombieXY, this.prev?.zombieKind, frame.zombieXY, frame.zombieKind, t);
  }
}

function blend(
  out: Float32Array,
  pxy: Float32Array | undefined,
  pk: Uint8Array | undefined,
  xy: Float32Array,
  k: Uint8Array,
  t: number,
): Float32Array {
  if (out.length !== xy.length) out = new Float32Array(xy.length);
  for (let i = 0; i < k.length; i++) {
    const x = xy[i * 2]!, y = xy[i * 2 + 1]!;
    if (t < 1 && pxy && pk && i < pk.length && pk[i] && k[i]) {
      const px = pxy[i * 2]!, py = pxy[i * 2 + 1]!;
      if (Math.abs(x - px) + Math.abs(y - py) <= MAX_JUMP) {
        out[i * 2] = px + (x - px) * t;
        out[i * 2 + 1] = py + (y - py) * t;
        continue;
      }
    }
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }
  return out;
}
