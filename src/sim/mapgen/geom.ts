// Plane geometry for map generation: segments, polygons and oriented rectangles.
// Generation-time only, so clarity wins over speed here.

import type { Vec2 } from '../state';

export type Pt = { x: number; y: number };

export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
export const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;
export const len = (a: Pt): number => Math.hypot(a.x, a.y);
export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
export const unit = (a: Pt): Pt => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
/** Left-hand perpendicular. */
export const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x });

/** Intersection parameters (t on a→b, u on c→d) of two segments, or null if they do not cross. */
export function segmentIntersection(a: Pt, b: Pt, c: Pt, d: Pt): { t: number; u: number } | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-9) return null;
  const qp = sub(c, a);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return { t, u };
}

export function pointSegmentDist(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  let t = l2 === 0 ? 0 : dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, add(a, scale(ab, t)));
}

/** Distance from a point to a polyline. */
export function pointPolylineDist(p: Pt, line: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, pointSegmentDist(p, line[i]!, line[i + 1]!));
  return best;
}

/** Clips segment a→b to an axis-aligned rectangle (Liang–Barsky). */
export function clipToRect(a: Pt, b: Pt, minX: number, minY: number, maxX: number, maxY: number): [Pt, Pt] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - minX, maxX - a.x, a.y - minY, maxY - a.y];
  for (let i = 0; i < 4; i++) {
    const pi = p[i]!;
    const qi = q[i]!;
    if (pi === 0) {
      if (qi < 0) return null;
      continue;
    }
    const r = qi / pi;
    if (pi < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [
    { x: a.x + t0 * dx, y: a.y + t0 * dy },
    { x: a.x + t1 * dx, y: a.y + t1 * dy },
  ];
}

/** Signed area; positive when the vertices run clockwise on screen (y down). */
export function signedArea(poly: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function centroid(poly: readonly Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether two polygons' boundaries cross. */
export function boundariesCross(p: readonly Pt[], q: readonly Pt[]): boolean {
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) {
      if (segmentIntersection(p[i]!, p[(i + 1) % p.length]!, q[j]!, q[(j + 1) % q.length]!)) return true;
    }
  }
  return false;
}

/** Whether polygon `inner` lies entirely within polygon `outer`. */
export function polygonInside(inner: readonly Pt[], outer: readonly Pt[]): boolean {
  return inner.every((p) => pointInPolygon(p, outer)) && !boundariesCross(inner, outer);
}

/** Separating-axis overlap test for two convex polygons. */
export function convexOverlap(p: readonly Pt[], q: readonly Pt[]): boolean {
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const axis = perp(sub(poly[(i + 1) % poly.length]!, poly[i]!));
      let pMin = Infinity, pMax = -Infinity, qMin = Infinity, qMax = -Infinity;
      for (const v of p) {
        const d = dot(v, axis);
        pMin = Math.min(pMin, d);
        pMax = Math.max(pMax, d);
      }
      for (const v of q) {
        const d = dot(v, axis);
        qMin = Math.min(qMin, d);
        qMax = Math.max(qMax, d);
      }
      if (pMax <= qMin || qMax <= pMin) return false;
    }
  }
  return true;
}

/** Shortest distance between a segment and a convex polygon (0 if they touch). */
export function segmentPolygonDist(a: Pt, b: Pt, poly: readonly Pt[]): number {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i]!;
    const d = poly[(i + 1) % poly.length]!;
    if (segmentIntersection(a, b, c, d)) return 0;
    best = Math.min(best, pointSegmentDist(c, a, b), pointSegmentDist(a, c, d), pointSegmentDist(b, c, d));
  }
  return best;
}

/** Rectangle from a front edge (start, unit direction along it, width) and a depth toward `inward`. */
export function rectFromFront(start: Pt, along: Pt, width: number, inward: Pt, depth: number): Vec2[] {
  const p0 = start;
  const p1 = add(start, scale(along, width));
  const p2 = add(p1, scale(inward, depth));
  const p3 = add(p0, scale(inward, depth));
  return [p0, p1, p2, p3];
}
