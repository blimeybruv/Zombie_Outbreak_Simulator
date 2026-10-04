// Segment soup → planar street graph → faces (blocks).
//
// Every line is cut wherever another crosses it, so the graph is planar: each
// crossing is a node. Nodes closer than `snap` merge, which removes the slivers
// two nearly coincident crossings would otherwise make. Faces are traced with
// half-edges; each bounded face is a block.

import { dist, segmentIntersection, signedArea, type Pt } from './geom';

export interface Seg {
  a: Pt;
  b: Pt;
  /** Index of the source line; lower wins when two lines share an edge. */
  line: number;
}

export interface PlanarGraph {
  nodes: Pt[];
  edges: { a: number; b: number; line: number }[];
}

export interface Face {
  /** Node ids around the face. */
  nodes: number[];
  /** Edge ids, edge i joining nodes[i] and nodes[i + 1]. */
  edges: number[];
  area: number;
}

const CELL = 100;

export function planarise(segs: Seg[], snap: number): PlanarGraph {
  // Bucket segments by grid cell so crossings are only tested between neighbours.
  const buckets = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s.a.x, s.b.x) / CELL), x1 = Math.floor(Math.max(s.a.x, s.b.x) / CELL);
    const y0 = Math.floor(Math.min(s.a.y, s.b.y) / CELL), y1 = Math.floor(Math.max(s.a.y, s.b.y) / CELL);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = `${x},${y}`;
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
    }
  });
  const cuts: number[][] = segs.map(() => [0, 1]);
  const tested = new Set<number>();
  for (const ids of buckets.values()) {
    for (let p = 0; p < ids.length; p++) {
      for (let q = p + 1; q < ids.length; q++) {
        const i = ids[p]!, j = ids[q]!;
        const key = i < j ? i * segs.length + j : j * segs.length + i;
        if (tested.has(key)) continue;
        tested.add(key);
        const hit = segmentIntersection(segs[i]!.a, segs[i]!.b, segs[j]!.a, segs[j]!.b);
        if (hit) {
          cuts[i]!.push(hit.t);
          cuts[j]!.push(hit.u);
        }
      }
    }
  }

  // Nodes, snapped.
  const nodes: Pt[] = [];
  const nodeGrid = new Map<string, number[]>();
  const nodeAt = (p: Pt): number => {
    const cx = Math.floor(p.x / snap), cy = Math.floor(p.y / snap);
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      for (const id of nodeGrid.get(`${x},${y}`) ?? []) if (dist(nodes[id]!, p) < snap) return id;
    }
    const id = nodes.length;
    nodes.push({ x: p.x, y: p.y });
    const k = `${cx},${cy}`;
    (nodeGrid.get(k) ?? nodeGrid.set(k, []).get(k)!).push(id);
    return id;
  };

  const edges: PlanarGraph['edges'] = [];
  const edgeKey = new Map<string, number>();
  segs.forEach((s, i) => {
    const ts = [...new Set(cuts[i]!.map((t) => Math.round(Math.min(1, Math.max(0, t)) * 1e9) / 1e9))].sort((x, y) => x - y);
    let prev = -1;
    for (const t of ts) {
      const n = nodeAt({ x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t });
      if (prev >= 0 && n !== prev) {
        const key = prev < n ? `${prev},${n}` : `${n},${prev}`;
        const existing = edgeKey.get(key);
        if (existing === undefined) {
          edgeKey.set(key, edges.length);
          edges.push({ a: prev, b: n, line: s.line });
        } else if (s.line < edges[existing]!.line) {
          edges[existing]!.line = s.line;
        }
      }
      prev = n;
    }
  });
  return keepLargestComponent({ nodes, edges });
}

/** Drops fragments not connected to the main network; renumbers nodes compactly. */
function keepLargestComponent(g: PlanarGraph): PlanarGraph {
  const adj: number[][] = g.nodes.map(() => []);
  for (const e of g.edges) {
    adj[e.a]!.push(e.b);
    adj[e.b]!.push(e.a);
  }
  const comp = new Int32Array(g.nodes.length).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < g.nodes.length; s++) {
    if (comp[s] !== -1 || adj[s]!.length === 0) continue;
    const c = sizes.length;
    let size = 0;
    const stack = [s];
    comp[s] = c;
    while (stack.length) {
      const v = stack.pop()!;
      size++;
      for (const w of adj[v]!) {
        if (comp[w] !== -1) continue;
        comp[w] = c;
        stack.push(w);
      }
    }
    sizes.push(size);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  const remap = new Int32Array(g.nodes.length).fill(-1);
  const nodes: Pt[] = [];
  g.nodes.forEach((p, i) => {
    if (comp[i] === main) {
      remap[i] = nodes.length;
      nodes.push(p);
    }
  });
  const edges = g.edges.filter((e) => comp[e.a] === main).map((e) => ({ a: remap[e.a]!, b: remap[e.b]!, line: e.line }));
  return { nodes, edges };
}

/** Bounded faces of a planar graph, each a block outline. */
export function faces(g: PlanarGraph): Face[] {
  // Half-edge h = 2e (a→b) or 2e+1 (b→a). Outgoing half-edges sorted by angle at each node.
  const out: number[][] = g.nodes.map(() => []);
  const from = (h: number) => (h & 1 ? g.edges[h >> 1]!.b : g.edges[h >> 1]!.a);
  const to = (h: number) => (h & 1 ? g.edges[h >> 1]!.a : g.edges[h >> 1]!.b);
  const angle = (h: number) => {
    const p = g.nodes[from(h)]!, q = g.nodes[to(h)]!;
    return Math.atan2(q.y - p.y, q.x - p.x);
  };
  g.edges.forEach((_, e) => {
    out[g.edges[e]!.a]!.push(2 * e);
    out[g.edges[e]!.b]!.push(2 * e + 1);
  });
  const position = new Int32Array(g.edges.length * 2);
  for (const list of out) {
    list.sort((h1, h2) => angle(h1) - angle(h2) || h1 - h2);
    list.forEach((h, i) => (position[h] = i));
  }
  // Next half-edge around a face: at the head, turn to the neighbour just before the twin.
  const next = (h: number): number => {
    const twin = h ^ 1;
    const list = out[from(twin)]!;
    return list[(position[twin]! - 1 + list.length) % list.length]!;
  };

  const seen = new Uint8Array(g.edges.length * 2);
  const found: Face[] = [];
  for (let start = 0; start < seen.length; start++) {
    if (seen[start]) continue;
    const nodes: number[] = [];
    const edges: number[] = [];
    let h = start;
    do {
      seen[h] = 1;
      nodes.push(from(h));
      edges.push(h >> 1);
      h = next(h);
    } while (h !== start && nodes.length < 10000);
    found.push({ nodes, edges, area: signedArea(nodes.map((n) => g.nodes[n]!)) });
  }
  // Bounded faces share one orientation; the unbounded face has the other and the largest area.
  const positive = found.filter((f) => f.area > 0).length;
  const sign = positive >= found.length - positive ? 1 : -1;
  return found.filter((f) => f.area * sign > 0).map((f) => ({ ...f, area: Math.abs(f.area) }));
}
