import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';

// The cordon seals the city only if the exits are the only ways out of it. Checked on
// the street graph and on walkability, not by eye: blocking a segment of a connected
// network blocks nothing, and someone in flight steers without ever consulting the graph.

describe('the city edge', () => {
  for (const mapSeed of [1, 2, 3]) {
    describe(`map ${mapSeed}`, () => {
      const { world, ctx } = createWorld({ ...defaultScenario, mapSeed, runSeed: 1 }, config);
      const m = world.border.margin, size = config.map.size;
      const inCity = (p: { x: number; y: number }) => p.x >= m - 0.5 && p.y >= m - 0.5 && p.x <= size - m + 0.5 && p.y <= size - m + 0.5;
      const exitStreets = new Set<number>(world.exits.map((e) => e.street));

      it('leaves the margin empty: no buildings, no parked cars, no streets but the exits', () => {
        expect(world.buildings.filter((b) => !b.outline.every(inCity))).toEqual([]);
        expect(world.cars.filter((c) => !inCity(c))).toEqual([]);
        expect(world.streets.filter((s) => !exitStreets.has(s.id) && !(inCity(world.nodes[s.a]!) && inCity(world.nodes[s.b]!)))).toEqual([]);
      });

      it('carries every exit across the margin to the map edge, on a highway', () => {
        expect(world.exits.length).toBe(config.map.exits.count);
        for (const e of world.exits) {
          expect(Math.min(e.x, e.y, size - e.x, size - e.y)).toBeLessThan(0.5);
          expect(world.streets[e.street]!.width).toBeGreaterThanOrEqual(config.map.streetWidth.main);
        }
      });

      it('with every exit blocked, no path leads from inside the city to the map edge', () => {
        const blocked = (id: number) => exitStreets.has(id);
        const seen = new Uint8Array(world.nodes.length);
        const stack = world.nodes.filter(inCity).map((n) => n.id as number);
        for (const n of stack) seen[n] = 1;
        while (stack.length > 0) {
          const n = stack.pop()!;
          for (const adj of ctx.map.adjacency[n]!) {
            if (blocked(adj.street) || seen[adj.node]) continue;
            seen[adj.node] = 1;
            stack.push(adj.node);
          }
        }
        expect(world.nodes.filter((n) => seen[n.id] && !inCity(n))).toEqual([]);
      });

      it('is impassable to steering beyond the ring road, but on the exits', () => {
        const kerb = m - config.map.streetWidth.standard / 2;
        const onStub = (x: number, y: number) =>
          world.exits.some((e) => {
            const s = world.streets[e.street]!;
            const a = world.nodes[s.a]!, b = world.nodes[s.b]!;
            const dx = b.x - a.x, dy = b.y - a.y;
            const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
            return Math.hypot(x - a.x - dx * t, y - a.y - dy * t) <= s.width / 2;
          });
        const leaks: [number, number][] = [];
        for (let x = -20; x <= size + 20; x += 9) {
          for (let y = -20; y <= size + 20; y += 9) {
            if (x >= kerb && y >= kerb && x <= size - kerb && y <= size - kerb) continue; // the city
            if (ctx.map.walkable(x, y) && !onStub(x, y)) leaks.push([x, y]);
          }
        }
        expect(leaks).toEqual([]);
        // And the stubs themselves can be walked, all the way to the edge.
        for (const e of world.exits) expect(ctx.map.walkable(e.x - e.dx * 2, e.y - e.dy * 2)).toBe(true);
      });
    });
  }
});
