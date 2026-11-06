// Going round a building to its door: for anyone who can see the door is on the far
// side — the dead besieging it (zombies.ts), the living on the last stretch to it
// (steering.ts lastLeg). Straight for the door, both pressed into the near wall.

import type { Context } from '../context';
import { pointSegmentDistance } from '../lib/geometry';
import type { Building, BuildingId, Vec2, World } from '../state';

/** Scratch for the buildings by a corner: its own, since callers walk ctx.buildingIds while calling. */
const pinch: BuildingId[] = [];

/**
 * Where to make for on the way round `b` to its door nearest (x, y), when the building
 * stands between: the next corner (movement.roundCorner metres out from it) along the shorter
 * way round its outline, from the side the zombie is nearest to the door's side. Null
 * with the way clear (sighted on a point as far out from the door: the door itself is on
 * the wall, and no line to it is clear), or once on the door's side. 'shut' when, up
 * against the building, neither way round gets it any further — a terraced house, its
 * neighbours against both sides, seen from the back: the door is a long way round the
 * row, not round this house.
 *
 * With `toDoor` false, (x, y) is itself the place to get to — a sound beyond the
 * building — and the way goes round to the side of it nearest that place.
 */
export function roundCorner(world: World, ctx: Context, b: Building, px: number, py: number, x: number, y: number, toDoor = true, heading?: number): Vec2 | null | 'shut' {
  const r = world.config.movement.roundCorner;
  let entrance = b.entrances[0]!;
  for (const e of b.entrances) if (Math.hypot(e.x - x, e.y - y) < Math.hypot(entrance.x - x, entrance.y - y)) entrance = e;
  const door = toDoor ? ctx.map.outside(b.id, b.entrances.indexOf(entrance), r) : { x, y };
  if (ctx.map.lineOfSight(px, py, door.x, door.y)) return null;
  const o = b.outline;
  const n = o.length;
  // A place beyond: only this building's own way round, when it is this building in the
  // way. Something further off hiding it, the way round this one swung the dead back and
  // forth at its corner.
  if (!toDoor && !o.some((p, i) => crosses(px, py, door.x, door.y, p.x, p.y, o[(i + 1) % n]!.x, o[(i + 1) % n]!.y))) return null;
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
  const to = toDoor ? edge(entrance.x, entrance.y) : edge(x, y);
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
  // past, with no corner to arrive at and turn on; `undefined` when that way is shut: the
  // first out of sight or in another building (a gap between houses too narrow), any
  // corner pinched against another building, or, at a corner already, no clear way on
  // from it to the next corner or the door.
  const toward = (corners: Vec2[]): Vec2 | undefined => {
    // A corner with another building against it shuts the way: squeezing past, seen
    // from one step and not the next, the dead swung between the two ways every tick.
    for (const c of corners) if (ctx.map.buildingsNear(c.x, c.y, r, pinch).some((id) => id !== b.id)) return undefined;
    let k = -1;
    for (let i = 0; i < corners.length; i++) {
      const c = corners[i]!;
      if (!ctx.map.walkable(c.x, c.y) || !ctx.map.lineOfSight(px, py, c.x, c.y)) break;
      k = i;
    }
    if (k < 0) return undefined;
    const seen = corners[k]!;
    if (Math.hypot(seen.x - px, seen.y - py) > r) return seen;
    const next = corners[k + 1] ?? door;
    return ctx.map.walkable(next.x, next.y) && ctx.map.lineOfSight(seen.x, seen.y, next.x, next.y) ? seen : undefined;
  };
  const fwd = way(1);
  const back = way(-1);
  // Near enough the same either way: the way it is already facing, so a step does not
  // swing it to the other (with `heading`).
  const ahead = (w: { corners: Vec2[] }) => {
    const c = w.corners[0];
    return c === undefined || heading === undefined ? 0 : Math.cos(heading) * (c.x - px) + Math.sin(heading) * (c.y - py);
  };
  const close = heading !== undefined && Math.abs(fwd.length - back.length) < 2 * r;
  const fwdFirst = close ? ahead(fwd) >= ahead(back) : fwd.length <= back.length;
  const [first, second] = fwdFirst ? [fwd, back] : [back, fwd];
  const w = toward(first.corners) ?? toward(second.corners);
  if (w !== undefined) return w;
  // Shut only for one up against it: further off, something else is in the way, and it
  // goes on as before.
  let near = Infinity;
  for (let i = 0; i < n; i++) near = Math.min(near, pointSegmentDistance(px, py, o[i]!.x, o[i]!.y, o[(i + 1) % n]!.x, o[(i + 1) % n]!.y));
  return near <= 2 * r ? 'shut' : null;
}


/** Scratch for the buildings one is up against: its own, as `pinch` is. */
const touching: BuildingId[] = [];

/**
 * Round whatever other building one is up against, when that is what stands between it
 * and (x, y): a door across the road behind a building, say — the dead besieging a gun
 * shop came up on the far side of the hotel facing it and slid along the hotel's back
 * wall for good (the oddity check, the hotel at (1430, 1945)). `skip` is the building
 * the door belongs to, already gone round by roundCorner. Null when nothing it touches
 * is in the way.
 */
export function roundObstacle(world: World, ctx: Context, px: number, py: number, x: number, y: number, skip: BuildingId | null, heading?: number): Vec2 | null {
  for (const id of ctx.map.buildingsNear(px, py, world.config.movement.roundCorner, touching)) {
    if (id === skip) continue;
    const w = roundCorner(world, ctx, world.buildings[id]!, px, py, x, y, false, heading);
    if (w !== null && w !== 'shut') return w;
  }
  return null;
}

/** Whether segment a–b crosses segment c–d. */
function crosses(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = side(cx, cy, dx, dy, ax, ay), d2 = side(cx, cy, dx, dy, bx, by);
  const d3 = side(ax, ay, bx, by, cx, cy), d4 = side(ax, ay, bx, by, dx, dy);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
