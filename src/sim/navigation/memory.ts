// Bounded belief tables. A sim's memory is a thin overlay of opinions about parts
// of the city; when it outgrows its cap, the oldest observations are forgotten (street
// tables: the least relevant, trimStreets).
// An evicted entry reads exactly like an unknown one, which is what a belief that
// old has decayed toward anyway. Tables may run up to twice their cap before being
// trimmed back to it, so merging two capped tables never sorts; the sort runs only
// when a table has genuinely doubled.

import { confidence } from '../derived';
import type { Sim, StreetBelief, StreetId, World } from '../state';

const SLACK = 2;

// Trimming sorts one number per entry: newest first, then the lower key, packed as
// -observedAt × KEY_SPAN + key so a plain numeric sort orders them. Exact while ticks
// are integers and keys are below KEY_SPAN (street and building ids are thousands).
const KEY_SPAN = 2 ** 20;
let order = new Float64Array(0);
const keyOf = (packed: number) => packed - Math.floor(packed / KEY_SPAN) * KEY_SPAN;
const kept: unknown[] = [];

/** Keeps the `cap` newest entries once the table runs past its slack; ties keep the lower key. Deterministic. */
export function trim<K extends number, V extends { observedAt: number }>(table: Map<K, V>, cap: number): void {
  if (table.size <= cap * SLACK) return;
  if (order.length < table.size) order = new Float64Array(table.size * 2);
  let n = 0;
  for (const [k, v] of table) order[n++] = -v.observedAt * KEY_SPAN + k;
  const sorted = order.subarray(0, n).sort();
  // Read the survivors before clearing, then re-insert newest first, as before.
  kept.length = 0;
  for (let i = 0; i < cap; i++) {
    const k = keyOf(sorted[i]!) as K;
    kept.push(k, table.get(k));
  }
  table.clear();
  for (let i = 0; i < kept.length; i += 2) table.set(kept[i] as K, kept[i + 1] as V);
  kept.length = 0;
}

/** Writes an observation, forgetting the oldest once the table runs past its slack. */
export function remember<K extends number, V extends { observedAt: number }>(table: Map<K, V>, key: K, value: V, cap: number): void {
  table.set(key, value);
  trim(table, cap);
}

/**
 * Street danger is not written symmetrically. What is seen raises a belief at once; a
 * quieter reading lowers it only `quietLook` of the way, so one quiet pass cannot
 * erase a warning, while repeated ones do clear it (and age clears it anyway: danger
 * ages rather than decays, derived.ts confidence).
 */
export function settleDanger(believed: number, seen: number, quietLook: number): number {
  return seen >= believed ? seen : believed + (seen - believed) * quietLook;
}

/** Writes what a sim saw (or was shown) of a street now. `visited` undefined keeps what it was. */
export function noteStreet(world: World, sim: Sim, street: StreetId, seen: number, visited?: boolean): void {
  const table = sim.streetMemory;
  const prev = table.get(street);
  if (prev) {
    prev.danger = settleDanger(prev.danger, seen, world.config.memory.quietLook);
    prev.observedAt = world.tick;
    if (visited !== undefined) prev.visited = prev.visited || visited;
  } else {
    table.set(street, { danger: seen, observedAt: world.tick, visited: visited ?? false });
    trimStreets(world, sim);
  }
}

const reserved = new Set<number>();
const reserveOrder: number[] = [];

/**
 * A sim's street memory, trimmed by relevance rather than age once past its slack: a
 * reserve of the gravest warnings it holds (danger × confidence), wherever they are —
 * where a shelter fell is worth remembering when not headed there — then the streets
 * nearest it. Nearness counts the sim's position more than its destination, which
 * changes: a street's distance is the lesser of its distance from the sim and
 * destinationWeight × its distance from the destination. Ties keep the lower id.
 */
export function trimStreets(world: World, sim: Sim): void {
  const { config, streets, nodes, tick } = world;
  const m = config.memory;
  const table = sim.streetMemory;
  if (table.size <= m.streetCap * SLACK) return;
  if (!config.features.relevanceTrim) {
    trim(table, m.streetCap);
    return;
  }
  const r = m.relevance;
  if (order.length < table.size) order = new Float64Array(table.size * 2);
  let n = 0;
  for (const [k, v] of table) {
    if (v.danger <= r.dangerFloor) continue;
    order[n++] = Math.round((1 - v.danger * confidence(v.observedAt, tick, config)) * 1e6) * KEY_SPAN + k;
  }
  let sorted = order.subarray(0, n).sort();
  reserved.clear();
  reserveOrder.length = 0;
  for (let i = 0; i < Math.min(n, r.reserve); i++) {
    reserved.add(keyOf(sorted[i]!));
    reserveOrder.push(keyOf(sorted[i]!));
  }
  n = 0;
  const dest = sim.destination;
  for (const k of table.keys()) {
    if (reserved.has(k)) continue;
    const s = streets[k]!;
    const a = nodes[s.a]!, b = nodes[s.b]!;
    const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
    let d = Math.hypot(x - sim.x, y - sim.y);
    if (dest !== null) d = Math.min(d, r.destinationWeight * Math.hypot(x - dest.x, y - dest.y));
    order[n++] = Math.round(d) * KEY_SPAN + k;
  }
  sorted = order.subarray(0, n).sort();
  kept.length = 0;
  for (const k of reserveOrder) kept.push(k, table.get(k as StreetId));
  for (let i = 0; i < Math.min(n, m.streetCap - reserved.size); i++) {
    const k = keyOf(sorted[i]!);
    kept.push(k, table.get(k as StreetId));
  }
  table.clear();
  for (let i = 0; i < kept.length; i += 2) table.set(kept[i] as StreetId, kept[i + 1] as StreetBelief);
  kept.length = 0;
}
