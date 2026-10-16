// Traffic on the border motorway: scenery, nothing more. The simulation knows nothing
// of these cars — they are not entities, not counted, not obstacles, nobody sees or
// hears them. Each is a position along the motorway worked out from simulation time
// alone, so the same moment always looks the same, pausing stops them, and playback
// speed speeds them.
//
// The motorway runs along two adjacent sides of the map, round the corner between
// them, and off the map at both ends (renderer.ts buildBorder draws it from the same
// figures, BORDER). Cars come on at either end, keep to the right-hand carriageway, and
// go off at the other; where an exit crosses on an overpass, they pass under it.

import type { Camera } from './camera';
import type { MapSnapshot } from '../worker/protocol';
import * as P from './palette';

/** The border's features, in metres: railway gauge, between tracks, sleeper pitch, fences either side of the centre; motorway between fences; a deck's overhang past what it crosses (and a crossing's gap past the road); the radius of a feature's curve round its own corner; the radius of its turn off the map, and how far short of the corner the turn begins. */
export const BORDER = { gauge: 1.5, trackGap: 4.5, sleeperGap: 2, railFence: 8, motorway: 32, overhang: 3, bend: 180, turn: 60, trail: 150 };

/** The traffic, in metres and ticks: a carriageway's middle from the median; speed (about 80 km/h); the gaps between cars; how far past the map edge a car comes on and goes off. */
const TRAFFIC = { lane: 8, speed: 22, gap: [30, 260] as const, beyond: 60 };
const CAR_L = 4.5, CAR_W = 1.9;
/** Off the map at each end: the route runs this far past the turn so cars come on from out of sight. */
const OFF = 40;

/** Each side's run across the middle of the margin, corner to corner: start, end, inward normal. */
export function borderRun(size: number, margin: number, side: number): [number, number, number, number, number, number] {
  const c = margin / 2;
  return (
    [
      [c, c, size - c, c, 0, 1],
      [size - c, c, size - c, size - c, -1, 0],
      [size - c, size - c, c, size - c, 0, -1],
      [c, size - c, c, c, 1, 0],
    ] as const
  )[side] as unknown as [number, number, number, number, number, number];
}

interface Route {
  /** The motorway's middle, x y pairs, in the forward direction. */
  pts: Float64Array;
  /** Distance along it at each point. */
  at: Float64Array;
  length: number;
  /** Stretches [from, to] where an overpass hides the road. */
  under: [number, number][];
}

/** Points along an arc about (qx, qy), from angle a0 to a1, clockwise (increasing angle) unless ccw. */
function arc(out: number[], qx: number, qy: number, r: number, a0: number, a1: number, ccw: boolean): void {
  let sweep = a1 - a0;
  if (!ccw) while (sweep <= 0) sweep += 2 * Math.PI;
  else while (sweep >= 0) sweep -= 2 * Math.PI;
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(qx + Math.cos(a) * r, qy + Math.sin(a) * r);
  }
}

/** The motorway's middle, end to end: on at one end, along its two sides and round its corner, off at the other. Null without one. */
function motorwayRoute(map: MapSnapshot): Route | null {
  const { margin, sides } = map.border;
  const size = map.size;
  const c = margin / 2;
  const first = sides.findIndex((k, i) => k === 'motorway' && sides[(i + 1) % 4] === 'motorway' && sides[(i + 3) % 4] !== 'motorway');
  if (first < 0) return null;
  const second = (first + 1) % 4;
  const [ax, ay, bx, by, nx, ny] = borderRun(size, margin, first);
  const [cx, cy, dx, dy, mx, my] = borderRun(size, margin, second);
  const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(dx - cx, dy - cy);
  const ux = (bx - ax) / l1, uy = (by - ay) / l1, vx = (dx - cx) / l2, vy = (dy - cy) / l2;
  const R = BORDER.turn;
  const pts: number[] = [];
  // On: from off the map, back through the turn the start of the first side makes (renderer.ts).
  {
    const tx = -ux, ty = -uy; // toward that corner
    const px = ax + ux * BORDER.trail, py = ay + uy * BORDER.trail;
    const qx = px - nx * R, qy = py - ny * R;
    const ex = qx + tx * R, ey = qy + ty * R;
    pts.push(ex - nx * (c + R + OFF), ey - ny * (c + R + OFF));
    arc(pts, qx, qy, R, Math.atan2(ty, tx), Math.atan2(ny, nx), !(nx * ty - ny * tx < 0));
  }
  // Round the corner between the two sides.
  {
    const qx = bx + BORDER.bend * (nx + mx), qy = by + BORDER.bend * (ny + my);
    arc(pts, qx, qy, BORDER.bend, Math.atan2(-ny, -nx), Math.atan2(-my, -mx), false);
  }
  // Off: through the turn the end of the second side makes, and on off the map.
  {
    const tx = vx, ty = vy;
    const px = dx - vx * BORDER.trail, py = dy - vy * BORDER.trail;
    const qx = px - mx * R, qy = py - my * R;
    arc(pts, qx, qy, R, Math.atan2(my, mx), Math.atan2(ty, tx), mx * ty - my * tx < 0);
    const ex = qx + tx * R, ey = qy + ty * R;
    pts.push(ex - mx * (c + R + OFF), ey - my * (c + R + OFF));
  }
  const xy = new Float64Array(pts);
  const at = new Float64Array(xy.length / 2);
  for (let i = 1; i < at.length; i++) at[i] = at[i - 1]! + Math.hypot(xy[i * 2]! - xy[i * 2 - 2]!, xy[i * 2 + 1]! - xy[i * 2 - 1]!);
  const route: Route = { pts: xy, at, length: at[at.length - 1]!, under: [] };
  // Under the overpasses: where each exit on a motorway side crosses the middle of the margin.
  const e = map.exits;
  for (let i = 0; i < e.length; i += 7) {
    const x = e[i]! - e[i + 2]! * c, y = e[i + 1]! - e[i + 3]! * c, half = e[i + 6]! / 2 + BORDER.overhang;
    let best = Infinity, s = 0;
    for (let k = 0; k + 1 < at.length; k++) {
      const x0 = xy[k * 2]!, y0 = xy[k * 2 + 1]!, sx = xy[k * 2 + 2]! - x0, sy = xy[k * 2 + 3]! - y0;
      const seg = at[k + 1]! - at[k]!;
      if (seg <= 0) continue;
      const t = Math.max(0, Math.min(1, ((x - x0) * sx + (y - y0) * sy) / (seg * seg)));
      const d = Math.hypot(x0 + sx * t - x, y0 + sy * t - y);
      if (d < best) [best, s] = [d, at[k]! + seg * t];
    }
    if (best < BORDER.motorway) route.under.push([s - half - CAR_L / 2, s + half + CAR_L / 2]);
  }
  return route;
}

/** A fixed hash of an integer to [0, 1): the cars' spacing, the same every run. */
function hash(i: number): number {
  let h = Math.imul(i ^ 0x5bd1e995, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x165667b1);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

export class Traffic {
  private readonly route: Route | null;
  /** Each direction's cars: where each is along a loop of the given length at time 0. */
  private readonly lanes: { phase: Float64Array; loop: number }[] = [];

  constructor(map: MapSnapshot) {
    this.route = motorwayRoute(map);
    if (!this.route) return;
    for (let dir = 0; dir < 2; dir++) {
      const phase: number[] = [];
      let s = 0;
      // Enough cars to fill the motorway and its run-on past both ends, spaced at random.
      for (let i = 0; s < this.route.length + 2 * TRAFFIC.beyond; i++) {
        phase.push(s);
        s += TRAFFIC.gap[0] + (TRAFFIC.gap[1] - TRAFFIC.gap[0]) * hash(dir * 7919 + i);
      }
      this.lanes.push({ phase: new Float64Array(phase), loop: s });
    }
  }

  /** Where along the route, and which way it runs there: x, y, and the unit direction. */
  private point(s: number): [number, number, number, number] {
    const { pts, at } = this.route!;
    let lo = 0, hi = at.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (at[mid]! <= s) lo = mid;
      else hi = mid;
    }
    const seg = at[hi]! - at[lo]! || 1;
    const t = Math.min(1, Math.max(0, (s - at[lo]!) / seg));
    const x0 = pts[lo * 2]!, y0 = pts[lo * 2 + 1]!, x1 = pts[hi * 2]!, y1 = pts[hi * 2 + 1]!;
    return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, (x1 - x0) / seg, (y1 - y0) / seg];
  }

  /** The cars at simulation time `time` (ticks, fractional between them), at mid and near zoom. */
  draw(g: CanvasRenderingContext2D, cam: Camera, dpr: number, time: number): void {
    const route = this.route;
    if (!route || cam.mode === 'far') return;
    cam.apply(g, dpr);
    const path = new Path2D();
    const hl = CAR_L / 2, hw = CAR_W / 2;
    this.lanes.forEach((lane, dir) => {
      for (const p0 of lane.phase) {
        // Along the loop, shifted so a car comes on `beyond` metres before the route begins.
        const loopS = (p0 + TRAFFIC.speed * time) % lane.loop;
        const s = loopS - TRAFFIC.beyond;
        if (s < 0 || s > route.length) continue;
        const along = dir === 0 ? s : route.length - s; // the other way on the other carriageway
        if (route.under.some(([a, b]) => along > a && along < b)) continue;
        const [x, y, ux0, uy0] = this.point(along);
        const ux = dir === 0 ? ux0 : -ux0, uy = dir === 0 ? uy0 : -uy0; // its heading
        // Keep right: the carriageway to the right of its heading (y runs down the screen).
        const cx = x - uy * TRAFFIC.lane, cy = y + ux * TRAFFIC.lane;
        path.moveTo(cx + ux * hl - uy * hw, cy + uy * hl + ux * hw);
        path.lineTo(cx - ux * hl - uy * hw, cy - uy * hl + ux * hw);
        path.lineTo(cx - ux * hl + uy * hw, cy - uy * hl - ux * hw);
        path.lineTo(cx + ux * hl + uy * hw, cy + uy * hl - ux * hw);
        path.closePath();
      }
    });
    g.fillStyle = P.CAR_DRIVING;
    g.fill(path);
  }
}
