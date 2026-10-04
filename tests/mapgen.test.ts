import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { generateMap } from '../src/sim/mapgen/generate';
import { MapIndex } from '../src/sim/runtime';
import type { World } from '../src/sim/state';

const map = generateMap(config, 1, true);

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

describe('map generator', () => {
  it('is deterministic for a map seed and differs between seeds', () => {
    expect(generateMap(config, 1, true)).toEqual(map);
    expect(generateMap(config, 2, true).buildings.length).not.toBe(map.buildings.length);
  });

  it('lays out a 3×3 district grid with downtown in the centre', () => {
    expect(map.districts.map((d) => d.kind)).toEqual(config.map.districtLayout);
  });

  it('connects every node, across the river only by three bridges', () => {
    expect(reachable()).toBe(map.nodes.length);
    expect(map.streets.filter((s) => s.terrain === 'bridge')).toHaveLength(config.map.river.bridges);
    const lo = map.river.outline[0]!.y;
    const hi = map.river.outline[2]!.y;
    const crossing = map.streets.filter((s) => {
      const ya = map.nodes[s.a]!.y;
      const yb = map.nodes[s.b]!.y;
      return Math.min(ya, yb) < lo && Math.max(ya, yb) > hi;
    });
    expect(crossing.every((s) => s.terrain === 'bridge')).toBe(true);
  });

  it('keeps buildings off streets and out of the river, with entrances on their outline', () => {
    const world = { config, ...map } as unknown as World;
    const index = new MapIndex(world);
    expect(map.buildings.length).toBeGreaterThan(500);
    for (const b of map.buildings) {
      const minY = index.bMinY[b.id]!;
      const maxY = index.bMaxY[b.id]!;
      expect(maxY <= index.riverLo || minY >= index.riverHi).toBe(true);
      for (const e of b.entrances) {
        const onX = e.x === index.bMinX[b.id] || e.x === index.bMaxX[b.id];
        const onY = e.y === minY || e.y === maxY;
        expect(onX || onY).toBe(true);
      }
    }
    for (const n of map.nodes) expect(index.buildingAt(n.x, n.y)).toBeNull();
  });

  it('gives no power, no light', () => {
    const dark = generateMap(config, 1, false);
    expect(dark.streets.some((s) => s.lit)).toBe(false);
    expect(dark.buildings.some((b) => b.lit)).toBe(false);
  });
});
