// Map generator, from the map RNG alone: editing this file cannot shift a run's draws.
//
//   1. Districts: a 3×3 grid of cells; each fills its cell with its own street grid,
//      rotated a few degrees against its neighbours so the seams show.
//   2. A diagonal river crosses the map edge to edge.
//   3. Diagonals: two short arms from one hub junction, and one diagonal that
//      crosses the river (its bridge sits at a junction). All start and end on
//      grid nodes, about a third of the map long, never near-parallel to the river.
//   4. Lines are cut out of the river except at bridges, then planarised: every
//      crossing becomes a node, so the street graph is planar.
//   5. Faces of the graph are blocks. Small ones become plazas, a few become parks,
//      the rest are subdivided into footprints along their street frontages —
//      terraces in the suburbs, a few large footprints downtown, long sheds in
//      industrial districts.
//   6. One mall: two neighbouring blocks become one compound, the street between them
//      cut back to a driveway; parking in front, one large building behind.

import type { Config } from '../../config';
import { chance, cloneRng, createRng, nextFloat, nextInt, type RngState } from '../lib/rng';
import {
  FLAVOUR_TAGS,
  type Building,
  type BuildingId,
  type BuildingTag,
  type District,
  type Exit,
  type Lot,
  type Border,
  type BorderKind,
  type DistrictId,
  type DistrictKind,
  type FunctionalTag,
  type NodeId,
  type River,
  type Street,
  type StreetId,
  type StreetNode,
  type Terrain,
} from '../state';
import {
  add,
  clipToRect,
  convexOverlap,
  cross,
  dist,
  len,
  perp,
  pointInPolygon,
  pointPolylineDist,
  pointSegmentDist,
  polygonInside,
  rectFromFront,
  scale,
  segmentIntersection,
  segmentPolygonDist,
  sub,
  unit,
  type Pt,
} from './geom';
import { DISTRICT_NAMES, STREET_ROOTS, SUFFIXES } from './names';
import { faces, planarise, type PlanarGraph, type Seg } from './planar';

export interface GeneratedMap {
  nodes: StreetNode[];
  streets: Street[];
  buildings: Building[];
  districts: District[];
  river: River;
  lots: Lot[];
  exits: Exit[];
  border: Border;
}

type LineKind = 'highway' | 'main' | 'standard' | 'alley';

interface Line {
  a: Pt;
  b: Pt;
  /** An exit's stub across the margin: the border feature it crosses; null for every street of the city. */
  crosses?: BorderKind;
  kind: LineKind;
  bridge: boolean;
  name: string;
  lit: boolean;
  district: number;
}

const DEG = Math.PI / 180;

function pick<T>(rng: RngState, items: readonly T[]): T {
  return items[nextInt(rng, 0, items.length - 1)]!;
}

function range(rng: RngState, [lo, hi]: readonly number[]): number {
  return lo! + (hi! - lo!) * nextFloat(rng);
}

/**
 * A few churches, placed once the city is built: per district kind so many, one to a
 * district before any district gets a second. Each takes a house or flavour plot big
 * enough, or several neighbouring house plots on one frontage joined into one, so a
 * suburb of small houses still has one. Joined plots leave the array; ids are dense
 * again afterwards and the lots' homes follow them. Draws only from its own stream.
 */
function placeChurches(config: Config, rng: RngState, buildings: Building[], districts: District[], lots: Lot[]): void {
  const cc = config.map.churches;
  const quota = new Map<number, number>();
  for (const [kind, total] of Object.entries(cc.count)) {
    const pool = districts.filter((d) => d.kind === kind).map((d) => d.id as number);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = nextInt(rng, 0, i);
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    for (let n = 0, i = 0; n < (total ?? 0) && pool.length > 0 && i < pool.length * cc.perDistrict; i++) {
      const d = pool[i % pool.length]!;
      if ((quota.get(d) ?? 0) >= cc.perDistrict) continue;
      quota.set(d, (quota.get(d) ?? 0) + 1);
      n++;
    }
  }
  const frame = (b: Building) => {
    const [p0, p1, , p3] = b.outline;
    return { at: p0!, dir: unit(sub(p1!, p0!)), w: dist(p0!, p1!), inward: unit(sub(p3!, p0!)), depth: dist(p0!, p3!) };
  };
  const plain = (b: Building) => b.tag === 'residential' || (FLAVOUR_TAGS as readonly string[]).includes(b.tag);
  const removed = new Set<number>();
  const centres: Pt[] = [];
  for (const d of districts) {
    let left = quota.get(d.id) ?? 0;
    if (left === 0) continue;
    // Candidates: runs of plain plots in creation order, on one frontage, each starting
    // where the last ended (a vacant plot or a yard between breaks the run).
    type Candidate = { ids: number[]; rect: Pt[]; dir: Pt; w: number };
    const candidates: Candidate[] = [];
    const inDistrict = buildings.filter((b) => b.district === d.id && plain(b));
    for (let i = 0; i < inDistrict.length; i++) {
      const first = inDistrict[i]!;
      const f = frame(first);
      if (f.w * f.depth > cc.maxArea) continue;
      let w = f.w, depth = f.depth, end = add(f.at, scale(f.dir, f.w));
      const ids = [first.id as number];
      for (let j = i + 1; w * depth < cc.minArea && ids.length < cc.maxMerge && j < inDistrict.length; j++) {
        const next = inDistrict[j]!;
        const g = frame(next);
        if (next.street !== first.street || next.id !== ids[ids.length - 1]! + 1) break;
        const gap = dist(end, g.at);
        if (Math.abs(g.dir.x * f.dir.x + g.dir.y * f.dir.y) < 0.999 || gap > 4) break;
        w += gap + g.w;
        depth = Math.min(depth, g.depth);
        end = add(g.at, scale(g.dir, g.w));
        ids.push(next.id);
      }
      if (w * depth < cc.minArea) continue;
      candidates.push({ ids, rect: rectFromFront(f.at, f.dir, w, f.inward, depth), dir: f.dir, w });
    }
    const taken = new Set<number>();
    while (left > 0 && candidates.length > 0) {
      const c = candidates.splice(nextInt(rng, 0, candidates.length - 1), 1)[0]!;
      const centre = scale(add(c.rect[0]!, c.rect[2]!), 0.5);
      if (c.ids.some((id) => taken.has(id)) || centres.some((p) => dist(p, centre) < cc.spacing)) continue;
      for (const id of c.ids) taken.add(id);
      centres.push(centre);
      const b = buildings[c.ids[0]!]!;
      const doors = config.tags[functionalProfile('church', config)].entrances;
      b.tag = 'church';
      b.outline = c.rect;
      b.entrances = [0.5, 0.25, 0.75, 0.1].slice(0, doors).map((t) => add(c.rect[0]!, scale(c.dir, c.w * t)));
      b.materials = 0;
      for (const id of c.ids.slice(1)) removed.add(id);
      left--;
    }
  }
  if (removed.size === 0) return;
  const newId = new Map<number, number>();
  const kept = buildings.filter((b) => !removed.has(b.id));
  kept.forEach((b, i) => {
    newId.set(b.id, i);
    b.id = i as BuildingId;
  });
  buildings.length = 0;
  buildings.push(...kept);
  for (const l of lots) if (l.home !== null) l.home = newId.get(l.home)! as BuildingId;
}

function pickWeighted<K extends string>(rng: RngState, weights: Partial<Record<K, number>>): K | null {
  const keys = (Object.keys(weights) as K[]).filter((k) => (weights[k] ?? 0) > 0);
  let total = 0;
  for (const k of keys) total += weights[k]!;
  if (total <= 0) return null;
  let r = nextFloat(rng) * total;
  for (const k of keys) {
    r -= weights[k]!;
    if (r < 0) return k;
  }
  return keys[keys.length - 1]!;
}

const dot2 = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;

export function functionalProfile(tag: BuildingTag, config: Config): FunctionalTag {
  return ((config.flavourProfiles as Record<string, string>)[tag] ?? tag) as FunctionalTag;
}

/** Acute angle between two directions, in degrees (0–90). */
function acute(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d / DEG;
}

/** Angle away from the nearest map axis, in degrees (0–45). */
function offAxis(h: number): number {
  const d = acute(h, 0);
  return Math.min(d, 90 - d);
}

/** Mixed into the map seed for the name stream: any constant will do, so long as it stays. */
const NAME_STREAM = 0x4e414d45;
/** Mixed into the map seed for church placement, for the same reason. */
const CHURCH_STREAM = 0x43485243;
/** Mixed into the map seed for the border's features, for the same reason. */
const BORDER_STREAM = 0x42524452;

export function generateMap(config: Config, mapSeed: number, power: boolean): GeneratedMap {
  const rng = createRng(mapSeed);
  const mapRng = rng;
  // Names draw from their own stream, seeded from the map's, so that changing a name list
  // (or a collision redrawn) never moves the city.
  const nameRng = createRng(mapSeed ^ NAME_STREAM);
  const mc = config.map;
  const size = mc.size;
  const n = mc.districtGrid;
  // The city stands inside an empty margin: the districts tile the inner square, the
  // ring road runs round its edge, and only the exits' stubs cross the margin.
  const margin = mc.border.margin;
  const lo = margin, hi = size - margin;
  const cell = (hi - lo) / n;
  const widths = mc.streetWidth;

  // 1. Districts.
  const districtNames = [...DISTRICT_NAMES];
  const districts: District[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const id = districts.length;
      districts.push({
        id: id as DistrictId,
        name: districtNames.splice(nextInt(nameRng, 0, districtNames.length - 1), 1)[0]!,
        kind: mc.districtLayout[id] as DistrictKind,
        bounds: { x: lo + c * cell, y: lo + r * cell, w: cell, h: cell },
        released: false,
        releaseAt: 0,
        evacuatedAt: null,
      });
    }
  }
  const districtAt = (p: Pt): number => {
    const c = Math.min(n - 1, Math.max(0, Math.floor((p.x - lo) / cell)));
    const r = Math.min(n - 1, Math.max(0, Math.floor((p.y - lo) / cell)));
    return r * n + c;
  };
  const kindOf = (d: number) => config.districtKinds[districts[d]!.kind];

  // 2. River: edge to edge on a diagonal, through the middle of the map, with gentle bends.
  const rc = mc.river;
  const slope = range(rng, rc.slope) * (chance(rng, 0.5) ? 1 : -1);
  const midY = size * (0.42 + 0.16 * nextFloat(rng));
  const centreline: Pt[] = [];
  const bends = 4;
  for (let i = 0; i <= bends; i++) {
    const x = -50 + ((size + 100) * i) / bends;
    const wander = i === 0 || i === bends ? 0 : (nextFloat(rng) - 0.5) * 2 * rc.meander;
    centreline.push({ x, y: midY + slope * (x - size / 2) + wander });
  }
  const riverHeading = Math.atan2(centreline[bends]!.y - centreline[0]!.y, centreline[bends]!.x - centreline[0]!.x);
  const riverDist = (p: Pt) => pointPolylineDist(p, centreline);
  const wet = (p: Pt) => riverDist(p) < rc.width / 2 + rc.bankMargin;
  const riverSide = (p: Pt): number => {
    let best = Infinity;
    let side = 0;
    for (let i = 0; i + 1 < centreline.length; i++) {
      const a = centreline[i]!, b = centreline[i + 1]!;
      const d = pointSegmentDist(p, a, b);
      if (d < best) {
        best = d;
        side = Math.sign(cross(sub(b, a), sub(p, a)));
      }
    }
    return side;
  };
  const crossesRiver = (a: Pt, b: Pt): boolean => {
    for (let i = 0; i + 1 < centreline.length; i++) if (segmentIntersection(a, b, centreline[i]!, centreline[i + 1]!)) return true;
    return false;
  };

  // 3. Lines.
  const lines: Line[] = [];
  const addLine = (a: Pt, b: Pt, kind: LineKind, district: number) =>
    lines.push({ a, b, kind, bridge: false, name: '', lit: false, district });

  // District boundaries and the ring road round the city: straight, continuous,
  // axis-aligned, all within the margin. The rotated grids meet them at angles.
  for (let k = 0; k <= n; k++) {
    const pos = lo + k * cell;
    const kind: LineKind = k === 0 || k === n ? 'standard' : 'main';
    addLine({ x: pos, y: lo }, { x: pos, y: hi }, kind, districtAt({ x: pos, y: size / 2 }));
    addLine({ x: lo, y: pos }, { x: hi, y: pos }, kind, districtAt({ x: size / 2, y: pos }));
  }

  // District grids, rotated against the map, with mid-block alleys.
  const SLIVER = 25; // m; a grid line this close to a parallel boundary would make a sliver block
  for (const d of districts) {
    const k = kindOf(d.id);
    const { x: bx, y: by, w: bw, h: bh } = d.bounds;
    const theta = range(rng, k.rotation) * DEG * (chance(rng, 0.5) ? 1 : -1);
    const u = { x: Math.cos(theta), y: Math.sin(theta) };
    const v = perp(u);
    const centre = { x: bx + bw / 2, y: by + bh / 2 };
    const spacing = cell / Math.max(2, Math.round(cell / k.blockPitch));
    const reach = Math.ceil((cell * 0.75) / spacing);
    const place = (dir: Pt, normal: Pt, offset: number, kind: LineKind): boolean => {
      const p = add(centre, scale(normal, offset));
      const clipped = clipToRect(add(p, scale(dir, -2 * cell)), add(p, scale(dir, 2 * cell)), bx, by, bx + bw, by + bh);
      if (!clipped || dist(clipped[0], clipped[1]) < 60) return false;
      // Reject lines that run close alongside a boundary.
      const nearParallel = (axis: 'x' | 'y') =>
        Math.min(...clipped.map((q) => Math.min(Math.abs(q[axis] - (axis === 'x' ? bx : by)), Math.abs(q[axis] - (axis === 'x' ? bx + bw : by + bh))))) < SLIVER;
      if (Math.abs(dir.x) > Math.abs(dir.y) ? nearParallel('y') : nearParallel('x')) return false;
      addLine(clipped[0], clipped[1], kind, d.id);
      return true;
    };
    for (const [dir, normal, alleys] of [
      [u, v, true],
      [v, u, false],
    ] as const) {
      for (let i = -reach; i <= reach; i++) {
        place(dir, normal, i * spacing, chance(rng, k.mainStreetShare) ? 'main' : 'standard');
        if (alleys && chance(rng, k.alleyShare)) place(dir, normal, (i + 0.5) * spacing, 'alley');
      }
    }
  }

  // 4. Diagonals, placed on the grid's own nodes.
  const dc = mc.diagonals;
  const grid = planarise(lines.map((l, i) => ({ a: l.a, b: l.b, line: i })), mc.snap);
  const degree = new Int32Array(grid.nodes.length);
  const onMain = new Uint8Array(grid.nodes.length);
  for (const e of grid.edges) {
    degree[e.a]!++;
    degree[e.b]!++;
    if ((lines[e.line]!.kind === 'main' || lines[e.line]!.kind === 'highway')) onMain[e.a] = onMain[e.b] = 1;
  }
  const inner = (p: Pt) => p.x > size * 0.12 && p.x < size * 0.88 && p.y > size * 0.12 && p.y < size * 0.88;
  const nearestNode = (p: Pt, ok: (id: number) => boolean): number => {
    let best = -1;
    let bestD = dc.endpointSearch;
    grid.nodes.forEach((q, id) => {
      const d = dist(p, q);
      if (d < bestD && ok(id)) {
        bestD = d;
        best = id;
      }
    });
    return best;
  };
  const headingOk = (h: number) => {
    const off = offAxis(h);
    return off >= Math.min(dc.gridAngle[0]!, 45) && off <= 45 && acute(h, riverHeading) >= dc.minRiverAngle;
  };
  const randomHeading = (): number => {
    for (let i = 0; i < 100; i++) {
      const h = nextFloat(rng) * 2 * Math.PI;
      if (headingOk(h)) return h;
    }
    return Math.PI / 4;
  };
  const clear = (p: Pt) => riverDist(p) > dc.riverClearance;
  const diagonals: { a: Pt; b: Pt; bridge: boolean }[] = [];

  // Two arms from a hub on a main street.
  const hubs = grid.nodes.map((_, id) => id).filter((id) => degree[id]! >= 3 && onMain[id] && inner(grid.nodes[id]!) && clear(grid.nodes[id]!));
  for (let attempt = 0; attempt < 300 && hubs.length > 0 && diagonals.length === 0; attempt++) {
    const hub = grid.nodes[pick(rng, hubs)]!;
    const h1 = randomHeading();
    const h2 = h1 + range(rng, dc.armSpread) * DEG * (chance(rng, 0.5) ? 1 : -1);
    if (!headingOk(h2)) continue;
    const ends = [h1, h2].map((h) => {
      const l = range(rng, dc.armLength);
      const id = nearestNode(add(hub, { x: Math.cos(h) * l, y: Math.sin(h) * l }), (i) => clear(grid.nodes[i]!) && inner(grid.nodes[i]!));
      return id < 0 ? null : grid.nodes[id]!;
    });
    if (ends.some((e) => e === null || crossesRiver(hub, e))) continue;
    for (const e of ends) diagonals.push({ a: hub, b: e!, bridge: false });
  }
  // One diagonal across the river.
  const starts = grid.nodes.map((_, id) => id).filter((id) => {
    const p = grid.nodes[id]!;
    const d = riverDist(p);
    return inner(p) && d > dc.riverClearance && d < dc.riverClearance + 400;
  });
  for (let attempt = 0; attempt < 300 && starts.length > 0; attempt++) {
    const s = grid.nodes[pick(rng, starts)]!;
    const h = randomHeading();
    const l = range(rng, dc.crossingLength);
    const side = riverSide(s);
    const id = nearestNode(add(s, { x: Math.cos(h) * l, y: Math.sin(h) * l }), (i) => {
      const q = grid.nodes[i]!;
      return riverSide(q) !== side && clear(q) && inner(q);
    });
    if (id < 0) continue;
    const e = grid.nodes[id]!;
    if (!crossesRiver(s, e) || acute(Math.atan2(e.y - s.y, e.x - s.x), riverHeading) < dc.minRiverAngle) continue;
    diagonals.push({ a: s, b: e, bridge: true });
    break;
  }
  for (const dgl of diagonals) {
    addLine(dgl.a, dgl.b, 'main', districtAt({ x: (dgl.a.x + dgl.b.x) / 2, y: (dgl.a.y + dgl.b.y) / 2 }));
    lines[lines.length - 1]!.bridge = dgl.bridge;
  }

  const lerpTo = (p: Pt, q: Pt, d: number) => add(p, scale(unit(sub(q, p)), d));
  // The border: on each side of the map (top, right, bottom, left), an impassable
  // feature across the margin — a railway on two adjacent sides, a fenced motorway on the
  // other two — from a stream of its own so the city is the same whatever the border.
  const borderRng = createRng(mapSeed ^ BORDER_STREAM);
  // Where the motorway runs is drawn as it was when a third kind (water) shared the
  // sides, so each map's motorway keeps its place: a shuffle of three, a fourth drawn.
  const kinds: string[] = ['water', 'rail', 'motorway'];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = nextInt(borderRng, 0, i);
    [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!];
  }
  while (kinds.length < 4) kinds.push(kinds[nextInt(borderRng, 0, 2)]!);
  // The motorway runs along two adjacent sides, curving round the corner between them
  // (drawn so: renderer.ts buildBorder): its own side and the neighbour that drew a kind
  // twice (else a motorway, else the side before it). The railway takes the other two.
  const m = kinds.indexOf('motorway');
  const before = (m + 3) % 4, after = (m + 1) % 4;
  const twice = (i: number) => kinds[i] === 'motorway' || kinds.filter((k) => k === kinds[i]).length > 1;
  const turn = twice(before) ? before : twice(after) ? after : before;
  const sides: BorderKind[] = [0, 1, 2, 3].map((i) => (i === m || i === turn ? 'motorway' : 'rail'));
  const border: Border = { margin, sides };
  /** The side of the map a point on the ring road faces: 0 top, 1 right, 2 bottom, 3 left. */
  const sideOf = (p: Pt): number => {
    const d = [p.y - lo, hi - p.x, hi - p.y, p.x - lo];
    return d.indexOf(Math.min(...d));
  };
  // Ways off the map: of the district-boundary arterials' ends on the ring road, the
  // first at random, each next the farthest from those chosen. Each chosen arterial
  // becomes a highway across the city, and a stub of highway carries it on across the
  // margin to the map edge — the only streets that cross it — over the border feature
  // on that side, or across a railway at a level crossing.
  const exitEnds: { line: number; at: Pt; inward: Pt }[] = [];
  const stubOf: [number, number][] = []; // [stub line, the arterial it carries on]
  if (config.features.exits) {
    // Drawn from a copy of the stream, so the rest of the city is the same with exits or
    // without: switching them off then removes the highways and nothing else.
    const rng = cloneRng(mapRng);
    const ends: { line: number; at: Pt; inward: Pt }[] = [];
    lines.forEach((l, i) => {
      if (l.kind !== 'main' || i >= 2 * (n + 1)) return; // the boundary lines come first, two per k
      // On the ring road, and dry: where the river meets it, the street is cut out of it.
      const ring = (p: Pt) => p.x <= lo + 0.5 || p.y <= lo + 0.5 || p.x >= hi - 0.5 || p.y >= hi - 0.5;
      const onEdge = (p: Pt) => ring(p) && !wet(p) && !wet(lerpTo(p, l.a === p ? l.b : l.a, 40)) && !wet(lerpTo(p, l.a === p ? l.b : l.a, -margin));
      if (onEdge(l.a)) ends.push({ line: i, at: l.a, inward: unit(sub(l.b, l.a)) });
      if (onEdge(l.b)) ends.push({ line: i, at: l.b, inward: unit(sub(l.a, l.b)) });
    });
    if (ends.length > 0) exitEnds.push(ends[nextInt(rng, 0, ends.length - 1)]!);
    // Each next: at random among those at least spreadFrom × the map from every one
    // chosen (so runs differ), failing any, the farthest; one exit a line.
    while (exitEnds.length < mc.exits.count) {
      const free = ends.filter((e) => !exitEnds.some((x) => x.line === e.line));
      if (free.length === 0) break;
      const gap = (e: (typeof ends)[number]) => Math.min(...exitEnds.map((x) => dist(x.at, e.at)));
      const apart = free.filter((e) => gap(e) >= mc.exits.spreadFrom * size);
      exitEnds.push(apart.length > 0 ? apart[nextInt(rng, 0, apart.length - 1)]! : free.reduce((p, q) => (gap(q) > gap(p) ? q : p)));
    }
    for (const e of exitEnds) {
      const l = lines[e.line]!;
      l.kind = 'highway';
      if (crossesRiver(l.a, l.b)) l.bridge = true;
      // The stub, from the ring road out to the map edge; the exit is its outer end.
      const out = add(e.at, scale(e.inward, -margin));
      const crosses = border.sides[sideOf(e.at)]!;
      lines.push({ a: e.at, b: out, kind: 'highway', bridge: false, name: '', lit: false, district: l.district, crosses });
      stubOf.push([lines.length - 1, e.line]);
      e.line = lines.length - 1;
      e.at = out;
    }
  }

  // Bridges: the crossing diagonal plus lines spread along the river, mains preferred.
  const along = (p: Pt) => (p.x + 50) / (size + 100); // river position, 0–1, by x
  const crossing = (l: Line): Pt | null => {
    for (let i = 0; i + 1 < centreline.length; i++) {
      const hit = segmentIntersection(l.a, l.b, centreline[i]!, centreline[i + 1]!);
      if (hit) return add(l.a, scale(sub(l.b, l.a), hit.t));
    }
    return null;
  };
  const bridged = lines.filter((l) => l.bridge).map((l) => along(crossing(l) ?? l.a));
  const parts = rc.bridges;
  for (let part = 0; part < parts && bridged.length < parts; part++) {
    if (bridged.some((x) => Math.floor(x * parts) === part)) continue;
    const candidates = lines.filter((l) => {
      const p = crossing(l);
      return p !== null && !l.bridge && Math.floor(along(p) * parts) === part && l.kind !== 'alley';
    });
    if (candidates.length === 0) continue;
    const weights = Object.fromEntries(candidates.map((l, i) => [String(i), l.kind === 'main' || l.kind === 'highway' ? 3 : 1])) as Record<string, number>;
    const chosen = candidates[Number(pickWeighted(rng, weights))]!;
    chosen.bridge = true;
    bridged.push(along(crossing(chosen)!));
  }

  // Names and lighting, per line.
  const usedNames = new Set<string>();
  for (const line of lines) {
    const isDiagonal = Math.abs(line.a.x - line.b.x) > 1 && Math.abs(line.a.y - line.b.y) > 1 && offAxis(Math.atan2(line.b.y - line.a.y, line.b.x - line.a.x)) > 20;
    let name = '';
    for (let attempt = 0; attempt < 50 && (name === '' || usedNames.has(name)); attempt++) {
      name = `${pick(nameRng, STREET_ROOTS)} ${isDiagonal ? pick(nameRng, ['Avenue', 'Way', 'Cut']) : pick(nameRng, SUFFIXES[line.kind])}`;
    }
    while (usedNames.has(name)) name = `${name} North`;
    usedNames.add(name);
    line.name = name;
    line.lit = power && (line.kind === 'main' || line.kind === 'highway' || chance(rng, kindOf(line.district).lightingCoverage));
  }
  for (const [stub, arterial] of stubOf) lines[stub]!.name = lines[arterial]!.name; // the same road, on out

  // 5. Cut lines out of the river (bridges excepted), then planarise everything.
  const segs: Seg[] = [];
  const STEP = 2;
  lines.forEach((l, i) => {
    if (l.bridge) {
      segs.push({ a: l.a, b: l.b, line: i });
      return;
    }
    const length = dist(l.a, l.b);
    const steps = Math.max(1, Math.ceil(length / STEP));
    let runStart: number | null = null;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const p = add(l.a, scale(sub(l.b, l.a), t));
      const dry = !wet(p);
      if (dry && runStart === null) runStart = t;
      if ((!dry || s === steps) && runStart !== null) {
        const end = dry ? t : (s - 1) / steps;
        if ((end - runStart) * length >= 10) segs.push({ a: add(l.a, scale(sub(l.b, l.a), runStart)), b: add(l.a, scale(sub(l.b, l.a), end)), line: i });
        runStart = null;
      }
    }
  });
  const graph: PlanarGraph = planarise(segs, mc.snap);

  // 6. The mall site: of the standard streets between two blocks, the one whose blocks
  // together make the largest compound within bounds — preferring one that meets a main
  // street, as retail parks sit on the arterial roads. It is cut back to a driveway from
  // that end (else its lower-id end), so the two blocks become one face with the
  // driveway reaching in. A site the compound does not fit in (an irregular block) is
  // put back and the next tried.
  const mm = mc.mall;
  let drive: { edge: number; layout: MallLayout } | null = null;
  {
    const fs = faces(graph);
    const faceOf: number[][] = graph.edges.map(() => []);
    fs.forEach((f, fi) => f.edges.forEach((e) => faceOf[e]!.includes(fi) || faceOf[e]!.push(fi)));
    const onMain = new Uint8Array(graph.nodes.length);
    for (const e of graph.edges) if ((lines[e.line]!.kind === 'main' || lines[e.line]!.kind === 'highway')) onMain[e.a] = onMain[e.b] = 1;
    const sites: { id: number; score: number }[] = [];
    graph.edges.forEach((e, id) => {
      const l = lines[e.line]!;
      const pair = faceOf[id]!;
      if (l.bridge || l.kind !== 'standard' || pair.length !== 2) return;
      const [f1, f2] = [fs[pair[0]!]!, fs[pair[1]!]!];
      const area = f1.area + f2.area;
      if (f1.area < mm.minBlock || f2.area < mm.minBlock || area > mm.maxArea) return;
      const a = graph.nodes[e.a]!, b = graph.nodes[e.b]!;
      if (dist(a, b) < mm.minLength) return;
      if (!mm.districts.includes(districts[districtAt(scale(add(a, b), 0.5))]!.kind)) return;
      if (![...f1.nodes, ...f2.nodes].every((n) => riverDist(graph.nodes[n]!) > rc.width / 2 + 2)) return;
      sites.push({ id, score: area + (onMain[e.a] || onMain[e.b] ? mm.maxArea : 0) });
    });
    sites.sort((x, y) => y.score - x.score || x.id - y.id);
    for (const { id } of sites.slice(0, mm.tries)) {
      const e = graph.edges[id]!;
      const lowFirst = e.a < e.b ? [e.a, e.b] : [e.b, e.a];
      const [from, to] = onMain[lowFirst[0]!] || !onMain[lowFirst[1]!] ? lowFirst : [lowFirst[1]!, lowFirst[0]!];
      const p = graph.nodes[from!]!;
      const inward = unit(sub(graph.nodes[to!]!, p));
      const end = add(p, scale(inward, mm.driveway));
      graph.nodes.push(end);
      graph.edges[id] = { a: from!, b: graph.nodes.length - 1, line: e.line };
      const merged = faces(graph).find((f) => f.edges.includes(id));
      // Every street's carriageway, so the grounds can be held back by each one's own
      // half-width. The driveway (this edge, already cut back) is the one that must
      // still run into the lot.
      const kerbs = graph.edges.map((e, i) => ({
        a: graph.nodes[e.a]!,
        b: graph.nodes[e.b]!,
        half: widths[lines[e.line]!.kind] / 2,
        drive: i === id,
      }));
      const layout = merged
        ? mallLayout(
            merged.nodes.map((n) => graph.nodes[n]!).filter((q) => q !== end),
            Math.max(...merged.edges.map((m) => widths[lines[graph.edges[m]!.line]!.kind])) / 2 + mc.setback,
            p,
            inward,
            mm,
            kerbs,
            mc.setback,
          )
        : null;
      if (layout && layout.building.every((q) => riverDist(q) > rc.width / 2 + 2)) {
        drive = { edge: id, layout };
        break;
      }
      graph.nodes.pop();
      graph.edges[id] = e;
    }
  }

  const nodes: StreetNode[] = graph.nodes.map((p, id) => ({ id: id as NodeId, x: p.x, y: p.y }));
  const streets: Street[] = graph.edges.map((e, id) => {
    const l = lines[e.line]!;
    const a = graph.nodes[e.a]!, b = graph.nodes[e.b]!;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const spansWater = crossesRiver(a, b) || wet(a) || wet(b) || wet(mid);
    // An exit's stub crosses its border feature on a bridge (an overpass, over the
    // motorway), or a railway at grade: a level crossing, ordinary road.
    const terrain: Terrain = (l.bridge && spansWater) || (l.crosses !== undefined && l.crosses !== 'rail') ? 'bridge' : l.kind === 'alley' ? 'alley' : 'standard';
    return {
      id: id as StreetId,
      name: l.name,
      a: e.a as NodeId,
      b: e.b as NodeId,
      width: widths[l.kind],
      terrain,
      lit: l.lit,
      blocked: 0,
      district: districtAt(mid) as DistrictId,
    };
  });

  // The driveway is open ground: perception in the grounds reads it.
  if (drive) streets[drive.edge]!.terrain = 'open';

  // 7. Blocks → the mall, plazas, parks or footprints.
  const buildings: Building[] = [];
  const sizeClass = (area: number) => (area >= mc.sizeClasses.large ? 'large' : area >= mc.sizeClasses.medium ? 'medium' : 'small');
  const openUp = (edgeIds: number[]) => {
    for (const e of edgeIds) if (streets[e]!.terrain !== 'bridge') streets[e]!.terrain = 'open';
  };
  const dryAt = (p: Pt) => riverDist(p) > rc.width / 2 + 2;

  const lots: Lot[] = [];
  // Yards: every police station and hospital, and the first depots (mc.yard.depots) that
  // have room for one — the armoury is chosen from those (squads.ts designateArmouries),
  // and parks its HMMWVs there.
  let depotYards = 0;
  const yarded = (tag: string) => tag === 'policeStation' || tag === 'hospital' || (tag === 'depot' && depotYards < mc.yard.depots);
  const makeBuilding = (rect: Pt[], dir: Pt, w: number, depth: number, street: Street, district: number, forced?: FunctionalTag) => {
    const k = kindOf(district);
    const cls = sizeClass(w * depth);
    const weights: Partial<Record<string, number>> = {};
    for (const [tag, weight] of Object.entries(k.tagWeights)) {
      const sizes: readonly string[] = tag === 'flavour' ? config.flavourSizes : config.tags[tag as FunctionalTag].sizes;
      if (sizes.includes(cls)) weights[tag] = weight;
    }
    const tagKey = forced ?? pickWeighted(rng, weights) ?? 'residential';
    let tag: BuildingTag;
    if (tagKey === 'flavour') {
      const odds: Partial<Record<string, number>> = {};
      for (const f of FLAVOUR_TAGS) {
        if (w * depth < (config.flavourMinArea[f] ?? 0)) continue;
        odds[f] = config.flavourWeights[f] ?? 1;
      }
      tag = (pickWeighted(rng, odds) ?? 'cafe') as BuildingTag;
    } else tag = tagKey as FunctionalTag;
    const profile = config.tags[functionalProfile(tag, config)];
    const entrances = [0.5, 0.25, 0.75, 0.1].slice(0, profile.entrances).map((f) => add(rect[0]!, scale(dir, w * f)));
    const centre = scale(add(rect[0]!, rect[2]!), 0.5);
    buildings.push({
      id: buildings.length as BuildingId,
      tag,
      district: districtAt(centre) as DistrictId,
      street: street.id,
      outline: rect,
      entrances,
      residents: 0,
      sheltered: [],
      zombiesInside: 0,
      occupiedAt: null,
      materials: tagKey === 'flavour' ? 0 : nextInt(rng, profile.materials[0]!, profile.materials[1]!),
      fortification: 0,
      breached: false,
      lit: power && chance(rng, 0.6),
      alertedAt: null,
      scavengerOut: null,
      garrisonedAt: null,
      doorOpenedAt: null,
      callAt: null,
      weaponStock: null,
      stock: [],
      ambulanceAt: null,
      ambulancePatient: null,
      pendingEvacuate: 0,
      dispatchedAt: null,
      cascadeAt: null,
      pendingRelease: 0,
      pendingExpel: 0,
      pendingTurn: 0,
      pendingDie: 0,
      risings: [],
      sweptAt: null,
      pendingSpill: 0,
    });
  };

  for (const face of faces(graph)) {
    if (face.area < mc.minBlockArea) continue;
    const poly = face.nodes.map((id) => graph.nodes[id]!);
    const centre = poly.reduce((acc, p) => add(acc, scale(p, 1 / poly.length)), { x: 0, y: 0 });
    if (drive && face.edges.includes(drive.edge)) {
      const { building, dir, width, depth, lot } = drive.layout;
      makeBuilding(building, dir, width, depth, streets[drive.edge]!, districtAt(centre), 'mall');
      lots.push(lot);
      continue;
    }
    if (face.area < mc.plazaArea) {
      if (dryAt(centre)) openUp(face.edges);
      continue;
    }
    if (chance(rng, mc.parkShare)) {
      openUp(face.edges);
      continue;
    }
    const district = districtAt(centre);
    const k = kindOf(district);
    const placed: Pt[][] = [];
    const edgeAt = (i: number) => ({ a: poly[i]!, b: poly[(i + 1) % poly.length]!, street: streets[face.edges[i]!]! });
    /** Inside the block, dry, clear of every street but its own frontage, and of other plots. */
    const fits = (rect: Pt[], frontage: number): boolean =>
      polygonInside(rect, poly) &&
      [...rect, ...rect.map((p, j) => scale(add(p, rect[(j + 1) % 4]!), 0.5)), scale(add(rect[0]!, rect[2]!), 0.5)].every(dryAt) &&
      !placed.some((other) => convexOverlap(rect, other)) &&
      face.edges.every((_, j) => {
        if (j === frontage) return true;
        const e = edgeAt(j);
        return segmentPolygonDist(e.a, e.b, rect) >= e.street.width / 2 + mc.setback * 0.5;
      });
    const inwardOf = (i: number): Pt | null => {
      const { a, b } = edgeAt(i);
      const l = dist(a, b);
      const dir = unit(sub(b, a));
      for (const sign of [1, -1]) {
        const n = scale(perp(dir), sign);
        if (pointInPolygon(add(add(a, scale(dir, l / 2)), n), poly)) return n;
      }
      return null; // a dead-end stub
    };
    // Longest frontages first, so corners go to the main faces of the block.
    const order = face.edges.map((_, i) => i).sort((i, j) => dist(edgeAt(j).a, edgeAt(j).b) - dist(edgeAt(i).a, edgeAt(i).b) || i - j);

    // Some blocks are one large footprint: the block's own rectangle, set back from its streets.
    if (chance(rng, k.wholeBlockShare)) {
      const i = order[0]!;
      const { a, b, street } = edgeAt(i);
      const inward = inwardOf(i);
      if (inward) {
        const dir = unit(sub(b, a));
        const us = poly.map((p) => dot2(sub(p, a), dir));
        const vs = poly.map((p) => dot2(sub(p, a), inward));
        const margin = Math.max(...face.edges.map((e) => streets[e]!.width)) / 2 + mc.setback;
        const u0 = Math.min(...us) + margin, u1 = Math.max(...us) - margin;
        const v0 = street.width / 2 + mc.setback, v1 = Math.max(...vs) - margin;
        if (u1 - u0 > 20 && v1 - v0 > 20) {
          const rect = rectFromFront(add(add(a, scale(dir, u0)), scale(inward, v0)), dir, u1 - u0, inward, v1 - v0);
          if (fits(rect, i)) {
            placed.push(rect);
            makeBuilding(rect, dir, u1 - u0, v1 - v0, street, district);
            // A whole-block police station or hospital gives up the far end of its
            // frontage to a yard for its vehicles, if it is wide enough to spare it.
            const made = buildings[buildings.length - 1]!;
            const y = mc.yard;
            const w = u1 - u0 - y.width - mc.yard.gap;
            if (config.features.yards && yarded(made.tag) && w >= mc.yard.minRest) {
              const origin = rect[0]!;
              const shrunk = rectFromFront(origin, dir, w, inward, v1 - v0);
              const entrances = made.entrances.length;
              made.outline = shrunk;
              made.entrances = [0.5, 0.25, 0.75, 0.1].slice(0, entrances).map((f) => add(origin, scale(dir, w * f)));
              placed[placed.length - 1] = shrunk;
              const yard = rectFromFront(add(origin, scale(dir, w + mc.yard.gap)), dir, y.width, inward, Math.min(y.depth, v1 - v0));
              placed.push(yard);
              lots.push({ outline: yard, parkingDepth: Math.min(y.depth, v1 - v0), entry: y.width / 2, home: made.id });
              if (made.tag === 'depot') depotYards++;
            }
            continue;
          }
        }
      }
    }

    for (const i of order) {
      const { a, b, street } = edgeAt(i);
      const edgeLen = dist(a, b);
      if (edgeLen < 15) continue;
      const inward = inwardOf(i);
      if (!inward) continue;
      const dir = unit(sub(b, a));
      const front = add(a, scale(inward, street.width / 2 + mc.setback));
      let s = 0;
      while (s < edgeLen) {
        const w = range(rng, k.plot.width);
        const depth = range(rng, k.plot.depth);
        if (s + w > edgeLen) break;
        const rect = rectFromFront(add(front, scale(dir, s)), dir, w, inward, depth);
        if (!fits(rect, i)) {
          s += Math.max(2, w / 3);
          continue;
        }
        placed.push(rect);
        s += w + k.plot.gap;
        if (!chance(rng, k.buildingDensity)) continue;
        makeBuilding(rect, dir, w, depth, street, district);
        // A police station or hospital: a yard beside it on the same frontage, for its
        // vehicles, if one fits (cars.ts parks them there).
        const made = buildings[buildings.length - 1]!;
        const y = mc.yard;
        if (config.features.yards && yarded(made.tag) && s + y.width <= edgeLen) {
          const yard = rectFromFront(add(front, scale(dir, s)), dir, y.width, inward, y.depth);
          if (fits(yard, i)) {
            placed.push(yard);
            lots.push({ outline: yard, parkingDepth: y.depth, entry: y.width / 2, home: made.id });
            if (made.tag === 'depot') depotYards++;
            s += y.width + k.plot.gap;
          }
        }
      }
    }
  }

  placeChurches(config, createRng(mapSeed ^ CHURCH_STREAM), buildings, districts, lots);

  // Each exit: the edge node at the highway's end, and its last segment.
  const exits: Exit[] = [];
  for (const e of exitEnds) {
    let node = -1, nodeD = Infinity;
    nodes.forEach((p, id) => {
      const d = dist(p, e.at);
      if (d < nodeD) {
        nodeD = d;
        node = id;
      }
    });
    const street = graph.edges.findIndex((g) => g.line === e.line && (g.a === node || g.b === node));
    if (node < 0 || street < 0) continue;
    // Outward along the highway itself, which need not meet the edge square: the
    // barrier goes across the road, and the soldiers' line with it.
    const g = graph.edges[street]!;
    const other = nodes[g.a === node ? g.b : g.a]!;
    const len = dist(nodes[node]!, other) || 1;
    const dx = (nodes[node]!.x - other.x) / len, dy = (nodes[node]!.y - other.y) / len;
    exits.push({ node: node as NodeId, street: street as StreetId, x: nodes[node]!.x, y: nodes[node]!.y, dx, dy, closedAt: null, breachedAt: null });
  }

  return { nodes, streets, buildings, districts, river: { centreline, width: rc.width }, lots, exits, border };
}

interface MallLayout {
  building: Pt[];
  dir: Pt;
  width: number;
  depth: number;
  lot: Lot;
}

/** One street centreline the grounds must stay clear of. `drive` is the mall's own driveway. */
interface Kerb {
  a: Pt;
  b: Pt;
  half: number;
  drive: boolean;
}

/**
 * Pulls a driveway-frame rectangle in, one edge at a time, until it sits `half + curb`
 * clear of every kerb except the driveway. Edges only move inward. Null if the
 * driveway would no longer reach the front, or the streets will not clear.
 */
function insetCarriageways(
  u0: number, u1: number, v0: number, v1: number,
  at: (u: number, v: number) => Pt,
  dir: Pt, inward: Pt,
  kerbs: readonly Kerb[],
  curb: number,
  driveway: number,
): { u0: number; u1: number; v0: number; v1: number; grounds: Pt[] } | null {
  let grounds = rectFromFront(at(u0, v0), dir, u1 - u0, inward, v1 - v0);
  // A few centimetres short of the curb still leaves the rectangle outside the carriageway.
  const SLACK = 0.05;
  for (let n = 0; n < 12; n++) {
    let du0 = 0, du1 = 0, dv0 = 0, dv1 = 0;
    const centre = at((u0 + u1) / 2, (v0 + v1) / 2);
    for (const kerb of kerbs) {
      if (kerb.drive) continue;
      const gap = segmentPolygonDist(kerb.a, kerb.b, grounds);
      const short = kerb.half + curb - gap;
      if (short <= SLACK) continue;
      const edge = sub(kerb.b, kerb.a);
      if (len(edge) < 1e-6) continue;
      // The line's normal that faces the rectangle, then whichever frame axis it
      // mostly follows. Moving that edge by short/|component| gains `short` of clearance.
      let normal = perp(unit(edge));
      if (dot2(normal, sub(centre, scale(add(kerb.a, kerb.b), 0.5))) < 0) normal = scale(normal, -1);
      const along = dot2(normal, dir);
      const depth = dot2(normal, inward);
      const comp = Math.abs(along) >= Math.abs(depth) ? along : depth;
      const step = short / Math.max(Math.abs(comp), 1e-6);
      if (Math.abs(along) >= Math.abs(depth)) {
        if (along > 0) du0 = Math.max(du0, step);
        else du1 = Math.max(du1, step);
      } else if (depth > 0) dv0 = Math.max(dv0, step);
      else dv1 = Math.max(dv1, step);
    }
    if (du0 === 0 && du1 === 0 && dv0 === 0 && dv1 === 0) return { u0, u1, v0, v1, grounds };
    // The stub has to come in across the front edge. Past its end, this site cannot.
    if (v0 + dv0 >= driveway || u0 + du0 >= 0 || u1 - du1 <= 0) return null;
    u0 += du0;
    u1 -= du1;
    v0 += dv0;
    v1 -= dv1;
    if (v1 <= v0) return null;
    grounds = rectFromFront(at(u0, v0), dir, u1 - u0, inward, v1 - v0);
  }
  return null;
}

/**
 * The compound in a merged block (its outline, the driveway's far end left out):
 * grounds filling the block inside its streets; parking from the front to the
 * driveway's end; the building beyond, as wide as the grounds allow (centred on the
 * driveway where it can be) and at most maxDepth deep. The first inset is one margin,
 * the widest bounding street, off the centreline polygon's bounding box. Streets that
 * meet that frame at an angle still cut the corners, so each carriageway then pulls
 * its own edge back by its own half-width plus the curb. Null if it does not fit.
 */
function mallLayout(
  face: Pt[], margin: number, from: Pt, inward: Pt, mm: Config['map']['mall'],
  kerbs: readonly Kerb[], curb: number,
): MallLayout | null {
  // The driveway reaches in and back out: drop the repeated junction it leaves behind.
  const poly = face.filter((p, i, all) => p !== all[(i + 1) % all.length]);
  const dir = perp(inward);
  const us = poly.map((p) => dot2(sub(p, from), dir));
  const vs = poly.map((p) => dot2(sub(p, from), inward));
  let u0 = Math.min(...us) + margin, u1 = Math.max(...us) - margin;
  let v0 = margin;
  let v1 = Math.max(...vs) - margin;
  const at = (u: number, v: number) => add(add(from, scale(dir, u)), scale(inward, v));
  let grounds = rectFromFront(at(u0, v0), dir, u1 - u0, inward, v1 - v0);
  for (let k = 0; k < 30 && !polygonInside(grounds, poly); k++) {
    u0 += 2;
    u1 -= 2;
    v1 -= 2;
    grounds = rectFromFront(at(u0, v0), dir, u1 - u0, inward, v1 - v0);
  }
  if (!polygonInside(grounds, poly)) return null;
  const cleared = insetCarriageways(u0, u1, v0, v1, at, dir, inward, kerbs, curb, mm.driveway);
  if (!cleared || !polygonInside(cleared.grounds, poly)) return null;
  ({ u0, u1, v0, v1, grounds } = cleared);
  const bv0 = mm.driveway + mm.apron;
  const depth = Math.min(mm.maxDepth, v1 - bv0);
  const width = Math.min(mm.maxWidth, u1 - u0 - 2 * mm.sideYard);
  if (depth < mm.minDepth || width < mm.minWidth) return null;
  const uc = Math.min(Math.max(0, u0 + mm.sideYard + width / 2), u1 - mm.sideYard - width / 2);
  const building = rectFromFront(at(uc - width / 2, bv0), dir, width, inward, depth);
  if (!polygonInside(building, poly)) return null;
  return { building, dir, width, depth, lot: { outline: grounds, parkingDepth: bv0 - mm.apron / 2 - v0, entry: -u0, home: null } };
}

/** Footprint area of a building outline (a convex quad). */
export function footprintArea(outline: readonly Pt[]): number {
  const a = outline[0]!, b = outline[1]!, d = outline[3]!;
  return len(sub(b, a)) * len(sub(d, a));
}
