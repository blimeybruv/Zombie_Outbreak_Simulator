// A* over the shared street graph with a per-sim cost function:
//   cost(street) = length + dangerWeight * cautionFactor * believedDanger
// For most, believed danger is danger × confidence and an unknown street costs pure
// distance: ignorance reads as safety. For the especially cautious it drifts toward a
// prior instead (believedDanger, below), so they keep to streets known to be quiet.
// In direct mode memory is ignored entirely.

import type { Config } from '../../config';
import { confidence } from '../derived';
import type { MapIndex } from './runtime';
import type { NodeId, Sim, StreetId, World } from '../state';

/**
 * How dangerous a sim believes a street is, for routing: what it saw or was told,
 * weighted by confidence, and for the rest the prior — 0 for most (ignorance reads as
 * safety), up to `memory.unknownStreetDanger` for the especially cautious (from
 * `memory.unknownDangerFrom`, full at caution 1). Old news fades toward the prior, so
 * bad news never turns good and, for the cautious, good news does not stay good.
 */
export function believedDanger(sim: Sim, street: StreetId, tick: number, config: Config): number {
  const m = config.memory;
  const ramp = Math.max(0, (sim.caution - m.unknownDangerFrom) / (1 - m.unknownDangerFrom));
  const prior = config.features.cautiousRouting ? m.unknownStreetDanger * ramp : 0;
  const belief = sim.streetMemory.get(street);
  if (!belief) return prior;
  const c = confidence(belief.observedAt, tick, config);
  return c * belief.danger + (1 - c) * prior;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  clear(): void {
    this.keys.length = 0;
    this.vals.length = 0;
  }
  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! < key || (k[p] === key && v[p]! <= val)) break;
      k[i] = k[p]!;
      v[i] = v[p]!;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0]!;
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    if (k.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mk = lastK;
        let mv = lastV;
        if (l < k.length && (k[l]! < mk || (k[l] === mk && v[l]! < mv))) {
          m = l;
          mk = k[l]!;
          mv = v[l]!;
        }
        if (r < k.length && (k[r]! < mk || (k[r] === mk && v[r]! < mv))) m = r;
        if (m === i) break;
        k[i] = k[m]!;
        v[i] = v[m]!;
        i = m;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}

export class Pathfinder {
  private readonly g: Float64Array;
  private readonly via: Int32Array; // street used to reach the node
  private readonly prev: Int32Array;
  private readonly seen: Int32Array;
  private readonly closed: Int32Array;
  private stamp = 0;
  private readonly heap = new MinHeap();

  constructor(
    private readonly world: World,
    private readonly map: MapIndex,
  ) {
    const n = world.nodes.length;
    this.g = new Float64Array(n);
    this.via = new Int32Array(n);
    this.prev = new Int32Array(n);
    this.seen = new Int32Array(n);
    this.closed = new Int32Array(n);
  }

  private streetCost(sim: Sim, street: StreetId, useMemory: boolean): number {
    const { config, tick, streets } = this.world;
    const s = streets[street]!;
    if (s.blocked >= 1) return Infinity;
    const length = this.map.streetLength[street]!;
    if (!useMemory) return length;
    const danger = believedDanger(sim, street, tick, config);
    const [lo, hi] = config.pathfinding.cautionDanger;
    return length + config.pathfinding.dangerWeight * (lo! + (hi! - lo!) * sim.caution) * danger;
  }

  /**
   * Street ids from the street nearest `from` to the street nearest `to`, with
   * consecutive duplicates removed. Waypoints are the nodes shared by consecutive
   * streets; the last leg heads straight for the destination. Null if unreachable.
   * With `back`, it starts on the street `avoid`, leaves it by `node` and never uses it
   * again: a car turning back from a blocked street (cars.ts reroute).
   */
  route(sim: Sim, toX: number, toY: number, useMemory: boolean, back?: { node: NodeId; avoid: StreetId }): StreetId[] | null {
    const { world, map } = this;
    const search = world.config.behaviour.pathStreetSearch;
    const startStreet = back ? back.avoid : map.nearestStreet(sim.x, sim.y, search);
    const goalStreet = map.nearestStreet(toX, toY, search);
    if (startStreet === null || goalStreet === null) return null;
    // Turning back: out by `node`, and never along `avoid` again — so no way at all
    // when the goal lies on the street it is turning back from.
    if (back && goalStreet === back.avoid) return null;
    if (startStreet === goalStreet) return [startStreet];

    const nodes = world.nodes;
    const ss = world.streets[startStreet]!;
    const gs = world.streets[goalStreet]!;
    const stamp = ++this.stamp;
    const heap = this.heap;
    heap.clear();
    const h = (n: number) => Math.hypot(nodes[n]!.x - toX, nodes[n]!.y - toY);
    const open = (node: NodeId, cost: number, via: number, prev: number) => {
      if (this.seen[node] === stamp && this.g[node]! <= cost) return;
      this.seen[node] = stamp;
      this.g[node] = cost;
      this.via[node] = via;
      this.prev[node] = prev;
      heap.push(cost + h(node), node);
    };
    for (const end of back ? [back.node] : [ss.a, ss.b]) {
      const n = nodes[end]!;
      open(end, Math.hypot(n.x - sim.x, n.y - sim.y), startStreet, -1);
    }

    let reached = -1;
    while (heap.size > 0) {
      const node = heap.pop();
      if (this.closed[node] === stamp) continue;
      this.closed[node] = stamp;
      if (node === gs.a || node === gs.b) {
        reached = node;
        break;
      }
      const base = this.g[node]!;
      for (const adj of map.adjacency[node]!) {
        if (this.closed[adj.node] === stamp) continue;
        const c = back && adj.street === back.avoid ? Infinity : this.streetCost(sim, adj.street, useMemory);
        if (c === Infinity) continue;
        open(adj.node, base + c, adj.street, node);
      }
    }
    if (reached < 0) return null;

    const streets: StreetId[] = [goalStreet];
    for (let n = reached; n >= 0; n = this.prev[n]!) streets.push(this.via[n] as StreetId);
    streets.reverse();
    const route: StreetId[] = [];
    for (const s of streets) if (route[route.length - 1] !== s) route.push(s);
    return route;
  }
}

/** The node shared by two streets, or null. */
export function sharedNode(world: World, a: StreetId, b: StreetId): NodeId | null {
  const sa = world.streets[a]!;
  const sb = world.streets[b]!;
  if (sa.a === sb.a || sa.a === sb.b) return sa.a;
  if (sa.b === sb.a || sa.b === sb.b) return sa.b;
  return null;
}
