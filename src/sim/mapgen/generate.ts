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

import type { Config } from '../../config';
import { chance, createRng, nextFloat, nextInt, type RngState } from '../rng';
import {
  FLAVOUR_TAGS,
  type Building,
  type BuildingId,
  type BuildingTag,
  type District,
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
}

type LineKind = 'main' | 'standard' | 'alley';

interface Line {
  a: Pt;
  b: Pt;
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

export function generateMap(config: Config, mapSeed: number, power: boolean): GeneratedMap {
  const rng = createRng(mapSeed);
  const mc = config.map;
  const size = mc.size;
  const n = mc.districtGrid;
  const cell = size / n;
  const widths = mc.streetWidth;

  // 1. Districts.
  const districtNames = [...DISTRICT_NAMES];
  const districts: District[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const id = districts.length;
      districts.push({
        id: id as DistrictId,
        name: districtNames.splice(nextInt(rng, 0, districtNames.length - 1), 1)[0]!,
        kind: mc.districtLayout[id] as DistrictKind,
        bounds: { x: c * cell, y: r * cell, w: cell, h: cell },
        released: false,
        releaseAt: 0,
      });
    }
  }
  const districtAt = (p: Pt): number => {
    const c = Math.min(n - 1, Math.max(0, Math.floor(p.x / cell)));
    const r = Math.min(n - 1, Math.max(0, Math.floor(p.y / cell)));
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

  // Boundaries and map edge: straight, continuous, axis-aligned. The rotated grids meet them at angles.
  for (let k = 0; k <= n; k++) {
    const pos = k * cell;
    const kind: LineKind = k === 0 || k === n ? 'standard' : 'main';
    addLine({ x: pos, y: 0 }, { x: pos, y: size }, kind, districtAt({ x: pos, y: size / 2 }));
    addLine({ x: 0, y: pos }, { x: size, y: pos }, kind, districtAt({ x: size / 2, y: pos }));
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
    if (lines[e.line]!.kind === 'main') onMain[e.a] = onMain[e.b] = 1;
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
    const weights = Object.fromEntries(candidates.map((l, i) => [String(i), l.kind === 'main' ? 3 : 1])) as Record<string, number>;
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
      name = `${pick(rng, STREET_ROOTS)} ${isDiagonal ? pick(rng, ['Avenue', 'Way', 'Cut']) : pick(rng, SUFFIXES[line.kind])}`;
    }
    while (usedNames.has(name)) name = `${name} North`;
    usedNames.add(name);
    line.name = name;
    line.lit = power && (line.kind === 'main' || chance(rng, kindOf(line.district).lightingCoverage));
  }

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

  const nodes: StreetNode[] = graph.nodes.map((p, id) => ({ id: id as NodeId, x: p.x, y: p.y }));
  const streets: Street[] = graph.edges.map((e, id) => {
    const l = lines[e.line]!;
    const a = graph.nodes[e.a]!, b = graph.nodes[e.b]!;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const spansWater = crossesRiver(a, b) || wet(a) || wet(b) || wet(mid);
    const terrain: Terrain = l.bridge && spansWater ? 'bridge' : l.kind === 'alley' ? 'alley' : 'standard';
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

  // 6. Blocks → plazas, parks or footprints.
  const buildings: Building[] = [];
  const sizeClass = (area: number) => (area >= mc.sizeClasses.large ? 'large' : area >= mc.sizeClasses.medium ? 'medium' : 'small');
  const openUp = (edgeIds: number[]) => {
    for (const e of edgeIds) if (streets[e]!.terrain !== 'bridge') streets[e]!.terrain = 'open';
  };
  const dryAt = (p: Pt) => riverDist(p) > rc.width / 2 + 2;

  const makeBuilding = (rect: Pt[], dir: Pt, w: number, depth: number, street: Street, district: number) => {
    const k = kindOf(district);
    const cls = sizeClass(w * depth);
    const weights: Partial<Record<string, number>> = {};
    for (const [tag, weight] of Object.entries(k.tagWeights)) {
      const sizes: readonly string[] = tag === 'flavour' ? config.flavourSizes : config.tags[tag as FunctionalTag].sizes;
      if (sizes.includes(cls)) weights[tag] = weight;
    }
    const tagKey = pickWeighted(rng, weights) ?? 'residential';
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
      callAt: null,
      dispatchedAt: null,
      cascadeAt: null,
      pendingRelease: 0,
      pendingExpel: 0,
      pendingTurn: 0,
      pendingDie: 0,
      pendingSpill: 0,
    });
  };

  for (const face of faces(graph)) {
    if (face.area < mc.minBlockArea) continue;
    const poly = face.nodes.map((id) => graph.nodes[id]!);
    const centre = poly.reduce((acc, p) => add(acc, scale(p, 1 / poly.length)), { x: 0, y: 0 });
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
        if (chance(rng, k.buildingDensity)) makeBuilding(rect, dir, w, depth, street, district);
      }
    }
  }

  return { nodes, streets, buildings, districts, river: { centreline, width: rc.width } };
}

/** Footprint area of a building outline (a convex quad). */
export function footprintArea(outline: readonly Pt[]): number {
  const a = outline[0]!, b = outline[1]!, d = outline[3]!;
  return len(sub(b, a)) * len(sub(d, a));
}
