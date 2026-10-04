// Bounded belief tables. A sim's memory is a thin overlay of opinions about parts
// of the city; when it outgrows its cap, the oldest observations are forgotten.
// An evicted entry reads exactly like an unknown one, which is what a belief that
// old has decayed toward anyway. Tables may run up to half over their cap before
// being trimmed back to it, so the sort runs rarely rather than on every write.

const SLACK = 1.5;

/** Keeps the `cap` newest entries once the table runs past its slack; ties keep the lower key. Deterministic. */
export function trim<K extends number, V extends { observedAt: number }>(table: Map<K, V>, cap: number): void {
  if (table.size <= cap * SLACK) return;
  const keep = [...table.entries()].sort((a, b) => b[1].observedAt - a[1].observedAt || a[0] - b[0]).slice(0, cap);
  table.clear();
  for (const [k, v] of keep) table.set(k, v);
}

/** Writes an observation, forgetting the oldest once the table runs past its slack. */
export function remember<K extends number, V extends { observedAt: number }>(table: Map<K, V>, key: K, value: V, cap: number): void {
  table.set(key, value);
  trim(table, cap);
}
