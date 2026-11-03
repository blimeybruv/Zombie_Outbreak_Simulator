// Going round a building to its door: for anyone who can see the door is on the far
// side — the dead besieging it (zombies.ts), the living on the last stretch to it
// (steering.ts lastLeg). Straight for the door, both pressed into the near wall.

import type { Context } from '../context';
import { pointSegmentDistance } from '../lib/geometry';
import type { Building, Vec2, World } from '../state';

/**
 * Where to make for on the way round `b` to its door nearest (x, y), when the building
 * stands between: the next corner (movement.roundCorner metres out from it) along the shorter
 * way round its outline, from the side the zombie is nearest to the door's side. Null
 * with the way clear (sighted on a point as far out from the door: the door itself is on
 * the wall, and no line to it is clear), or once on the door's side.
 */
export function roundCorner(world: World, ctx: Context, b: Building, px: number, py: number, x: number, y: number): Vec2 | null {
  const r = world.config.movement.roundCorner;
  let entrance = b.entrances[0]!;
  for (const e of b.entrances) if (Math.hypot(e.x - x, e.y - y) < Math.hypot(entrance.x - x, entrance.y - y)) entrance = e;
  const door = ctx.map.outside(b.id, b.entrances.indexOf(entrance), r);
  if (ctx.map.lineOfSight(px, py, door.x, door.y)) return null;
  const o = b.outline;
  const n = o.length;
  const edge = (px: number, py: number): number => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = pointSegmentDistance(px, py, o[i]!.x, o[i]!.y, o[(i + 1) % n]!.x, o[(i + 1) % n]!.y);
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  };
  const from = edge(px, py);
  const to = edge(entrance.x, entrance.y);
  if (from === to) return null;
  let cx = 0;
  let cy = 0;
  for (const p of o) {
    cx += p.x / n;
    cy += p.y / n;
  }
  const corner = (i: number): Vec2 => {
    const p = o[((i % n) + n) % n]!;
    const l = Math.hypot(p.x - cx, p.y - cy) || 1;
    return { x: p.x + ((p.x - cx) / l) * r, y: p.y + ((p.y - cy) / l) * r };
  };
  // Forward (edge i runs from corner i to corner i + 1): corners from + 1 to `to`, then
  // the door. Back: corners from down to to + 1, then the door.
  const way = (dir: 1 | -1): { corners: Vec2[]; length: number } => {
    const last = dir === 1 ? to : to + 1;
    const corners: Vec2[] = [];
    let length = 0;
    let at: Vec2 = { x: px, y: py };
    for (let i = dir === 1 ? from + 1 : from, k = 0; k < n; i += dir, k++) {
      const c = corner(i);
      corners.push(c);
      length += Math.hypot(c.x - at.x, c.y - at.y);
      at = c;
      if ((((i - last) % n) + n) % n === 0) break;
    }
    return { corners, length: length + Math.hypot(door.x - at.x, door.y - at.y) };
  };
  // The furthest corner along the way still in sight, so it cuts each corner it can see
  // past, with no corner to arrive at and turn on; `undefined` when the first is out of
  // sight or in another building — a gap between houses too narrow, say.
  const toward = (corners: Vec2[]): Vec2 | undefined => {
    let seen: Vec2 | undefined;
    for (const c of corners) {
      if (!ctx.map.walkable(c.x, c.y) || !ctx.map.lineOfSight(px, py, c.x, c.y)) break;
      seen = c;
    }
    return seen;
  };
  const fwd = way(1);
  const back = way(-1);
  const [first, second] = fwd.length <= back.length ? [fwd, back] : [back, fwd];
  return toward(first.corners) ?? toward(second.corners) ?? null;
}

