import type { Sim } from '../sim/state/sim';

/**
 * Living Rangers still outdoors, as x, y pairs. Empty before the sweep and again
 * when none remain outside. The cordon's soldiers are outsiders too, and they are
 * not included: only `sweep`.
 */
export function rangerPositions(sims: readonly Sim[]): Float32Array {
  const xy: number[] = [];
  for (const s of sims) {
    if (!s.sweep) continue;
    if (s.condition !== 'healthy' && s.condition !== 'infected') continue;
    if (s.insideBuilding !== null || s.car !== null) continue;
    xy.push(s.x, s.y);
  }
  return new Float32Array(xy);
}
