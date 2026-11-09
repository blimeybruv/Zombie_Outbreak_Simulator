import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { ordinaryBuilding, placeYards, proposeYard, yardVisualHash, type YardMap, type YardPiece } from '../src/render/back-lots';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { SHAPE_BOX, SHAPE_CHURCH, SHAPE_L, SHAPE_U } from '../src/worker/protocol';

/** A rectangle, front along the bottom, depth toward +y. */
function rect(w: number, d: number, x = 0, y = 0): number[] {
  return [x, y, x + w, y, x + w, y + d, x, y + d];
}

function inside(px: number, py: number, c: number[]): boolean {
  let hit = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = c[i * 2]!, yi = c[i * 2 + 1]!, xj = c[j * 2]!, yj = c[j * 2 + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function nearestEdge(c: number[], x: number, y: number): number {
  let edge = 0, best = Infinity;
  for (let i = 0; i < 4; i++) {
    const ax = c[i * 2]!, ay = c[i * 2 + 1]!, bx = c[((i + 1) % 4) * 2]!, by = c[((i + 1) % 4) * 2 + 1]!;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (d < best) {
      best = d;
      edge = i;
    }
  }
  return edge;
}

function cornersOf(piece: YardPiece): [number, number][] {
  const hl = piece.len / 2, hw = piece.wid / 2;
  const out: [number, number][] = [];
  for (const su of [1, -1] as const) {
    for (const sv of [1, -1] as const) {
      out.push([piece.x + piece.dx * hl * su + piece.nx * hw * sv, piece.y + piece.dy * hl * su + piece.ny * hw * sv]);
    }
  }
  return out;
}

function idsOf(kind: YardPiece['kind'], limit: number): number[] {
  const plot = rect(22, 16);
  const ids: number[] = [];
  for (let i = 0; ids.length < limit && i < 500; i++) {
    if (proposeYard(i, plot, 11, 0)?.kind === kind) ids.push(i);
  }
  return ids;
}

function worldOf(
  plots: { id: number; corners: number[]; door: [number, number]; shape?: number; armoury?: number; station?: number }[],
  streets: number[] = [],
  lots: number[] = [],
): YardMap {
  const n = Math.max(...plots.map((p) => p.id)) + 1;
  const outlines = new Float32Array(n * 8);
  const shapes = new Uint8Array(n);
  const armoury = new Uint8Array(n);
  const station = new Uint8Array(n);
  const doors: number[] = [];
  shapes.fill(SHAPE_CHURCH);
  for (const p of plots) {
    outlines.set(p.corners, p.id * 8);
    shapes[p.id] = p.shape ?? SHAPE_BOX;
    armoury[p.id] = p.armoury ?? 0;
    station[p.id] = p.station ?? 0;
    doors.push(p.id, p.door[0], p.door[1], 0, -1);
  }
  return {
    size: 800,
    outlines,
    shapes,
    armoury,
    station,
    doors: new Float32Array(doors),
    streets: new Float32Array(streets),
    lots: new Float32Array(lots),
  };
}

describe('back lots', () => {
  it('keeps the hash stable for a handful of ids', () => {
    expect([0, 1, 2, 18, 100, 2638].map(yardVisualHash)).toEqual([
      493009611, 1059954845, 100097173, 1325003930, 1154707898, 3589580199,
    ]);
  });

  it('is a pure function of the building id and its plot', () => {
    const plot = rect(16, 18);
    for (let id = 0; id < 40; id++) expect(proposeYard(id, plot, 8, 0)).toEqual(proposeYard(id, plot, 8, 0));
  });

  it('leaves the specials without scenery', () => {
    expect(ordinaryBuilding(SHAPE_BOX, 0, 0)).toBe(true);
    expect(ordinaryBuilding(SHAPE_CHURCH, 0, 0)).toBe(false);
    expect(ordinaryBuilding(SHAPE_L, 0, 0)).toBe(false);
    expect(ordinaryBuilding(SHAPE_U, 0, 0)).toBe(false);
    expect(ordinaryBuilding(SHAPE_BOX, 1, 0)).toBe(false);
    expect(ordinaryBuilding(SHAPE_BOX, 0, 1)).toBe(false);
    const id = idsOf('dumpster', 1)[0]!;
    const plot = rect(18, 16);
    for (const shape of [SHAPE_CHURCH, SHAPE_L, SHAPE_U]) {
      expect(placeYards(worldOf([{ id, corners: plot, door: [9, 0], shape }]))).toEqual([]);
    }
    expect(placeYards(worldOf([{ id, corners: plot, door: [9, 0], armoury: 1 }]))).toEqual([]);
    expect(placeYards(worldOf([{ id, corners: plot, door: [9, 0], station: 1 }]))).toEqual([]);
  });

  it('sets a dumpster just outside the back wall, inset from the corners', () => {
    const id = idsOf('dumpster', 1)[0]!;
    const plot = rect(18, 16);
    const piece = proposeYard(id, plot, 9, 0);
    expect(piece).not.toBeNull();
    expect(piece!.kind).toBe('dumpster');
    expect(piece!.y).toBeGreaterThan(16);
    expect(Math.abs(piece!.y - 16 - (0.55 + 1.25 / 2))).toBeLessThan(1e-6);
    expect(piece!.x).toBeGreaterThan(1.4);
    expect(piece!.x).toBeLessThan(16.6);
    for (const [x, y] of cornersOf(piece!)) {
      expect(inside(x, y, plot)).toBe(false);
      expect(x).toBeGreaterThan(0.3);
      expect(x).toBeLessThan(17.7);
      expect(y).toBeGreaterThan(16);
    }
  });

  it('uses both kinds, and leaves most plots empty', () => {
    const plot = rect(24, 18);
    let none = 0, dumpsters = 0, benches = 0;
    for (let id = 0; id < 200; id++) {
      const piece = proposeYard(id, plot, 12, 0);
      if (!piece) none++;
      else if (piece.kind === 'dumpster') dumpsters++;
      else benches++;
    }
    expect(none).toBeGreaterThan(150);
    expect(dumpsters).toBeGreaterThan(5);
    expect(benches).toBeGreaterThan(0);
  });

  it('skips a back wall too short to hold the piece', () => {
    const id = idsOf('dumpster', 1)[0]!;
    expect(proposeYard(id, rect(3, 3), 1.5, 0)).toBeNull();
  });

  it('keeps the piece outside a rotated plot', () => {
    const id = idsOf('bench', 1)[0]!;
    const deg = 37 * Math.PI / 180;
    const c = Math.cos(deg), s = Math.sin(deg);
    const turn = (x: number, y: number): [number, number] => [x * c - y * s, x * s + y * c];
    const raw = rect(20, 15);
    const plot: number[] = [];
    for (let i = 0; i < 8; i += 2) plot.push(...turn(raw[i]!, raw[i + 1]!));
    const [dx, dy] = turn(10, 0);
    const piece = proposeYard(id, plot, dx, dy);
    expect(piece).not.toBeNull();
    expect(inside(piece!.x, piece!.y, plot)).toBe(false);
    for (const [x, y] of cornersOf(piece!)) expect(inside(x, y, plot)).toBe(false);
  });

  it('places nothing when another building sits against the back', () => {
    const id = idsOf('dumpster', 1)[0]!;
    const pieces = placeYards(worldOf([
      { id, corners: rect(18, 16), door: [9, 0] },
      { id: id + 80, corners: rect(18, 16, 0, 17.2), door: [9, 33.2], shape: SHAPE_CHURCH },
    ]));
    expect(pieces.find((p) => p.building === id)).toBeUndefined();
  });

  it('places nothing when a street runs across the back yard', () => {
    const id = idsOf('dumpster', 1)[0]!;
    const across = placeYards(worldOf(
      [{ id, corners: rect(18, 16), door: [9, 0] }],
      [-10, 18, 30, 18, 6],
    ));
    expect(across.find((p) => p.building === id)).toBeUndefined();
    const inFront = placeYards(worldOf(
      [{ id, corners: rect(18, 16), door: [9, 0] }],
      [-10, -8, 30, -8, 8],
    ));
    expect(inFront.find((p) => p.building === id)?.kind).toBe('dumpster');
  });

  it('places nothing on a lot', () => {
    const id = idsOf('bench', 1)[0]!;
    const lot = [-2, 15, 24, 15, 24, 40, -2, 40, 0, 0];
    const pieces = placeYards(worldOf([{ id, corners: rect(20, 14), door: [10, 0] }], [], lot));
    expect(pieces).toEqual([]);
  });

  it('keeps one piece when two yards would overlap', () => {
    const [a, b] = idsOf('dumpster', 2);
    const depth = 14, gap = 3.2, w = 4.5;
    const pieces = placeYards(worldOf([
      { id: a!, corners: rect(w, depth), door: [w / 2, 0] },
      { id: b!, corners: rect(w, depth, 0, depth + gap), door: [w / 2, depth + gap + depth] },
    ]));
    expect(pieces.map((p) => p.building)).toEqual([a]);
  });

  it('on map 1, puts pieces only behind ordinary buildings and off the streets', () => {
    const { world } = createWorld({ ...defaultScenario, stalemateController: false }, config);
    const n = world.buildings.length;
    const outlines = new Float32Array(n * 8);
    const shapes = new Uint8Array(n);
    const armoury = new Uint8Array(n);
    const station = new Uint8Array(n);
    const doors: number[] = [];
    world.buildings.forEach((b, i) => {
      b.outline.forEach((p, j) => outlines.set([p.x, p.y], i * 8 + j * 2));
      shapes[i] = b.tag === 'church' ? SHAPE_CHURCH : b.tag === 'hospital' ? SHAPE_L : b.tag === 'school' ? SHAPE_U : SHAPE_BOX;
      armoury[i] = b.weaponStock !== null ? 1 : 0;
      station[i] = b.tag === 'policeStation' ? 1 : 0;
      const e = b.entrances[0];
      if (e) doors.push(i, e.x, e.y, 0, 0);
    });
    const streets = new Float32Array(world.streets.length * 5);
    world.streets.forEach((s, i) => {
      const a = world.nodes[s.a]!, b = world.nodes[s.b]!;
      streets.set([a.x, a.y, b.x, b.y, s.width], i * 5);
    });
    const lots = new Float32Array(world.lots.length * 10);
    world.lots.forEach((l, i) => l.outline.forEach((p, j) => lots.set([p.x, p.y], i * 10 + j * 2)));
    const pieces = placeYards({
      size: world.config.map.size,
      outlines,
      shapes,
      armoury,
      station,
      doors: new Float32Array(doors),
      streets,
      lots,
    });
    expect(pieces.length).toBeGreaterThan(40);
    expect(pieces.length).toBeLessThan(n * 0.12);
    const kinds = new Set(pieces.map((p) => p.kind));
    expect(kinds.has('dumpster')).toBe(true);
    expect(kinds.has('bench')).toBe(true);
    for (const piece of pieces) {
      expect(ordinaryBuilding(shapes[piece.building]!, armoury[piece.building]!, station[piece.building]!)).toBe(true);
      const base = piece.building * 8;
      const plot = Array.from(outlines.subarray(base, base + 8));
      expect(inside(piece.x, piece.y, plot)).toBe(false);
      const door = world.buildings[piece.building]!.entrances[0]!;
      const front = nearestEdge(plot, door.x, door.y);
      expect(nearestEdge(plot, piece.x, piece.y)).toBe((front + 2) % 4);
      for (const [x, y] of cornersOf(piece)) {
        expect(inside(x, y, plot)).toBe(false);
        for (let s = 0; s < streets.length; s += 5) {
          const ax = streets[s]!, ay = streets[s + 1]!, bx = streets[s + 2]!, by = streets[s + 3]!;
          const pad = streets[s + 4]! / 2 + 4;
          if (x < Math.min(ax, bx) - pad || x > Math.max(ax, bx) + pad || y < Math.min(ay, by) - pad || y > Math.max(ay, by) + pad) continue;
          const dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
          const dist = Math.hypot(x - ax - t * dx, y - ay - t * dy);
          expect(dist).toBeGreaterThan(streets[s + 4]! / 2 + 1.15);
        }
      }
    }
  }, 20000);
});
