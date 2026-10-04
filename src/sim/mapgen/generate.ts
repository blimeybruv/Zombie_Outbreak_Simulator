// Map generator: districts, street graph, river, parks and buildings, all from the
// map RNG. The simulation RNG is never touched here, so editing this file cannot
// shift a run's draws.
//
// Layout: a 3×3 grid of districts. District boundaries and the map edge are
// continuous lines spanning the map; each district fills its cell with its own
// grid of interior lines at its block pitch. One river crosses the map
// horizontally; only three vertical streets cross it, as bridges. Everything is
// edge-based: a block either holds one building, is a park (its streets become
// `open`), or is water.

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
  type Vec2,
} from '../state';
import { DISTRICT_NAMES, STREET_ROOTS, SUFFIXES } from './names';

export interface GeneratedMap {
  nodes: StreetNode[];
  streets: Street[];
  buildings: Building[];
  districts: District[];
  river: River;
}

type LineKind = 'main' | 'standard' | 'alley';

interface Line {
  vertical: boolean;
  pos: number; // x for vertical lines, y for horizontal
  from: number;
  to: number;
  kind: LineKind;
  width: number;
  lit: boolean;
  bridge: boolean;
  name: string;
  district: number; // owning district for interior lines; boundary lines use the district at their midpoint
  edges: { id: StreetId; lo: number; hi: number }[];
}

const SETBACK = 3; // m between a building and the edge of its street
const MIN_BUILDING = 10; // m; blocks smaller than this after inset stay empty

function pick<T>(rng: RngState, items: readonly T[]): T {
  return items[nextInt(rng, 0, items.length - 1)]!;
}

function pickWeighted<K extends string>(rng: RngState, weights: Record<K, number>): K {
  const keys = Object.keys(weights) as K[];
  let total = 0;
  for (const k of keys) total += weights[k];
  let r = nextFloat(rng) * total;
  for (const k of keys) {
    r -= weights[k];
    if (r < 0) return k;
  }
  return keys[keys.length - 1]!;
}

export function functionalProfile(tag: BuildingTag, config: Config): FunctionalTag {
  return ((config.flavourProfiles as Record<string, string>)[tag] ?? tag) as FunctionalTag;
}

export function generateMap(config: Config, mapSeed: number, power: boolean): GeneratedMap {
  const rng = createRng(mapSeed);
  const size = config.map.size;
  const n = config.map.districtGrid;
  const cell = size / n;
  const widths = config.map.streetWidth;

  // Districts
  const districtNames = [...DISTRICT_NAMES];
  const districts: District[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const id = districts.length;
      const nameIndex = nextInt(rng, 0, districtNames.length - 1);
      const name = districtNames.splice(nameIndex, 1)[0]!;
      districts.push({
        id: id as DistrictId,
        name,
        kind: config.map.districtLayout[id] as DistrictKind,
        bounds: { x: c * cell, y: r * cell, w: cell, h: cell },
        released: false,
        releaseAt: 0,
      });
    }
  }
  const districtAt = (x: number, y: number): number => {
    const c = Math.min(n - 1, Math.max(0, Math.floor(x / cell)));
    const r = Math.min(n - 1, Math.max(0, Math.floor(y / cell)));
    return r * n + c;
  };
  const kindOf = (d: number) => config.districtKinds[districts[d]!.kind];

  // River: a horizontal band through the middle row, clear of district boundaries.
  const riverWidth = config.map.river.width;
  const riverY = cell + cell * (0.3 + 0.4 * nextFloat(rng));
  const riverLo = riverY - riverWidth / 2;
  const riverHi = riverY + riverWidth / 2;
  const riverClear = 15; // m; no horizontal street this close to the water

  // Lines: global boundaries first, then each district's interior grid.
  const lines: Line[] = [];
  const addLine = (vertical: boolean, pos: number, from: number, to: number, kind: LineKind, district: number) => {
    lines.push({ vertical, pos, from, to, kind, width: widths[kind], lit: false, bridge: false, name: '', district, edges: [] });
  };
  for (let k = 0; k <= n; k++) {
    const pos = k * cell;
    const kind: LineKind = k === 0 || k === n ? 'standard' : 'main';
    addLine(true, pos, 0, size, kind, districtAt(pos, size / 2));
    if (Math.abs(pos - riverY) > riverWidth / 2 + riverClear) addLine(false, pos, 0, size, kind, districtAt(size / 2, pos));
  }
  // Per-district interior positions (for blocks), including the bounding lines.
  const districtXs: number[][] = [];
  const districtYs: number[][] = [];
  for (const d of districts) {
    const k = kindOf(d.id);
    const count = Math.max(2, Math.round(cell / k.blockPitch));
    const spacing = cell / count;
    const xs = [d.bounds.x];
    const ys = [d.bounds.y];
    for (let i = 1; i < count; i++) {
      const x = d.bounds.x + i * spacing;
      const y = d.bounds.y + i * spacing;
      const kindX: LineKind = chance(rng, k.mainStreetShare) ? 'main' : chance(rng, k.alleyShare) ? 'alley' : 'standard';
      addLine(true, x, d.bounds.y, d.bounds.y + d.bounds.h, kindX, d.id);
      xs.push(x);
      const kindY: LineKind = chance(rng, k.mainStreetShare) ? 'main' : chance(rng, k.alleyShare) ? 'alley' : 'standard';
      if (Math.abs(y - riverY) > riverWidth / 2 + riverClear) {
        addLine(false, y, d.bounds.x, d.bounds.x + d.bounds.w, kindY, d.id);
        ys.push(y);
      }
    }
    xs.push(d.bounds.x + d.bounds.w);
    ys.push(d.bounds.y + d.bounds.h);
    if (d.bounds.y < riverY && riverY < d.bounds.y + d.bounds.h) {
      // Blocks are bounded by the river too, so none straddles it.
      ys.push(riverLo, riverHi);
      ys.sort((a, b) => a - b);
    }
    districtXs.push(xs);
    districtYs.push(ys);
  }

  // Bridges: one vertical line per district column (not the map edge), mains preferred.
  for (let c = 0; c < n; c++) {
    const candidates = lines.filter(
      (l) => l.vertical && l.pos > c * cell && l.pos < (c + 1) * cell + 1e-6 && l.pos < size - 1 && l.from <= riverLo && l.to >= riverHi,
    );
    const weights = candidates.map((l) => (l.kind === 'main' ? 3 : l.kind === 'standard' ? 1 : 0.2));
    let r = nextFloat(rng) * weights.reduce((a, b) => a + b, 0);
    let chosen = candidates[candidates.length - 1]!;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i]!;
      if (r < 0) {
        chosen = candidates[i]!;
        break;
      }
    }
    chosen.bridge = true;
  }

  // Names and lighting, per line.
  const usedNames = new Set<string>();
  for (const line of lines) {
    let name = '';
    for (let attempt = 0; attempt < 50 && (name === '' || usedNames.has(name)); attempt++) {
      name = `${pick(rng, STREET_ROOTS)} ${pick(rng, SUFFIXES[line.kind])}`;
    }
    while (usedNames.has(name)) name = `${name} North`;
    usedNames.add(name);
    line.name = name;
    line.lit = power && (line.kind === 'main' || chance(rng, kindOf(line.district).lightingCoverage));
  }

  // Nodes and streets: cut every line at each crossing.
  const nodes: StreetNode[] = [];
  const nodeKey = new Map<string, NodeId>();
  const nodeAt = (x: number, y: number): NodeId => {
    const key = `${Math.round(x * 10)},${Math.round(y * 10)}`;
    let id = nodeKey.get(key);
    if (id === undefined) {
      id = nodes.length as NodeId;
      nodes.push({ id, x, y });
      nodeKey.set(key, id);
    }
    return id;
  };
  const streets: Street[] = [];
  const verticals = lines.filter((l) => l.vertical);
  const horizontals = lines.filter((l) => !l.vertical);
  for (const line of lines) {
    const crossers = line.vertical ? horizontals : verticals;
    const cuts = new Set<number>([line.from, line.to]);
    for (const o of crossers) {
      if (o.from - 1e-6 <= line.pos && line.pos <= o.to + 1e-6 && line.from - 1e-6 <= o.pos && o.pos <= line.to + 1e-6) cuts.add(o.pos);
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const lo = sorted[i]!;
      const hi = sorted[i + 1]!;
      const crossesRiver = line.vertical && lo < riverHi && hi > riverLo;
      if (crossesRiver && !line.bridge) continue;
      const a = line.vertical ? nodeAt(line.pos, lo) : nodeAt(lo, line.pos);
      const b = line.vertical ? nodeAt(line.pos, hi) : nodeAt(hi, line.pos);
      const mid = (lo + hi) / 2;
      const terrain: Terrain = crossesRiver ? 'bridge' : line.kind === 'alley' ? 'alley' : 'standard';
      const id = streets.length as StreetId;
      streets.push({
        id,
        name: line.name,
        a,
        b,
        width: line.width,
        terrain,
        lit: line.lit,
        blocked: 0,
        district: (line.vertical ? districtAt(line.pos, mid) : districtAt(mid, line.pos)) as DistrictId,
      });
      line.edges.push({ id, lo, hi });
    }
  }

  // Width of the line bounding a block on one side, looked up by position.
  const lineWidthAt = (vertical: boolean, pos: number, along: number): number => {
    let best = widths.standard;
    let bestD = Infinity;
    for (const l of vertical ? verticals : horizontals) {
      if (along < l.from || along > l.to) continue;
      const d = Math.abs(l.pos - pos);
      if (d < bestD) {
        bestD = d;
        best = l.width;
      }
    }
    return bestD < 1 ? best : 0; // 0: bounded by water, not a street
  };
  const lineAt = (vertical: boolean, pos: number, along: number): Line | undefined =>
    (vertical ? verticals : horizontals).find((l) => Math.abs(l.pos - pos) < 1 && along >= l.from && along <= l.to);
  const edgeOn = (line: Line, along: number): StreetId | undefined => line.edges.find((e) => along >= e.lo - 1e-6 && along <= e.hi + 1e-6)?.id;

  // Blocks → parks or buildings.
  const buildings: Building[] = [];
  for (const d of districts) {
    const k = kindOf(d.id);
    const xs = districtXs[d.id]!;
    const ys = districtYs[d.id]!;
    for (let r = 0; r + 1 < ys.length; r++) {
      for (let c = 0; c + 1 < xs.length; c++) {
        const x0 = xs[c]!;
        const x1 = xs[c + 1]!;
        const y0 = ys[r]!;
        const y1 = ys[r + 1]!;
        if (y0 >= riverLo - 1e-6 && y1 <= riverHi + 1e-6) continue; // water
        const midX = (x0 + x1) / 2;
        const midY = (y0 + y1) / 2;
        if (chance(rng, config.map.parkShare)) {
          for (const [vertical, pos, along] of [
            [true, x0, midY], [true, x1, midY], [false, y0, midX], [false, y1, midX],
          ] as const) {
            const line = lineAt(vertical, pos, along);
            if (!line) continue;
            for (const e of line.edges) {
              const lo = vertical ? y0 : x0;
              const hi = vertical ? y1 : x1;
              const s = streets[e.id]!;
              if (e.lo >= lo - 1e-6 && e.hi <= hi + 1e-6 && s.terrain !== 'bridge') s.terrain = 'open';
            }
          }
          continue;
        }
        if (!chance(rng, k.buildingDensity)) continue;

        const wl = lineWidthAt(true, x0, midY);
        const wr = lineWidthAt(true, x1, midY);
        const wt = lineWidthAt(false, y0, midX);
        const wb = lineWidthAt(false, y1, midX);
        const minX = x0 + wl / 2 + SETBACK;
        const maxX = x1 - wr / 2 - SETBACK;
        const minY = y0 + wt / 2 + SETBACK;
        const maxY = y1 - wb / 2 - SETBACK;
        if (maxX - minX < MIN_BUILDING || maxY - minY < MIN_BUILDING) continue;

        const tagKey = pickWeighted(rng, k.tagWeights);
        const tag: BuildingTag = tagKey === 'flavour' ? pick(rng, FLAVOUR_TAGS) : (tagKey as FunctionalTag);
        const profile = config.tags[functionalProfile(tag, config)];

        // Sides that face a street, widest first: [line vertical?, line pos, entrance point].
        const sides = [
          { width: wb, vertical: false, pos: y1, point: { x: (minX + maxX) / 2, y: maxY } },
          { width: wt, vertical: false, pos: y0, point: { x: (minX + maxX) / 2, y: minY } },
          { width: wr, vertical: true, pos: x1, point: { x: maxX, y: (minY + maxY) / 2 } },
          { width: wl, vertical: true, pos: x0, point: { x: minX, y: (minY + maxY) / 2 } },
        ]
          .filter((s) => s.width > 0)
          .sort((a, b) => b.width - a.width);
        if (sides.length === 0) continue;
        const entrances: Vec2[] = sides.slice(0, profile.entrances).map((s) => s.point);
        const front = sides[0]!;
        const frontLine = lineAt(front.vertical, front.pos, front.vertical ? front.point.y : front.point.x);
        const street = frontLine && edgeOn(frontLine, front.vertical ? front.point.y : front.point.x);
        if (street === undefined) continue;

        buildings.push({
          id: buildings.length as BuildingId,
          tag,
          district: d.id,
          street,
          outline: [
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY },
          ],
          entrances,
          residents: 0,
          sheltered: [],
          zombiesInside: 0,
          occupiedAt: null,
          materials: tagKey === 'flavour' ? 0 : nextInt(rng, profile.materials[0]!, profile.materials[1]!),
          fortification: 0,
          breached: false,
          lit: power && chance(rng, 0.6),
          pendingRelease: 0,
          pendingExpel: 0,
          pendingTurn: 0,
          pendingDie: 0,
          pendingSpill: 0,
        });
      }
    }
  }

  const river: River = {
    outline: [
      { x: 0, y: riverLo },
      { x: size, y: riverLo },
      { x: size, y: riverHi },
      { x: 0, y: riverHi },
    ],
  };
  return { nodes, streets, buildings, districts, river };
}
