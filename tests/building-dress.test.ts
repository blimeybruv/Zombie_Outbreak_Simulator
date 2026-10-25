import { describe, expect, it } from 'vitest';
import { buildingVisualHash, dressBuilding, ordinaryBuilding } from '../src/render/building-dress';
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
    for (let id = 0; id < 40; id++) expect(dressBuilding(id, plot)).toEqual(dressBuilding(id, plot));
  });

  it('keeps the hash stable for a handful of ids', () => {
    expect([0, 1, 2, 18, 100, 2638].map(buildingVisualHash)).toEqual([
      493009611, 1059954845, 100097173, 1325003930, 1154707898, 3589580199,
    ]);
  });

  it('leaves the specials undressed', () => {
    expect(ordinaryBuilding(SHAPE_BOX, 0, 0)).toBe(true);
    expect(ordinaryBuilding(SHAPE_CHURCH, 0, 0)).toBe(false);
    expect(ordinaryBuilding(SHAPE_L, 0, 0)).toBe(false);
    expect(ordinaryBuilding(SHAPE_U, 0, 0)).toBe(false);
    expect(ordinaryBuilding(SHAPE_BOX, 1, 0)).toBe(false);
    expect(ordinaryBuilding(SHAPE_BOX, 0, 1)).toBe(false);
  });

  it('draws one ridge inside the roof, short of the walls', () => {
    const plot = rect(16, 20);
    const line = dressBuilding(4, plot);
    expect(line).toHaveLength(4);
    for (let i = 0; i < 4; i += 2) {
      expect(inside(line[i]!, line[i + 1]!, plot)).toBe(true);
      expect(edgeDist(line[i]!, line[i + 1]!, plot)).toBeGreaterThan(1.2);
    }
    const horizontal = Math.abs(line[1]! - line[3]!) < 1e-6;
    const vertical = Math.abs(line[0]! - line[2]!) < 1e-6;
    expect(horizontal || vertical).toBe(true);
    if (horizontal) {
      expect(line[1]!).toBeGreaterThan(20 * 0.4);
      expect(line[1]!).toBeLessThan(20 * 0.6);
    } else {
      expect(line[0]!).toBeGreaterThan(16 * 0.4);
      expect(line[0]!).toBeLessThan(16 * 0.6);
    }
  });

  it('varies the ridge’s direction and its offset', () => {
    const plot = rect(24, 18);
    let along = 0, across = 0;
    const places = new Set<string>();
    for (let id = 0; id < 80; id++) {
      const line = dressBuilding(id, plot);
      expect(line).toHaveLength(4);
      const horizontal = Math.abs(line[1]! - line[3]!) < 1e-6;
      if (horizontal) {
        along++;
        places.add(line[1]!.toFixed(2));
      } else {
        across++;
        places.add(line[0]!.toFixed(2));
      }
    }
    expect(along).toBeGreaterThan(20);
    expect(across).toBeGreaterThan(20);
    expect(places.size).toBeGreaterThan(8);
  });

  it('keeps the ridge inside a rotated plot', () => {
    const w = 20, d = 14;
    const a = Math.PI / 6;
    const c = Math.cos(a), s = Math.sin(a);
    const p = (x: number, y: number) => [x * c - y * s, x * s + y * c] as const;
    const corners = [...p(0, 0), ...p(w, 0), ...p(w, d), ...p(0, d)];
    const line = dressBuilding(11, corners);
    expect(line).toHaveLength(4);
    for (let i = 0; i < 4; i += 2) {
      expect(inside(line[i]!, line[i + 1]!, corners)).toBe(true);
      expect(edgeDist(line[i]!, line[i + 1]!, corners)).toBeGreaterThan(1);
    }
  });

  it('skips a footprint too small for a ridge', () => {
    expect(dressBuilding(3, rect(6, 6))).toEqual([]);
  });
});
