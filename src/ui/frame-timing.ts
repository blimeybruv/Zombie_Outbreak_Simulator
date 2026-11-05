// Where each frame's time goes, for the frame check (scripts/frame-check.ts). Every
// animation frame closes an interval: the gap since the frame before, and all the main
// thread's timed work done in it, by phase — the frame's own (advance, director, draw,
// selection, counter) and every snapshot taken in meanwhile (ingest, ticker, offers,
// history, panels, audio) — with the worker's time behind the newest snapshot. What the
// phases do not cover is the browser's own: garbage collection, compositing, waiting for
// the display. A ring of recent intervals, read through window.__view; a few clock reads
// a frame, so it is always on.

import type { WorkerPerf } from '../worker/protocol';

export const PHASES = ['ingest', 'ticker', 'offers', 'history', 'panels', 'audio', 'advance', 'director', 'draw', 'selection', 'counter'] as const;
export type Phase = (typeof PHASES)[number];

export interface FrameTime {
  /** When the interval ended (a frame began), and its length (ms). */
  at: number;
  gap: number;
  /** Main-thread ms by phase in the interval. */
  ms: Record<Phase, number>;
  /** Snapshots taken in during it, and the newest one's worker time. */
  snapshots: number;
  worker: WorkerPerf | null;
  /** Living and dead on the map at its end. */
  agents: number;
  /** The renderer's own time by layer in the interval (renderer.ts layerMs), within `draw`. */
  layers: Record<string, number>;
}

const KEEP = 4000;
const zero = (): Record<Phase, number> => Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>;

export class FrameTiming {
  readonly frames: FrameTime[] = [];
  private ms = zero();
  private snapshots = 0;
  private worker: WorkerPerf | null = null;
  private layers: Record<string, number> = {};
  private last = 0;

  /** Runs `f`, adding its time to the current interval's `phase`. */
  time<T>(phase: Phase, f: () => T): T {
    const t0 = performance.now();
    const out = f();
    this.ms[phase] += performance.now() - t0;
    return out;
  }

  /** A draw's time by layer. */
  drew(layers: Readonly<Record<string, number>>): void {
    for (const k in layers) this.layers[k] = (this.layers[k] ?? 0) + layers[k]!;
  }

  /** A snapshot came in, with the worker's time behind it. */
  snapshot(worker: WorkerPerf): void {
    this.snapshots++;
    this.worker = worker;
  }

  /** An animation frame begins: the interval since the last one is closed. */
  frame(now: number, agents: number): void {
    if (this.last > 0) {
      this.frames.push({ at: now, gap: now - this.last, ms: this.ms, snapshots: this.snapshots, worker: this.worker, agents, layers: this.layers });
      if (this.frames.length > KEEP) this.frames.shift();
    }
    this.ms = zero();
    this.snapshots = 0;
    this.worker = null;
    this.layers = {};
    this.last = now;
  }
}
