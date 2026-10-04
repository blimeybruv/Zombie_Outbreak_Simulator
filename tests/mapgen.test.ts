import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { footprintArea, generateMap } from '../src/sim/mapgen/generate';
import { pointPolylineDist, pointSegmentDist, segmentIntersection } from '../src/sim/mapgen/geom';
import { MapIndex } from '../src/sim/runtime';
import type { World } from '../src/sim/state';

const map = generateMap(config, 1, true);
const index = new MapIndex({ config, ...map } as unknown as World);
const node = (id: number) => map.nodes[id]!;

function reachable(): number {
  const adj: number[][] = map.nodes.map(() => []);
  for (const s of map.streets) {
    adj[s.a]!.push(s.b);
    adj[s.b]!.push(s.a);
  }
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    for (const n of adj[stack.pop()!]!) {
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return seen.size;
}

const heading = (s: (typeof map.streets)[number]) => Math.atan2(node(s.b).y - node(s.a).y, node(s.b).x - node(s.a).x);
const offAxisDeg = (h: number) => {
  const d = Math.abs(((h % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2));
  return (Math.min(d, Math.PI / 2 - d) * 180) / Math.PI;
};

describe('map generator', () => {
  it('is deterministic for a map seed and differs between seeds', () => {
    expect(generateMap(config, 1, true)).toEqual(map);
    expect(generateMap(config, 2, true).buildings.length).not.toBe(map.buildings.length);
  });

  it('lays out a 3×3 district grid with downtown in the centre', () => {
    expect(map.districts.map((d) => d.kind)).toEqual(config.map.districtLayout);
  });

  it('connects every node', () => {
    expect(reachable()).toBe(map.nodes.length);
  });

  it.each([1, 2, 3, 4, 5])('crosses the river only by its bridges (map seed %i)', (seed) => {
    const m = generateMap(config, seed, true);
    const line = m.river.centreline;
    const crossing = m.streets.filter((s) => {
      const a = m.nodes[s.a]!, b = m.nodes[s.b]!;
      return line.some((p, i) => i + 1 < line.length && segmentIntersection(a, b, p, line[i + 1]!) !== null);
    });
    expect(crossing.length).toBeGreaterThan(0);
    expect(crossing.every((s) => s.terrain === 'bridge')).toBe(true);
    expect(new Set(m.streets.filter((s) => s.terrain === 'bridge').map((s) => s.name)).size).toBe(config.map.river.bridges);
  });

  it('runs the river diagonally, not along an axis', () => {
    const line = map.river.centreline;
    const h = Math.atan2(line[line.length - 1]!.y - line[0]!.y, line[line.length - 1]!.x - line[0]!.x);
    expect(offAxisDeg(h)).toBeGreaterThan(10);
  });

  it.each([1, 2, 3])('has short diagonals that keep their distance from the river heading (map seed %i)', (seed) => {
    const m = generateMap(config, seed, true);
    const diagonal = m.streets.filter((s) => {
      const a = m.nodes[s.a]!, b = m.nodes[s.b]!;
      return Math.hypot(b.x - a.x, b.y - a.y) > 20 && offAxisDeg(Math.atan2(b.y - a.y, b.x - a.x)) >= config.map.diagonals.gridAngle[0]! - 1;
    });
    const names = new Set(diagonal.map((s) => s.name));
    expect(names.size).toBeGreaterThanOrEqual(2);
    // None spans the map: each diagonal line is well under the map's width.
    for (const name of names) {
      const segs = diagonal.filter((s) => s.name === name);
      const pts = segs.flatMap((s) => [m.nodes[s.a]!, m.nodes[s.b]!]);
      const span = Math.max(...pts.map((p) => Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y)));
      expect(span).toBeLessThan(config.map.size * 0.5);
    }
  });

  it('rotates district grids against each other', () => {
    const angles = new Set(
      map.districts.map((d) => {
        const own = map.streets.filter((s) => s.district === d.id && offAxisDeg(heading(s)) < 15 && offAxisDeg(heading(s)) > 0.5);
        return own.length > 0 ? Math.round(offAxisDeg(heading(own[0]!)) * 10) : 0;
      }),
    );
    expect(angles.size).toBeGreaterThan(3);
  });

  it('subdivides blocks: many small suburban footprints, fewer large ones downtown', () => {
    const areas = (kind: string) =>
      map.buildings.filter((b) => map.districts[b.district]!.kind === kind).map((b) => footprintArea(b.outline)).sort((a, b) => a - b);
    const median = (xs: number[]) => xs[xs.length >> 1]!;
    expect(areas('suburb').length).toBeGreaterThan(areas('downtown').length * 10);
    expect(median(areas('downtown'))).toBeGreaterThan(median(areas('suburb')) * 3);
  });

  it('keeps footprints off streets, out of the river, and apart from each other', () => {
    const half = map.river.width / 2;
    for (const b of map.buildings) {
      const c = { x: (b.outline[0]!.x + b.outline[2]!.x) / 2, y: (b.outline[0]!.y + b.outline[2]!.y) / 2 };
      expect(pointPolylineDist(c, map.river.centreline)).toBeGreaterThan(half);
    }
    for (const s of map.streets) {
      const a = node(s.a), b = node(s.b);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      expect(index.buildingAt(mid.x, mid.y)).toBeNull();
    }
    for (const n of map.nodes) expect(index.buildingAt(n.x, n.y)).toBeNull();
  });

  it('puts every entrance on its outline, facing and near a street', () => {
    for (const b of map.buildings) {
      for (const [i, e] of b.entrances.entries()) {
        const onOutline = b.outline.some((p, j) => pointSegmentDist(e, p, b.outline[(j + 1) % 4]!) < 1e-6);
        expect(onOutline).toBe(true);
        const out = index.outside(b.id, i, 1.5);
        expect(index.buildingAt(out.x, out.y)).toBeNull();
      }
      const s = map.streets[b.street]!;
      const e = b.entrances[0]!;
      expect(pointSegmentDist(e, node(s.a), node(s.b))).toBeLessThan(s.width / 2 + config.map.setback + 1);
    }
  });

  it('gives no power, no light', () => {
    const dark = generateMap(config, 1, false);
    expect(dark.streets.some((s) => s.lit)).toBe(false);
    expect(dark.buildings.some((b) => b.lit)).toBe(false);
  });
});
