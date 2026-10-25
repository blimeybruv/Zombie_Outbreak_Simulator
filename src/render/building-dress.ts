// Ordinary buildings in plan. A plot is whatever quadrilateral the map cut, so
// the dress is measured along its edges rather than a fixed box. Tone, the
// window rhythm and any partition come from the building's id alone — a
// render-side hash, not a draw from the run — so a replay looks the same and
// the fingerprint does not move.
//
// A church, a hospital's L, a school's U, the armoury and a police station are
// left alone: their silhouette already says what they are.

import { SHAPE_BOX } from '../worker/protocol';
import * as P from './palette';

/** A fixed hash of a building id. Render only: not the run's stream. */
export function buildingVisualHash(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Index into `ROOF`, independent of the facade. */
export function roofTone(id: number): number {
  return buildingVisualHash(id) % P.ROOF.length;
}

/** Shape 0 is a plain plot. An armoury or a station keeps its own mark. */
export function ordinaryBuilding(shape: number, armoury: number, station: number): boolean {
  return shape === SHAPE_BOX && armoury === 0 && station === 0;
}

export interface Dress {
  tone: number;
  /** Window ticks, x0 y0 x1 y1, perpendicular to the street edge and inside it. */
  windows: number[];
  /** One threshold mark on that edge, or empty when the plot has no door. */
  door: number[];
  /** Interior lines, inset from the walls. Empty on a small footprint. */
  partitions: number[];
}

const PITCH = [2.35, 2.75, 3.2] as const;
const WINDOW_NEAR = 0.4; // m inside the street wall, so the tick does not nick the outline
const WINDOW_DEEP = 1.95; // m: long enough to read at near zoom, short of the rooms
const DOOR_CLEAR = 1.2; // m: no window this close to a door, along the wall
const END_MARGIN = 0.85; // m: the rhythm stops short of each corner
const DOOR_INSET = 0.38; // m
const DOOR_HALF = 1.05; // m along the wall: a threshold, wider than a window tick is deep
const PARTITION_MIN = 400; // m²: houses stay one room; a downtown footprint may be divided
const PARTITION_ROOMY = 700; // m²: room for a second line
const PARTITION_PAD = 1.7; // m: a line stops short of the outline, so it does not read as a crack in it

/** One ordinary plot. `corners` is x0 y0 … x3 y3; `doorXY` is x y pairs on the walls. */
export function dressBuilding(id: number, corners: ArrayLike<number>, doorXY: ArrayLike<number>): Dress {
  const x = [corners[0]!, corners[2]!, corners[4]!, corners[6]!];
  const y = [corners[1]!, corners[3]!, corners[5]!, corners[7]!];
  const face = facade(buildingVisualHash(id), x, y, doorXY);
  return { tone: roofTone(id), windows: face.windows, door: face.door, partitions: partitionLines(buildingVisualHash(id), x, y) };
}

function facade(h: number, x: number[], y: number[], doorXY: ArrayLike<number>): { windows: number[]; door: number[] } {
  const empty = { windows: [] as number[], door: [] as number[] };
  if (doorXY.length < 2) return empty;
  const dx0 = doorXY[0]!, dy0 = doorXY[1]!;
  let edge = 0, best = Infinity;
  for (let i = 0; i < 4; i++) {
    const d = pointSegment(dx0, dy0, x[i]!, y[i]!, x[(i + 1) % 4]!, y[(i + 1) % 4]!);
    if (d < best) {
      best = d;
      edge = i;
    }
  }
  const ax = x[edge]!, ay = y[edge]!, bx = x[(edge + 1) % 4]!, by = y[(edge + 1) % 4]!;
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1) return empty;
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  let nx = -uy, ny = ux;
  const cx = (x[0]! + x[1]! + x[2]! + x[3]!) / 4, cy = (y[0]! + y[1]! + y[2]! + y[3]!) / 4;
  if (nx * ((ax + bx) / 2 - cx) + ny * ((ay + by) / 2 - cy) < 0) {
    nx = -nx;
    ny = -ny;
  }
  const ix = -nx, iy = -ny;
  const doorS: number[] = [];
  for (let i = 0; i + 1 < doorXY.length; i += 2) {
    const px = doorXY[i]!, py = doorXY[i + 1]!;
    const s = (px - ax) * ux + (py - ay) * uy;
    const dist = Math.hypot(px - (ax + ux * s), py - (ay + uy * s));
    if (dist < 1.2 && s > -0.5 && s < len + 0.5) doorS.push(Math.max(0, Math.min(len, s)));
  }
  const windows: number[] = [];
  if (len >= 7) {
    const pitch = PITCH[(h >>> 8) % PITCH.length]!;
    let s = END_MARGIN + ((h >>> 12) % 1000) / 1000 * pitch;
    while (s < len - END_MARGIN) {
      if (!doorS.some((ds) => Math.abs(ds - s) < DOOR_CLEAR)) {
        windows.push(
          ax + ux * s + ix * WINDOW_NEAR, ay + uy * s + iy * WINDOW_NEAR,
          ax + ux * s + ix * WINDOW_DEEP, ay + uy * s + iy * WINDOW_DEEP,
        );
      }
      s += pitch;
    }
  }
  const door: number[] = [];
  if (doorS.length > 0) {
    const s = doorS[0]!;
    const cpx = ax + ux * s + ix * DOOR_INSET, cpy = ay + uy * s + iy * DOOR_INSET;
    door.push(cpx - ux * DOOR_HALF, cpy - uy * DOOR_HALF, cpx + ux * DOOR_HALF, cpy + uy * DOOR_HALF);
  }
  return { windows, door };
}

function partitionLines(h: number, x: number[], y: number[]): number[] {
  const area = Math.abs(shoelace(x, y));
  if (area < PARTITION_MIN) return [];
  const width = Math.hypot(x[1]! - x[0]!, y[1]! - y[0]!);
  const depth = Math.hypot(x[3]! - x[0]!, y[3]! - y[0]!);
  if (width < 10 || depth < 10) return [];
  const padS = Math.min(0.42, PARTITION_PAD / width);
  const padT = Math.min(0.42, PARTITION_PAD / depth);
  const at = (s: number, t: number): [number, number] => [
    x[0]! + (x[1]! - x[0]!) * s + (x[3]! - x[0]!) * t,
    y[0]! + (y[1]! - y[0]!) * s + (y[3]! - y[0]!) * t,
  ];
  const out: number[] = [];
  const seg = (s0: number, t0: number, s1: number, t1: number) => {
    const [ax, ay] = at(s0, t0);
    const [bx, by] = at(s1, t1);
    if (Math.hypot(bx - ax, by - ay) < 4) return;
    out.push(ax, ay, bx, by);
  };
  const u = 0.36 + ((h >>> 4) % 29) / 100;
  const v = 0.36 + ((h >>> 10) % 29) / 100;
  const across = () => seg(padS, u, 1 - padS, u);
  const along = () => seg(v, padT, v, 1 - padT);
  const roll = (h >>> 18) % 5;
  if (roll === 0) return out;
  const roomy = area >= PARTITION_ROOMY && width >= 18 && depth >= 18;
  if (roll === 3 && roomy) {
    across();
    along();
  } else if (roll === 4 && area >= PARTITION_ROOMY && depth >= 22) {
    seg(padS, 0.32 + ((h >>> 22) % 8) / 100, 1 - padS, 0.32 + ((h >>> 22) % 8) / 100);
    seg(padS, 0.66 + ((h >>> 26) % 8) / 100, 1 - padS, 0.66 + ((h >>> 26) % 8) / 100);
  } else if (roll === 2 && depth >= 14) along();
  else across();
  return out;
}

function shoelace(x: number[], y: number[]): number {
  let a = 0;
  for (let i = 0; i < 4; i++) a += x[i]! * y[(i + 1) % 4]! - x[(i + 1) % 4]! * y[i]!;
  return a / 2;
}

function pointSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
