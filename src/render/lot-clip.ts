// Lot polygons are rectangles in the driveway's frame. The streets around a rotated
// block are not, so a corner of the rectangle can lie inside a carriageway. The
// snapshot already has both. These clip the lot, its outline and its stall lines
// so they stop at the curb. A street that sits inside the lot (the driveway) is
// left as a hole in the fill; the street stroke covers it.

export interface Pt {
  x: number;
  y: number;
}

const ON = 1e-4; // m: a point this close to an edge counts as on it

/** Carriageway quad, corners in order. Null for a zero-length segment. */
export function streetQuad(x1: number, y1: number, x2: number, y2: number, width: number): Pt[] | null {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return null;
  const nx = -dy / len * width / 2, ny = dx / len * width / 2;
  return ccw([
    { x: x1 + nx, y: y1 + ny },
    { x: x2 + nx, y: y2 + ny },
    { x: x2 - nx, y: y2 - ny },
    { x: x1 - nx, y: y1 - ny },
  ]);
}

/**
 * The lot with every street quad removed. Pieces may overlap; filling them with
 * the nonzero rule covers the lot outside the carriageways, including a hole
 * where a street lies inside the lot.
 */
export function lotOutsideStreets(lot: readonly Pt[], quads: readonly (readonly Pt[])[]): Pt[][] {
  let polys: Pt[][] = [ccw(lot)];
  for (const quad of quads) {
    const next: Pt[][] = [];
    for (const poly of polys) {
      if (poly.length < 3 || !convexHits(poly, quad)) next.push(poly);
      else next.push(...outsidePieces(poly, quad));
    }
    polys = next;
  }
  return polys.filter((p) => p.length >= 3);
}

/** Parts of the segment that lie outside every quad. */
export function segmentsOutside(a: Pt, b: Pt, quads: readonly (readonly Pt[])[]): [Pt, Pt][] {
  let parts: [Pt, Pt][] = [[a, b]];
  for (const quad of quads) {
    const next: [Pt, Pt][] = [];
    for (const [p, q] of parts) next.push(...segmentMinusConvex(p, q, quad));
    parts = next;
    if (parts.length === 0) break;
  }
  return parts.filter(([p, q]) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 > 0.04);
}

function outsidePieces(subject: Pt[], cutter: readonly Pt[]): Pt[][] {
  const pieces: Pt[][] = [];
  for (let i = 0; i < cutter.length; i++) {
    const clipped = clipHalfPlane(subject, cutter[i]!, cutter[(i + 1) % cutter.length]!, false);
    if (clipped.length >= 3) pieces.push(clipped);
  }
  return pieces;
}

/** Sutherland–Hodgman. `keepLeft` keeps the left of a→b; the outside of a CCW quad is the right. */
function clipHalfPlane(poly: Pt[], a: Pt, b: Pt, keepLeft: boolean): Pt[] {
  const out: Pt[] = [];
  const inside = (p: Pt) => {
    const c = cross(b.x - a.x, b.y - a.y, p.x - a.x, p.y - a.y);
    return keepLeft ? c >= -ON : c <= ON;
  };
  for (let i = 0; i < poly.length; i++) {
    const s = poly[i]!, e = poly[(i + 1) % poly.length]!;
    const sIn = inside(s), eIn = inside(e);
    if (sIn && eIn) out.push(e);
    else if (sIn && !eIn) out.push(lineHit(s, e, a, b));
    else if (!sIn && eIn) {
      out.push(lineHit(s, e, a, b));
      out.push(e);
    }
  }
  return out;
}

function segmentMinusConvex(a: Pt, b: Pt, poly: readonly Pt[]): [Pt, Pt][] {
  const ts = [0, 1];
  for (let i = 0; i < poly.length; i++) {
    const t = segmentT(a, b, poly[i]!, poly[(i + 1) % poly.length]!);
    if (t !== null && t > ON && t < 1 - ON) ts.push(t);
  }
  ts.sort((p, q) => p - q);
  const out: [Pt, Pt][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i]!, t1 = ts[i + 1]!;
    if (t1 - t0 < 1e-3) continue;
    const tm = (t0 + t1) / 2;
    const m = { x: a.x + (b.x - a.x) * tm, y: a.y + (b.y - a.y) * tm };
    if (!strictInside(m, poly)) {
      out.push([
        { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 },
        { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 },
      ]);
    }
  }
  return out;
}

function convexHits(a: readonly Pt[], b: readonly Pt[]): boolean {
  if (!boxesHit(a, b)) return false;
  if (a.some((p) => strictInside(p, b)) || b.some((p) => strictInside(p, a))) return true;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentT(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!) !== null) return true;
    }
  }
  return false;
}

function strictInside(p: Pt, poly: readonly Pt[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    if (cross(b.x - a.x, b.y - a.y, p.x - a.x, p.y - a.y) <= ON) return false;
  }
  return true;
}

function boxesHit(a: readonly Pt[], b: readonly Pt[]): boolean {
  const ab = box(a), bb = box(b);
  return ab.maxX >= bb.minX && ab.minX <= bb.maxX && ab.maxY >= bb.minY && ab.minY <= bb.maxY;
}

function box(poly: readonly Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function ccw(poly: readonly Pt[]): Pt[] {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a < 0 ? [...poly].reverse() : poly.slice();
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/** Parameter of ab∩cd along ab, or null when they miss or are collinear. */
function segmentT(a: Pt, b: Pt, c: Pt, d: Pt): number | null {
  const rx = b.x - a.x, ry = b.y - a.y;
  const sx = d.x - c.x, sy = d.y - c.y;
  const den = cross(rx, ry, sx, sy);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(c.x - a.x, c.y - a.y, sx, sy) / den;
  const u = cross(c.x - a.x, c.y - a.y, rx, ry) / den;
  if (t < -ON || t > 1 + ON || u < -ON || u > 1 + ON) return null;
  return Math.min(1, Math.max(0, t));
}

function lineHit(s: Pt, e: Pt, a: Pt, b: Pt): Pt {
  const rx = e.x - s.x, ry = e.y - s.y;
  const sx = b.x - a.x, sy = b.y - a.y;
  const den = cross(rx, ry, sx, sy);
  const t = Math.abs(den) < 1e-9 ? 0 : cross(a.x - s.x, a.y - s.y, sx, sy) / den;
  return { x: s.x + rx * t, y: s.y + ry * t };
}
