// Street name labels. One per named street, beside the longest connected run of
// its segments. The static layer paints them; nothing here reads the simulation.

/** Metres. A shorter longest-run is not labelled. */
export const LABEL_MIN_LENGTH = 40;
/** Metres past the kerb. The label's centre sits beside the road. */
export const LABEL_KERB_GAP = 5;
/** CSS pixels. Screen size, counter-scaled when the context is in metres. */
export const LABEL_FONT_NEAR = 11;
export const LABEL_FONT_MID = 9;
/** Average advance of one character in em. Used to reject overlapping labels. */
const CHAR_EM = 0.55;
/** Metres added on each side of a label when testing overlap. */
const LABEL_PAD = 3;

export interface StreetLabelCandidate {
  name: string;
  /** Metres along the longest run. A longer run keeps its label when two would overlap. */
  length: number;
  /** Beside the road, on one kerb. */
  x: number;
  y: number;
  /** The other kerb, tried when the first side would overlap. */
  altX: number;
  altY: number;
  /** Radians, flipped so the words read upright. */
  angle: number;
  /** On the centreline, for culling to the static layer. */
  cx: number;
  cy: number;
}

export interface StreetLabelSet {
  labels: StreetLabelCandidate[];
  /** Unique non-empty names. */
  named: number;
  /** Named streets whose longest run is shorter than LABEL_MIN_LENGTH. */
  skippedLength: number;
  /** Segments that carry no name. */
  emptySegments: number;
}

export interface PlacedStreetLabel {
  name: string;
  x: number;
  y: number;
  angle: number;
}

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  len: number;
  width: number;
}

interface Part {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  len: number;
  ux: number;
  uy: number;
  width: number;
}

const endKey = (x: number, y: number): string => `${Math.round(x * 10)},${Math.round(y * 10)}`;

/** CSS pixels across, for the overlap test. The same estimate the static layer uses. */
export function labelWidthCss(name: string, fontCss: number): number {
  return name.length * fontCss * CHAR_EM;
}

/**
 * One candidate per non-empty name: the middle of the longest run of segments
 * that share it. A run walks end to end; at a branch it takes the most colinear
 * continuation, and each segment belongs to one run.
 */
export function streetLabelCandidates(streets: ArrayLike<number>, names: readonly string[]): StreetLabelSet {
  const byName = new Map<string, Seg[]>();
  let emptySegments = 0;
  const n = names.length;
  for (let i = 0; i < n; i++) {
    const name = names[i] ?? '';
    if (name === '') {
      emptySegments++;
      continue;
    }
    const s = i * 5;
    const x1 = streets[s]!, y1 = streets[s + 1]!, x2 = streets[s + 2]!, y2 = streets[s + 3]!;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1e-3) continue;
    const seg: Seg = { x1, y1, x2, y2, len, width: streets[s + 4]! };
    const list = byName.get(name);
    if (list) list.push(seg);
    else byName.set(name, [seg]);
  }
  const labels: StreetLabelCandidate[] = [];
  let skippedLength = 0;
  for (const [name, segs] of byName) {
    const run = longestRun(segs);
    if (run.length < LABEL_MIN_LENGTH) {
      skippedLength++;
      continue;
    }
    const mid = pointAt(run.parts, run.length / 2);
    let angle = Math.atan2(mid.uy, mid.ux);
    if (Math.abs(angle) > Math.PI / 2) angle += Math.PI;
    const off = mid.width / 2 + LABEL_KERB_GAP;
    const nx = -mid.uy * off, ny = mid.ux * off;
    labels.push({
      name,
      length: run.length,
      x: mid.x + nx,
      y: mid.y + ny,
      altX: mid.x - nx,
      altY: mid.y - ny,
      angle,
      cx: mid.x,
      cy: mid.y,
    });
  }
  return { labels, named: byName.size, skippedLength, emptySegments };
}

/** Greedy: longer runs first, the other kerb before a skip. Bounds cull to the static layer. */
export function placeStreetLabels(
  labels: readonly StreetLabelCandidate[],
  scale: number,
  fontCss: number,
  bounds?: { minX: number; minY: number; maxX: number; maxY: number },
): { placed: PlacedStreetLabel[]; skippedOverlap: number } {
  const order = labels.filter((l) => !bounds || (l.cx >= bounds.minX && l.cx <= bounds.maxX && l.cy >= bounds.minY && l.cy <= bounds.maxY));
  order.sort((a, b) => b.length - a.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const placed: PlacedStreetLabel[] = [];
  const boxes: { x: number; y: number; angle: number; hl: number; hh: number }[] = [];
  const hh = fontCss / (2 * scale);
  let skippedOverlap = 0;
  for (const label of order) {
    const hl = labelWidthCss(label.name, fontCss) / (2 * scale) + LABEL_PAD;
    const spot = [{ x: label.x, y: label.y }, { x: label.altX, y: label.altY }].find(
      (p) => !boxes.some((b) => obbOverlap(p.x, p.y, label.angle, hl, hh, b.x, b.y, b.angle, b.hl, b.hh)),
    );
    if (!spot) {
      skippedOverlap++;
      continue;
    }
    placed.push({ name: label.name, x: spot.x, y: spot.y, angle: label.angle });
    boxes.push({ x: spot.x, y: spot.y, angle: label.angle, hl, hh });
  }
  return { placed, skippedOverlap };
}

function longestRun(segs: Seg[]): { parts: Part[]; length: number } {
  const at = new Map<string, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    for (const k of [endKey(s.x1, s.y1), endKey(s.x2, s.y2)]) {
      const list = at.get(k);
      if (list) list.push(i);
      else at.set(k, [i]);
    }
  }
  const used = new Array<boolean>(segs.length).fill(false);
  let best: Part[] = [];
  let bestLen = 0;
  const take = (parts: Part[]) => {
    let length = 0;
    for (const p of parts) length += p.len;
    if (length > bestLen) {
      best = parts;
      bestLen = length;
    }
  };
  const start = (i: number, fromEnd: boolean) => {
    if (used[i]) return;
    const s = segs[i]!;
    take(walk(segs, at, used, i, fromEnd ? s.x2 : s.x1, fromEnd ? s.y2 : s.y1));
  };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const d1 = at.get(endKey(s.x1, s.y1))!.length;
    const d2 = at.get(endKey(s.x2, s.y2))!.length;
    if (d1 === 1) start(i, false);
    else if (d2 === 1) start(i, true);
  }
  for (let i = 0; i < segs.length; i++) start(i, false);
  return { parts: best, length: bestLen };
}

function walk(segs: Seg[], at: Map<string, number[]>, used: boolean[], start: number, fromX: number, fromY: number): Part[] {
  const parts: Part[] = [];
  let cur = start;
  let fx = fromX;
  let fy = fromY;
  while (!used[cur]) {
    used[cur] = true;
    const s = segs[cur]!;
    const fromStart = (s.x1 - fx) ** 2 + (s.y1 - fy) ** 2 <= (s.x2 - fx) ** 2 + (s.y2 - fy) ** 2;
    const x1 = fromStart ? s.x1 : s.x2;
    const y1 = fromStart ? s.y1 : s.y2;
    const x2 = fromStart ? s.x2 : s.x1;
    const y2 = fromStart ? s.y2 : s.y1;
    const ux = (x2 - x1) / s.len;
    const uy = (y2 - y1) / s.len;
    parts.push({ x1, y1, x2, y2, len: s.len, ux, uy, width: s.width });
    const nexts = (at.get(endKey(x2, y2)) ?? []).filter((j) => !used[j]);
    if (nexts.length === 0) break;
    let best = nexts[0]!;
    let bestDot = -Infinity;
    for (const j of nexts) {
      const o = segs[j]!;
      const leaveStart = (o.x1 - x2) ** 2 + (o.y1 - y2) ** 2 <= (o.x2 - x2) ** 2 + (o.y2 - y2) ** 2;
      const lx = (leaveStart ? o.x2 - o.x1 : o.x1 - o.x2) / o.len;
      const ly = (leaveStart ? o.y2 - o.y1 : o.y1 - o.y2) / o.len;
      const dot = ux * lx + uy * ly;
      if (dot > bestDot || (dot === bestDot && j < best)) {
        best = j;
        bestDot = dot;
      }
    }
    cur = best;
    fx = x2;
    fy = y2;
  }
  return parts;
}

function pointAt(parts: Part[], dist: number): { x: number; y: number; ux: number; uy: number; width: number } {
  let remain = dist;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (remain <= p.len || i === parts.length - 1) {
      const t = p.len > 0 ? Math.min(1, Math.max(0, remain / p.len)) : 0;
      return { x: p.x1 + (p.x2 - p.x1) * t, y: p.y1 + (p.y2 - p.y1) * t, ux: p.ux, uy: p.uy, width: p.width };
    }
    remain -= p.len;
  }
  const p = parts[0]!;
  return { x: p.x1, y: p.y1, ux: p.ux, uy: p.uy, width: p.width };
}

/** Separating-axis test for two rotated label boxes. */
function obbOverlap(
  ax: number, ay: number, aAng: number, aHL: number, aHH: number,
  bx: number, by: number, bAng: number, bHL: number, bHH: number,
): boolean {
  const dx = bx - ax, dy = by - ay;
  for (const ang of [aAng, aAng + Math.PI / 2, bAng, bAng + Math.PI / 2]) {
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const dist = Math.abs(dx * ux + dy * uy);
    const aExt = aHL * Math.abs(Math.cos(aAng) * ux + Math.sin(aAng) * uy) + aHH * Math.abs(-Math.sin(aAng) * ux + Math.cos(aAng) * uy);
    const bExt = bHL * Math.abs(Math.cos(bAng) * ux + Math.sin(bAng) * uy) + bHH * Math.abs(-Math.sin(bAng) * ux + Math.cos(bAng) * uy);
    if (dist > aExt + bExt) return false;
  }
  return true;
}
