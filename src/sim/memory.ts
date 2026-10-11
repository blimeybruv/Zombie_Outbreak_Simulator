// Bounded belief tables. A sim's memory is a thin overlay of opinions about parts
// of the city; when it outgrows its cap, the oldest observations are forgotten.
// An evicted entry reads exactly like an unknown one, which is what a belief that
// old has decayed toward anyway. Tables may run up to twice their cap before being
// trimmed back to it, so merging two capped tables never sorts; the sort runs only
// when a table has genuinely doubled.

const SLACK = 2;

// Trimming sorts one number per entry: newest first, then the lower key, packed as
// -observedAt × KEY_SPAN + key so a plain numeric sort orders them. Exact while ticks
// are integers and keys are below KEY_SPAN (street and building ids are thousands).
const KEY_SPAN = 2 ** 20;
let order = new Float64Array(0);
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
    const c = sorted[i]!;
    const k = (c - Math.floor(c / KEY_SPAN) * KEY_SPAN) as K;
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
