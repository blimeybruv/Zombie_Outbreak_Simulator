// Ordinary roofs in plan. No fill: a coloured plot reads as paint. One thin
// ridge, the line of a gable, from a hash of the building id — which way it
// runs, and how far it sits off the centre — so a terrace is not one stamp.
// Render only, not a draw from the run, so the fingerprint does not move.
//
// A church, a hospital's L, a school's U, the armoury and a police station are
// left alone: their silhouette already says what they are.

import { SHAPE_BOX } from '../worker/protocol';

/** A fixed hash of a building id. Render only: not the run's stream. */
export function buildingVisualHash(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Shape 0 is a plain plot. An armoury or a station keeps its own mark. */
export function ordinaryBuilding(shape: number, armoury: number, station: number): boolean {
  return shape === SHAPE_BOX && armoury === 0 && station === 0;
}

const RIDGE_PAD = 1.5; // m short of each wall, so the line does not read as a crack in the outline
const RIDGE_MIN = 5; // m: shorter than this, the plot has no room for a ridge

/**
 * One gable ridge, x0 y0 x1 y1, inside the plot. Empty when the footprint is
 * too small to hold a line. `corners` is x0 y0 … x3 y3.
 */
export function dressBuilding(id: number, corners: ArrayLike<number>): number[] {
  const x = [corners[0]!, corners[2]!, corners[4]!, corners[6]!];
  const y = [corners[1]!, corners[3]!, corners[5]!, corners[7]!];
  return ridge(buildingVisualHash(id), x, y);
}

function ridge(h: number, x: number[], y: number[]): number[] {
  const width = Math.hypot(x[1]! - x[0]!, y[1]! - y[0]!);
  const depth = Math.hypot(x[3]! - x[0]!, y[3]! - y[0]!);
  if (width < 8 || depth < 8) return [];
  // 0.42–0.58: off centre, still a ridge rather than a wall shoved to one side.
  const offset = 0.42 + ((h >>> 4) % 17) / 100;
  const alongFront = ((h >>> 8) & 1) === 0;
  const padS = Math.min(0.4, RIDGE_PAD / width);
  const padT = Math.min(0.4, RIDGE_PAD / depth);
  const at = (s: number, t: number): [number, number] => [
    x[0]! + (x[1]! - x[0]!) * s + (x[3]! - x[0]!) * t,
    y[0]! + (y[1]! - y[0]!) * s + (y[3]! - y[0]!) * t,
  ];
  const [ax, ay] = alongFront ? at(padS, offset) : at(offset, padT);
  const [bx, by] = alongFront ? at(1 - padS, offset) : at(offset, 1 - padT);
  if (Math.hypot(bx - ax, by - ay) < RIDGE_MIN) return [];
  return [ax, ay, bx, by];
}
