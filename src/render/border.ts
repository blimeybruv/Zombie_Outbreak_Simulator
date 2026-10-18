// The city's edge, drawn: across the empty margin a fenced double-track railway along two
// adjacent sides and a fenced motorway with a sound barrier along the other two, each
// curving round its corner and turning off the map where it would meet the other; an
// overpass where an exit crosses the motorway, a level crossing where one crosses the
// railway. Built once from the map snapshot, stroked into the static city layer. The
// motorway's traffic is traffic.ts.

import type { Camera } from './camera';
import type { MapSnapshot } from '../worker/protocol';
import * as P from './palette';

const EXIT_STRIDE = 7; // values per exit in the map snapshot

/** The border's features, in metres: railway gauge, between tracks, sleeper pitch, fences either side of the centre; motorway between fences; the sound barrier on its city side (wall thickness, post width and pitch); a deck's overhang past what it crosses (and a crossing's gap past the road); the radius of a feature's curve round its own corner; the radius of its turn off the map, and how far short of the corner the turn begins. */
export const BORDER = { gauge: 1.5, trackGap: 4.5, sleeperGap: 2, railFence: 8, motorway: 32, barrier: 0.8, postWidth: 0.5, postPitch: 4, overhang: 3, bend: 180, turn: 60, trail: 150 };

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

export class BorderLines {
  /** Every line of the border, one path per way it is stroked. */
  private readonly lines = { rails: new Path2D(), sleepers: new Path2D(), fences: new Path2D(), median: new Path2D(), barrier: new Path2D(), posts: new Path2D() };

  /**
   * The border, built once: across the middle of the empty margin, a fenced
   * double-track railway (rails, sleepers, a fence either side) along two adjacent sides
   * and a fenced motorway (a fence either side, a median barrier) along the other two,
   * each curving round its own corner and, where it would meet the other, turning off
   * the map — so the edge reads as a boundary rather than as absence. Where an exit's
   * stub crosses it: an overpass over the motorway, a deck cut through it like a river
   * bridge; over the railway a level crossing, the fences and sleepers broken for the
   * road and the rails running on across it.
   */
  build(map: MapSnapshot, bridgeDecks: Map<number, Path2D>, bridgeRails: Path2D): void {
    const { margin, sides } = map.border;
    const size = map.size;
    const c = margin / 2;
    const b = this.lines;
    // Each side's band, corner to corner of the inner margin: start, end, and the offset direction across it.
    const run = (side: number) => borderRun(size, margin, side);
    // Where exits cross each side: [from, to] along the side's run, the road's width and a little.
    const gaps: [number, number][][] = [[], [], [], []];
    const e = map.exits;
    const sideAt = (x: number, y: number) => [y < margin ? 0 : -1, x > size - margin ? 1 : -1, y > size - margin ? 2 : -1, x < margin ? 3 : -1].find((k) => k >= 0) ?? 0;
    for (let i = 0; i < e.length; i += EXIT_STRIDE) {
      const x = e[i]!, y = e[i + 1]!, half = e[i + 6]! / 2 + BORDER.overhang;
      const side = sideAt(x, y);
      const [ax, ay, bx, by] = run(side);
      const l = Math.hypot(bx - ax, by - ay);
      const t = ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l;
      gaps[side]!.push([t - half, t + half]);
    }
    // Each feature runs along two adjacent sides and turns the corner between them on a
    // curve: its lines stop BORDER.bend short of the corner, and a quarter circle joins
    // them. Where it would meet the other feature, it turns outward instead, BORDER.trail
    // short of the corner, and runs on off the map.
    const same = (side: number, next: number) => sides[side] === sides[(side + next + 4) % 4];
    const trim = (side: number, next: number) => (same(side, next) ? BORDER.bend : BORDER.trail);
    const line = (path: Path2D, side: number, off: number, broken = false) => {
      const [ax, ay, bx, by, nx, ny] = run(side);
      const l = Math.hypot(bx - ax, by - ay);
      const ux = (bx - ax) / l, uy = (by - ay) / l;
      const cuts = broken ? [...gaps[side]!].sort((p, q) => p[0] - q[0]) : [];
      let from = trim(side, -1);
      const end = l - trim(side, 1);
      for (const [g0, g1] of [...cuts, [end, end] as [number, number]]) {
        if (g0 > from) {
          path.moveTo(ax + ux * from + nx * off, ay + uy * from + ny * off);
          path.lineTo(ax + ux * g0 + nx * off, ay + uy * g0 + ny * off);
        }
        from = Math.max(from, g1);
      }
    };
    /** Every line of a feature, as [path, offset inward from its middle]. */
    const parts = (kind: 'rail' | 'motorway'): [Path2D, number][] =>
      kind === 'rail'
        ? [
            ...[-1, 1].flatMap((t) => [-1, 1].map((r): [Path2D, number] => [b.rails, (t * BORDER.trackGap + r * BORDER.gauge) / 2])),
            [b.sleepers, -BORDER.trackGap / 2],
            [b.sleepers, BORDER.trackGap / 2],
            [b.fences, -BORDER.railFence],
            [b.fences, BORDER.railFence],
          ]
        : [
            [b.fences, -BORDER.motorway / 2],
            // On the city side, a sound barrier instead of the fence: a wall and its posts.
            [b.barrier, BORDER.motorway / 2 + BORDER.barrier / 2],
            [b.posts, BORDER.motorway / 2 + BORDER.barrier / 2],
            [b.median, 0],
          ];
    sides.forEach((kind, side) => {
      for (const [path, off] of parts(kind)) line(path, side, off, kind === 'rail' && path !== b.rails);
      const [ax, ay, bx, by, nx, ny] = run(side);
      const l = Math.hypot(bx - ax, by - ay);
      const ux = (bx - ax) / l, uy = (by - ay) / l;
      if (same(side, 1)) {
        // Round the corner into the next side, about a centre inside it: a line offset
        // `off` inward runs at radius bend − off.
        const [, , , , mx, my] = run((side + 1) % 4);
        const qx = bx + BORDER.bend * (nx + mx), qy = by + BORDER.bend * (ny + my);
        const a0 = Math.atan2(-ny, -nx), a1 = Math.atan2(-my, -mx);
        for (const [path, off] of parts(kind)) {
          const r = BORDER.bend - off;
          path.moveTo(qx + Math.cos(a0) * r, qy + Math.sin(a0) * r);
          path.arc(qx, qy, r, a0, a1);
        }
      }
      // Off the map at each end that would meet the other feature: travelling toward the
      // corner (u), a quarter turn outward (toward −n) about a centre `turn` outside the
      // middle, then straight on past the edge. A line offset `off` inward turns at turn + off.
      for (const [atEnd, sx, sy, tx, ty] of [
        [true, bx, by, ux, uy],
        [false, ax, ay, -ux, -uy],
      ] as const) {
        if (same(side, atEnd ? 1 : -1)) continue;
        const R = BORDER.turn;
        const px = sx - tx * BORDER.trail, py = sy - ty * BORDER.trail; // where the turn begins
        const qx = px - nx * R, qy = py - ny * R;
        const a0 = Math.atan2(ny, nx), a1 = Math.atan2(ty, tx);
        const ccw = nx * ty - ny * tx < 0;
        for (const [path, off] of parts(kind)) {
          const r = R + off;
          path.moveTo(qx + Math.cos(a0) * r, qy + Math.sin(a0) * r);
          path.arc(qx, qy, r, a0, a1, ccw);
          const ex = qx + tx * r, ey = qy + ty * r;
          path.lineTo(ex - nx * (c + R + BORDER.overhang * 10), ey - ny * (c + R + BORDER.overhang * 10));
        }
      }
    });
    // The exits' crossings.
    for (let i = 0; i < e.length; i += EXIT_STRIDE) {
      const x = e[i]!, y = e[i + 1]!, dx = e[i + 2]!, dy = e[i + 3]!, width = e[i + 6]!;
      const mx = x - dx * c, my = y - dy * c; // where the stub crosses the band's middle
      const side = sides[sideAt(x, y)]!;
      if (side === 'rail') continue; // a level crossing: the gaps in the fences and sleepers are all it needs
      const half = BORDER.motorway / 2 + BORDER.overhang;
      const nx = -dy * (width / 2), ny = dx * (width / 2);
      const corners: [number, number][] = [
        [mx + dx * half + nx, my + dy * half + ny],
        [mx - dx * half + nx, my - dy * half + ny],
        [mx - dx * half - nx, my - dy * half - ny],
        [mx + dx * half - nx, my + dy * half - ny],
      ];
      let deck = bridgeDecks.get(width);
      if (!deck) bridgeDecks.set(width, (deck = new Path2D()));
      deck.moveTo(...corners[0]!);
      for (const k of corners.slice(1)) deck.lineTo(...k);
      deck.closePath();
      bridgeRails.moveTo(...corners[0]!);
      bridgeRails.lineTo(...corners[1]!);
      bridgeRails.moveTo(...corners[3]!);
      bridgeRails.lineTo(...corners[2]!);
    }
  }

  /** The border's features, into the static layer under the bridge decks. */
  draw(g: CanvasRenderingContext2D, cam: Camera, dpr: number): void {
    const px = 1 / (cam.scale * dpr);
    const b = this.lines;
    g.lineCap = 'butt';
    g.strokeStyle = P.BORDER;
    g.lineWidth = px;
    g.stroke(b.rails);
    g.setLineDash([BORDER.sleeperGap * 0.35, BORDER.sleeperGap * 0.65]);
    g.lineWidth = BORDER.gauge + 1;
    g.globalAlpha = 0.5;
    g.stroke(b.sleepers);
    g.globalAlpha = 1;
    g.lineWidth = px;
    g.setLineDash([4, 2.5]);
    g.stroke(b.fences);
    g.setLineDash([]);
    g.lineWidth = Math.max(px, 1);
    g.stroke(b.median);
    // The sound barrier: a solid wall, its posts standing proud of it every few metres.
    g.lineWidth = Math.max(1.5 * px, BORDER.barrier);
    g.stroke(b.barrier);
    g.setLineDash([BORDER.postWidth, BORDER.postPitch - BORDER.postWidth]);
    g.lineWidth = Math.max(3 * px, BORDER.barrier * 2.2);
    g.stroke(b.posts);
    g.setLineDash([]);
    g.lineCap = 'round';
  }
}
