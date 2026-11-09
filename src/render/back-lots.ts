// A little furniture in the ground behind an ordinary building: one dumpster
// or one bench, or nothing. The plot itself stays an empty outline. Which it
// is, and where along the back wall it sits, come from a hash of the building
// id — render only, not a draw from the run — so the fingerprint does not move.
//
// The piece stands just off the back wall, the side opposite the front door,
// and only where that ground is clear: not inside a footprint, not on a street
// (an alley counts), not on a mall's grounds or a station or hospital yard, and
// not on top of another piece. Churches, hospitals, schools, the armoury and
// police stations are left alone.

import { SHAPE_BOX } from '../worker/protocol';

/** A fixed hash of a building id. Render only: not the run's stream. */
export function yardVisualHash(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Shape 0 is a plain plot. An armoury or a station keeps its own mark. */
export function ordinaryBuilding(shape: number, armoury: number, station: number): boolean {
  return shape === SHAPE_BOX && armoury === 0 && station === 0;
}

export type YardKind = 'dumpster' | 'bench';

/** One piece of back-lot scenery, in metres. `(dx, dy)` runs with the back wall; `(nx, ny)` points away from the building. */
export interface YardPiece {
  building: number;
  kind: YardKind;
  x: number;
  y: number;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  len: number;
  wid: number;
}

const DUMPSTER_LEN = 2.15;
const DUMPSTER_WID = 1.25;
const DUMPSTER_GAP = 0.55; // the near face, off the wall
const BENCH_LEN = 2.2;
const BENCH_WID = 0.72;
const BENCH_GAP = 0.9;
const END_MARGIN = 0.45; // short of each end of the back wall
const OPEN_GROUND = 2.4; // metres of yard behind the wall, or nothing is placed
const STREET_KEEP = 1.2; // metres beyond a carriageway, alleys included
const PIECE_GAP = 0.5; // metres between two pieces
const CELL = 48;

/**
 * The piece this building would carry, before the yard is checked. Null when
 * the hash says none, or the back wall is too short to hold it. `doorX, doorY`
 * is the front entrance, on the wall.
 */
export function proposeYard(id: number, corners: ArrayLike<number>, doorX: number, doorY: number): YardPiece | null {
  // Nine in ten plots stay bare. Of the rest, dumpsters outnumber benches.
  const slot = yardVisualHash(id) % 30;
  if (slot < 27) return null;
  const kind: YardKind = slot === 29 ? 'bench' : 'dumpster';
  const len = kind === 'dumpster' ? DUMPSTER_LEN : BENCH_LEN;
  const wid = kind === 'dumpster' ? DUMPSTER_WID : BENCH_WID;
  const gap = kind === 'dumpster' ? DUMPSTER_GAP : BENCH_GAP;
  const edge = nearestEdge(corners, doorX, doorY);
  const back = (edge + 2) % 4;
  const ax = corners[back * 2]!, ay = corners[back * 2 + 1]!;
  const bx = corners[((back + 1) % 4) * 2]!, by = corners[((back + 1) % 4) * 2 + 1]!;
  const span = Math.hypot(bx - ax, by - ay);
  const inset = len / 2 + END_MARGIN;
  if (span < inset * 2) return null;
  const dx = (bx - ax) / span, dy = (by - ay) / span;
  let nx = -dy, ny = dx;
  let cx = 0, cy = 0;
  for (let i = 0; i < 4; i++) {
    cx += corners[i * 2]!;
    cy += corners[i * 2 + 1]!;
  }
  cx /= 4;
  cy /= 4;
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  if (nx * (mx - cx) + ny * (my - cy) < 0) {
    nx = -nx;
    ny = -ny;
  }
  const h = yardVisualHash(id);
  let t = 0.28 + ((h >>> 8) % 45) / 100; // 0.28–0.72 along the wall
  const tMin = inset / span;
  t = Math.max(tMin, Math.min(1 - tMin, t));
  const px = ax + (bx - ax) * t;
  const py = ay + (by - ay) * t;
  const off = gap + wid / 2;
  return {
    building: id,
    kind,
    x: px + nx * off,
    y: py + ny * off,
    dx,
    dy,
    nx,
    ny,
    len,
    wid,
  };
}

export interface YardMap {
  size: number;
  outlines: ArrayLike<number>;
  shapes: ArrayLike<number>;
  armoury: ArrayLike<number>;
  station: ArrayLike<number>;
  /** Per entrance: building index, x, y, nx, ny. The first one of a building is its front door. */
  doors: ArrayLike<number>;
  /** Per street: ax, ay, bx, by, width. */
  streets: ArrayLike<number>;
  /** Per lot: four corners, then parking depth and the driveway's entry. */
  lots: ArrayLike<number>;
}

/** The pieces that survive: open rear ground only, in building-id order. */
export function placeYards(map: YardMap): YardPiece[] {
  const n = map.outlines.length / 8;
  const doorAt = new Float32Array(n * 2);
  const hasDoor = new Uint8Array(n);
  for (let i = 0; i < map.doors.length; i += 5) {
    const b = map.doors[i]!;
    if (b < 0 || b >= n || hasDoor[b]) continue;
    hasDoor[b] = 1;
    doorAt[b * 2] = map.doors[i + 1]!;
    doorAt[b * 2 + 1] = map.doors[i + 2]!;
  }
  const cols = Math.max(1, Math.ceil(map.size / CELL));
  const buildings = bins(cols);
  const streets = bins(cols);
  const lots = bins(cols);
  for (let i = 0; i < n; i++) coverQuad(buildings, cols, map.outlines, i * 8, 0, i);
  for (let i = 0; i < map.streets.length; i += 5) {
    const ax = map.streets[i]!, ay = map.streets[i + 1]!, bx = map.streets[i + 2]!, by = map.streets[i + 3]!;
    const pad = map.streets[i + 4]! / 2 + STREET_KEEP + 0.5;
    coverBox(streets, cols, Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad, i / 5);
  }
  for (let i = 0; i < map.lots.length; i += 10) coverQuad(lots, cols, map.lots, i, 0, i / 10);

  const placed: YardPiece[] = [];
  const taken = bins(cols);
  for (let i = 0; i < n; i++) {
    if (!hasDoor[i] || !ordinaryBuilding(map.shapes[i]!, map.armoury[i]!, map.station[i]!)) continue;
    const base = i * 8;
    const piece = proposeYard(i, [
      map.outlines[base]!, map.outlines[base + 1]!, map.outlines[base + 2]!, map.outlines[base + 3]!,
      map.outlines[base + 4]!, map.outlines[base + 5]!, map.outlines[base + 6]!, map.outlines[base + 7]!,
    ], doorAt[i * 2]!, doorAt[i * 2 + 1]!);
    if (!piece || !yardClear(map, buildings, streets, lots, cols, piece)) continue;
    if (crowded(placed, taken, cols, piece)) continue;
    placed.push(piece);
    const reach = Math.hypot(piece.len, piece.wid) / 2 + PIECE_GAP;
    coverBox(taken, cols, piece.x - reach, piece.y - reach, piece.x + reach, piece.y + reach, placed.length - 1);
  }
  return placed;
}

function yardClear(map: YardMap, buildings: number[][], streets: number[][], lots: number[][], cols: number, piece: YardPiece): boolean {
  const samples = cornersOf(piece);
  samples.push([piece.x, piece.y]);
  // OPEN_GROUND metres out from the wall, past the piece: the yard has to be empty that far.
  const off = piece.kind === 'dumpster' ? DUMPSTER_GAP + DUMPSTER_WID / 2 : BENCH_GAP + BENCH_WID / 2;
  samples.push([piece.x + piece.nx * (OPEN_GROUND - off), piece.y + piece.ny * (OPEN_GROUND - off)]);
  for (const [x, y] of samples) {
    for (const b of buildings[cell(cols, x, y)] ?? []) {
      if (quadHolds(x, y, map.outlines, b * 8)) return false;
    }
    for (const s of streets[cell(cols, x, y)] ?? []) {
      const k = s * 5;
      const dist = segmentDistance(x, y, map.streets[k]!, map.streets[k + 1]!, map.streets[k + 2]!, map.streets[k + 3]!);
      if (dist < map.streets[k + 4]! / 2 + STREET_KEEP) return false;
    }
    for (const lot of lots[cell(cols, x, y)] ?? []) {
      if (quadHolds(x, y, map.lots, lot * 10)) return false;
    }
  }
  return true;
}

function crowded(placed: YardPiece[], taken: number[][], cols: number, piece: YardPiece): boolean {
  const reach = Math.hypot(piece.len, piece.wid) / 2 + PIECE_GAP;
  const seen = new Set<number>();
  const x0 = piece.x - reach, y0 = piece.y - reach, x1 = piece.x + reach, y1 = piece.y + reach;
  const c0 = Math.max(0, Math.floor(x0 / CELL));
  const d0 = Math.max(0, Math.floor(y0 / CELL));
  const c1 = Math.min(cols - 1, Math.floor(x1 / CELL));
  const d1 = Math.min(cols - 1, Math.floor(y1 / CELL));
  for (let y = d0; y <= d1; y++) {
    for (let x = c0; x <= c1; x++) {
      for (const j of taken[y * cols + x] ?? []) {
        if (seen.has(j)) continue;
        seen.add(j);
        if (!separated(placed[j]!, piece, PIECE_GAP)) return true;
      }
    }
  }
  return false;
}

/** True when the two boxes, grown by `gap`, do not meet. */
function separated(a: YardPiece, b: YardPiece, gap: number): boolean {
  const axes: [number, number][] = [[a.dx, a.dy], [a.nx, a.ny], [b.dx, b.dy], [b.nx, b.ny]];
  const cx = b.x - a.x, cy = b.y - a.y;
  for (const [ax, ay] of axes) {
    const dist = Math.abs(cx * ax + cy * ay);
    const ra = Math.abs(a.dx * ax + a.dy * ay) * (a.len / 2) + Math.abs(a.nx * ax + a.ny * ay) * (a.wid / 2);
    const rb = Math.abs(b.dx * ax + b.dy * ay) * (b.len / 2) + Math.abs(b.nx * ax + b.ny * ay) * (b.wid / 2);
    if (dist > ra + rb + gap) return true;
  }
  return false;
}

function cornersOf(piece: YardPiece): [number, number][] {
  const hl = piece.len / 2, hw = piece.wid / 2;
  const out: [number, number][] = [];
  for (const su of [1, -1] as const) {
    for (const sv of [1, -1] as const) {
      out.push([
        piece.x + piece.dx * hl * su + piece.nx * hw * sv,
        piece.y + piece.dy * hl * su + piece.ny * hw * sv,
      ]);
    }
  }
  return out;
}

function nearestEdge(corners: ArrayLike<number>, x: number, y: number): number {
  let edge = 0, best = Infinity;
  for (let i = 0; i < 4; i++) {
    const ax = corners[i * 2]!, ay = corners[i * 2 + 1]!;
    const bx = corners[((i + 1) % 4) * 2]!, by = corners[((i + 1) % 4) * 2 + 1]!;
    const d = segmentDistance(x, y, ax, ay, bx, by);
    if (d < best) {
      best = d;
      edge = i;
    }
  }
  return edge;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function quadHolds(x: number, y: number, p: ArrayLike<number>, base: number): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = p[base + i * 2]!, yi = p[base + i * 2 + 1]!;
    const xj = p[base + j * 2]!, yj = p[base + j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bins(cols: number): number[][] {
  return Array.from({ length: cols * cols }, () => []);
}

function cell(cols: number, x: number, y: number): number {
  const cx = Math.max(0, Math.min(cols - 1, Math.floor(x / CELL)));
  const cy = Math.max(0, Math.min(cols - 1, Math.floor(y / CELL)));
  return cy * cols + cx;
}

function coverBox(into: number[][], cols: number, minX: number, minY: number, maxX: number, maxY: number, id: number): void {
  const x0 = Math.max(0, Math.floor(minX / CELL));
  const y0 = Math.max(0, Math.floor(minY / CELL));
  const x1 = Math.min(cols - 1, Math.floor(maxX / CELL));
  const y1 = Math.min(cols - 1, Math.floor(maxY / CELL));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) into[y * cols + x]!.push(id);
}

function coverQuad(into: number[][], cols: number, p: ArrayLike<number>, base: number, pad: number, id: number): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < 4; i++) {
    const x = p[base + i * 2]!, y = p[base + i * 2 + 1]!;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  coverBox(into, cols, minX - pad, minY - pad, maxX + pad, maxY + pad, id);
}
