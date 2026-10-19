// Kerbside lamps for lit streets. Positions only: the static layer paints them.
// Stations sit about LAMP_SPACING apart. Each station takes one kerb, and the
// kerb alternates, so each side is at twice the spacing and offset by half a
// station. A short lit segment still gets one lamp, at its midpoint, on the
// side its single station falls on. Same-kerb duplicates at a joint are dropped.

import * as P from './palette';

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  hw: number;
}

const ROAD_CELL = 40; // m: street index for the "inside another carriageway" test
const INSIDE_MARGIN = 0.2; // m: a lamp this far inside another road's quad is skipped
const SLIDE_STEP = 2; // m: how far to walk a blocked station along the kerb looking for a clear point
const JUNCTION_CULL = 3.5; // m, either kerb. An opposite pair is at least 5 m (a 6 m alley), so only piled heads at a joint go

/**
 * Staggered kerbside lamps. Station k is on side k % 2, so the two kerbs
 * alternate. A lit segment of at least LAMP_MIN_LENGTH always gets its
 * midpoint station: one lamp, on whichever side that station falls on.
 */
export function placeKerbLamps(
  streets: ArrayLike<number>,
  lit: ArrayLike<number>,
): { x: number; y: number }[] {
  const n = lit.length;
  const segs: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const s = i * 5;
    segs.push({
      x1: streets[s]!, y1: streets[s + 1]!,
      x2: streets[s + 2]!, y2: streets[s + 3]!,
      hw: streets[s + 4]! / 2,
    });
  }
  const index = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const g = segs[i]!;
    const minx = Math.floor((Math.min(g.x1, g.x2) - g.hw) / ROAD_CELL);
    const maxx = Math.floor((Math.max(g.x1, g.x2) + g.hw) / ROAD_CELL);
    const miny = Math.floor((Math.min(g.y1, g.y2) - g.hw) / ROAD_CELL);
    const maxy = Math.floor((Math.max(g.y1, g.y2) + g.hw) / ROAD_CELL);
    for (let ix = minx; ix <= maxx; ix++) {
      for (let iy = miny; iy <= maxy; iy++) {
        const key = `${ix},${iy}`;
        const list = index.get(key);
        if (list) list.push(i);
        else index.set(key, [i]);
      }
    }
  }
  // The quad, not the round cap: t outside the segment is the pavement past the end.
  const insideOther = (x: number, y: number, own: number): boolean => {
    const list = index.get(`${Math.floor(x / ROAD_CELL)},${Math.floor(y / ROAD_CELL)}`);
    if (!list) return false;
    for (const j of list) {
      if (j === own) continue;
      const o = segs[j]!;
      const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-6) continue;
      const t = ((x - o.x1) * dx + (y - o.y1) * dy) / len2;
      if (t < 0 || t > 1) continue;
      const px = o.x1 + dx * t, py = o.y1 + dy * t;
      if (Math.hypot(x - px, y - py) < o.hw - INSIDE_MARGIN) return true;
    }
    return false;
  };

  const candidates: { x: number; y: number }[][] = [[], []];
  for (let i = 0; i < n; i++) {
    if (!lit[i]) continue;
    const g = segs[i]!;
    const dx = g.x2 - g.x1, dy = g.y2 - g.y1;
    const len = Math.hypot(dx, dy);
    if (len < P.LAMP_MIN_LENGTH) continue;
    const off = Math.max(0, g.hw - P.LAMP_KERB_INSET);
    const nx = -dy / len * off, ny = dx / len * off;
    const count = Math.max(1, Math.round(len / P.LAMP_SPACING));
    const at = (t: number, side: number): { x: number; y: number } | null => {
      const sign = side === 0 ? 1 : -1;
      const x = g.x1 + dx * t + nx * sign, y = g.y1 + dy * t + ny * sign;
      return insideOther(x, y, i) ? null : { x, y };
    };
    for (let k = 0; k < count; k++) {
      const t0 = (k + 0.5) / count;
      const side = k % 2;
      // The station first. If that kerb point is inside a crossing road, walk
      // along the segment for a clear one, so a medium segment is not left dark.
      let spot = at(t0, side);
      if (!spot) {
        const step = SLIDE_STEP / len;
        const reach = 0.5 / count;
        for (let d = step; d <= reach + step && !spot; d += step) {
          if (t0 - d > 0) spot = at(t0 - d, side);
          if (!spot && t0 + d < 1) spot = at(t0 + d, side);
        }
      }
      if (spot) candidates[side]!.push(spot);
    }
  }
  // Per kerb. A global cull would delete the opposite lamp of a pair on a narrow street.
  const cell = P.LAMP_MIN_DISTANCE;
  const kept: { x: number; y: number }[] = [];
  for (const side of candidates) {
    const grid = new Map<string, { x: number; y: number }[]>();
    for (const lamp of side) {
      const cx = Math.floor(lamp.x / cell), cy = Math.floor(lamp.y / cell);
      let ok = true;
      for (let ix = cx - 1; ix <= cx + 1 && ok; ix++) {
        for (let iy = cy - 1; iy <= cy + 1 && ok; iy++) {
          const near = grid.get(`${ix},${iy}`);
          if (!near) continue;
          for (const other of near) {
            if (Math.hypot(lamp.x - other.x, lamp.y - other.y) < cell) { ok = false; break; }
          }
        }
      }
      if (!ok) continue;
      kept.push(lamp);
      const key = `${cx},${cy}`;
      const list = grid.get(key);
      if (list) list.push(lamp);
      else grid.set(key, [lamp]);
    }
  }
  // Heads from different kerbs can still land on top of each other where two streets meet.
  const pile = new Map<string, { x: number; y: number }[]>();
  const out: { x: number; y: number }[] = [];
  for (const lamp of kept) {
    const cx = Math.floor(lamp.x / JUNCTION_CULL), cy = Math.floor(lamp.y / JUNCTION_CULL);
    let ok = true;
    for (let ix = cx - 1; ix <= cx + 1 && ok; ix++) {
      for (let iy = cy - 1; iy <= cy + 1 && ok; iy++) {
        const near = pile.get(`${ix},${iy}`);
        if (!near) continue;
        for (const other of near) {
          if (Math.hypot(lamp.x - other.x, lamp.y - other.y) < JUNCTION_CULL) { ok = false; break; }
        }
      }
    }
    if (!ok) continue;
    out.push(lamp);
    const key = `${cx},${cy}`;
    const list = pile.get(key);
    if (list) list.push(lamp);
    else pile.set(key, [lamp]);
  }
  return out;
}
