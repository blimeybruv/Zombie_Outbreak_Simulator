import { describe, expect, it } from 'vitest';
import { Interpolator } from '../src/render/interpolate';
import type { FrameSnapshot } from '../src/worker/protocol';

function frame(tick: number, sims: [number, number, number][]): FrameSnapshot {
  const simXY = new Float32Array(sims.length * 2);
  const simKind = new Uint8Array(sims.length);
  sims.forEach(([x, y, k], i) => {
    simXY[i * 2] = x;
    simXY[i * 2 + 1] = y;
    simKind[i] = k;
  });
  return { tick, simXY, simKind, zombieXY: new Float32Array(0), zombieKind: new Uint8Array(0) } as unknown as FrameSnapshot;
}

describe('interpolation between ticks', () => {
  it('blends from the previous snapshot to the latest over the time the ticks take', () => {
    const ip = new Interpolator();
    ip.update(frame(10, [[0, 0, 1]]), 1000, 10);
    ip.update(frame(11, [[1, 0, 1]]), 1000, 10); // one tick, 100 ms at 10 ticks a second
    expect(ip.sim[0]).toBeCloseTo(0);
    ip.update(frame(11, [[1, 0, 1]]), 1050, 10);
    expect(ip.sim[0]).toBeCloseTo(0.5);
    ip.update(frame(11, [[1, 0, 1]]), 1200, 10);
    expect(ip.sim[0]).toBeCloseTo(1); // and holds there until the next tick
  });

  it('does not slide someone who appeared or jumped', () => {
    const ip = new Interpolator();
    ip.update(frame(10, [[0, 0, 1], [0, 0, 0]]), 0, 10);
    ip.update(frame(11, [[50, 0, 1], [5, 5, 1]]), 0, 10);
    expect([ip.sim[0], ip.sim[2], ip.sim[3]]).toEqual([50, 5, 5]);
  });

  it('shows the latest positions when paused', () => {
    const ip = new Interpolator();
    ip.update(frame(10, [[0, 0, 1]]), 0, 0);
    ip.update(frame(11, [[1, 0, 1]]), 0, 0);
    expect(ip.sim[0]).toBe(1);
  });
});
