import { describe, expect, it } from 'vitest';
import { dressBuilding, buildingVisualHash, ordinaryBuilding, roofTone } from '../src/render/building-dress';
import { ROOF } from '../src/render/palette';
import { SHAPE_BOX, SHAPE_CHURCH, SHAPE_L, SHAPE_U } from '../src/worker/protocol';

/** A rectangle, front along +x, depth toward +y. */
function rect(w: number, d: number): number[] {
  return [0, 0, w, 0, w, d, 0, d];
}

function inside(px: number, py: number, c: number[]): boolean {
  let hit = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = c[i * 2]!, yi = c[i * 2 + 1]!, xj = c[j * 2]!, yj = c[j * 2 + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function edgeDist(px: number, py: number, c: number[]): number {
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const ax = c[i * 2]!, ay = c[i * 2 + 1]!, bx = c[((i + 1) % 4) * 2]!, by = c[((i + 1) % 4) * 2 + 1]!;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return best;
}

describe('civilian building dress', () => {
  it('is a pure function of the building id', () => {
    const plot = rect(16, 18);
    const door = [8, 0];
    for (let id = 0; id < 40; id++) {
      expect(dressBuilding(id, plot, door)).toEqual(dressBuilding(id, plot, door));
      expect(roofTone(id)).toBeGreaterThanOrEqual(0);
      expect(roofTone(id)).toBeLessThan(ROOF.length);
    }
  });

  it('keeps the hash stable for a handful of ids', () => {
    expect([0, 1, 2, 18, 100, 2638].map(buildingVisualHash)).toEqual([
      493009611, 1059954845, 100097173, 1325003930, 1154707898, 3589580199,
    ]);
  });

  it('uses every roof tone across a city of ids', () => {
    const tones = new Set<number>();
    for (let id = 0; id < 2000; id++) tones.add(roofTone(id));
    expect(tones.size).toBe(ROOF.length);
  });

  it('leaves the specials undressed', () => {
    expect(ordinaryBuilding(SHAPE_BOX, 0, 0)).toBe(true);
    expect(ordinaryBuilding(SHAPE_CHURCH, 0, 0)).toBe(false);
    expect(ordinaryBuilding(SHAPE_L, 0, 0)).toBe(false);
    expect(ordinaryBuilding(SHAPE_U, 0, 0)).toBe(false);
    expect(ordinaryBuilding(SHAPE_BOX, 1, 0)).toBe(false);
    expect(ordinaryBuilding(SHAPE_BOX, 0, 1)).toBe(false);
  });

  it('puts a window rhythm and a door inside the street face, clear of the door', () => {
    const plot = rect(16, 18);
    const dress = dressBuilding(4, plot, [8, 0, 4, 0]);
    expect(dress.windows.length).toBeGreaterThan(0);
    expect(dress.door).toHaveLength(4);
    for (let i = 0; i < dress.windows.length; i += 4) {
      for (const [px, py] of [[dress.windows[i]!, dress.windows[i + 1]!], [dress.windows[i + 2]!, dress.windows[i + 3]!]]) {
        expect(inside(px!, py!, plot)).toBe(true);
        expect(py).toBeGreaterThan(0.3);
        expect(py).toBeLessThan(2.2);
      }
      const mx = (dress.windows[i]! + dress.windows[i + 2]!) / 2;
      expect(Math.abs(mx - 8)).toBeGreaterThan(1);
      expect(Math.abs(mx - 4)).toBeGreaterThan(1);
    }
    const doorMid = (dress.door[0]! + dress.door[2]!) / 2;
    expect(doorMid).toBeCloseTo(8, 5);
    expect(dress.door[1]!).toBeGreaterThan(0);
    expect(dress.door[1]!).toBeLessThan(0.6);
  });

  it('keeps the same rhythm on a rotated plot', () => {
    const w = 20, d = 14;
    const a = Math.PI / 6;
    const c = Math.cos(a), s = Math.sin(a);
    const p = (x: number, y: number) => [x * c - y * s, x * s + y * c] as const;
    const corners = [...p(0, 0), ...p(w, 0), ...p(w, d), ...p(0, d)];
    const door = p(w / 2, 0);
    const dress = dressBuilding(11, corners, door);
    expect(dress.windows.length).toBeGreaterThan(4);
    for (let i = 0; i < dress.windows.length; i += 2) {
      expect(inside(dress.windows[i]!, dress.windows[i + 1]!, corners)).toBe(true);
      expect(edgeDist(dress.windows[i]!, dress.windows[i + 1]!, corners)).toBeGreaterThan(0.3);
    }
  });

  it('divides a large footprint and leaves a house open', () => {
    const house = rect(14, 16);
    for (let id = 0; id < 30; id++) expect(dressBuilding(id, house, [7, 0]).partitions).toEqual([]);
    let some = 0, none = 0;
    const block = rect(48, 32);
    for (let id = 0; id < 80; id++) {
      const lines = dressBuilding(id, block, [24, 0]).partitions;
      if (lines.length === 0) none++;
      else {
        some++;
        expect(lines.length === 4 || lines.length === 8).toBe(true);
        for (let i = 0; i < lines.length; i += 2) expect(edgeDist(lines[i]!, lines[i + 1]!, block)).toBeGreaterThan(1.2);
      }
    }
    expect(some).toBeGreaterThan(40);
    expect(none).toBeGreaterThan(5);
  });
});
