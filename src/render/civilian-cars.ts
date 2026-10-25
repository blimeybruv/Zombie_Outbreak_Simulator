// Ordinary cars in plan, the same language as the cruiser: hull, wheel arches,
// a lighter bonnet and roof, darker glass. No light bar. Every shape stays
// inside the 4.5 × 1.9 m rectangle the simulation already uses; a hatchback
// is a little shorter so a row is not one silhouette. Which shape, and which
// paint, come from the car's id alone — a render-side hash, not a draw from
// the run — so a replay looks the same and the fingerprint does not move.

import * as P from './palette';

export const CIVILIAN_STYLES = ['sedan', 'hatchback', 'wagon', 'pickup', 'minivan'] as const;
export type CivilianStyle = (typeof CIVILIAN_STYLES)[number];

/** A fixed hash of a car id. Render only: not the run's stream. */
export function carVisualHash(id: number): number {
  let h = Math.imul(id ^ 0x5bd1e995, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x165667b1);
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * Sedans and hatchbacks are the common cars (four and three of ten);
 * a wagon, a pickup and a minivan take one each.
 */
export function civilianStyle(id: number): CivilianStyle {
  const b = carVisualHash(id) % 10;
  if (b <= 3) return 'sedan';
  if (b <= 6) return 'hatchback';
  if (b === 7) return 'wagon';
  if (b === 8) return 'pickup';
  return 'minivan';
}

/** Paint index into `CIVILIAN`, independent of the body style. */
export function civilianLivery(id: number): number {
  return Math.floor(carVisualHash(id) / 10) % P.CIVILIAN.length;
}

/** A filled box: `len` along (dx, dy), `wid` across it, centred at (x, y). (dx, dy) is a unit vector. */
function addBox(path: Path2D, x: number, y: number, dx: number, dy: number, len: number, wid: number): void {
  const nx = -dy, ny = dx;
  const hl = len / 2, hw = wid / 2;
  path.moveTo(x + dx * hl + nx * hw, y + dy * hl + ny * hw);
  path.lineTo(x - dx * hl + nx * hw, y - dy * hl + ny * hw);
  path.lineTo(x - dx * hl - nx * hw, y - dy * hl - ny * hw);
  path.lineTo(x + dx * hl - nx * hw, y + dy * hl - ny * hw);
  path.closePath();
}

/** Wheel arches, a pair at each station along the car. The outer edge stays inside 1.9 m. */
function arches(body: Path2D, x: number, y: number, dx: number, dy: number, along: readonly number[], bodyW: number, archL: number, archW: number): void {
  const nx = -dy, ny = dx;
  for (const u of along) {
    for (const side of [1, -1] as const) {
      const lat = bodyW / 2 + archW / 2 - 0.05;
      addBox(body, x + dx * u + nx * side * lat, y + dy * u + ny * side * lat, dx, dy, archL, archW);
    }
  }
}

/** Three boxes: bonnet, cabin, boot. The full 4.5 m, nose along (dx, dy). */
function addSedan(body: Path2D, panel: Path2D, shade: Path2D, x: number, y: number, dx: number, dy: number): void {
  const bodyW = 1.58;
  addBox(body, x, y, dx, dy, 4.5, bodyW);
  arches(body, x, y, dx, dy, [1.4, -1.4], bodyW, 0.78, 0.18);
  addBox(panel, x + dx * 1.5, y + dy * 1.5, dx, dy, 1.02, 1.32);
  addBox(panel, x - dx * 0.02, y - dy * 0.02, dx, dy, 1.28, 1.26);
  addBox(panel, x - dx * 1.55, y - dy * 1.55, dx, dy, 0.92, 1.32);
  addBox(shade, x + dx * 0.82, y + dy * 0.82, dx, dy, 0.26, 1.18);
  addBox(shade, x - dx * 0.9, y - dy * 0.9, dx, dy, 0.18, 1.1);
}

/** Shorter, a long roof and a steep rear glass: the boot is barely there. */
function addHatchback(body: Path2D, panel: Path2D, shade: Path2D, x: number, y: number, dx: number, dy: number): void {
  const bodyW = 1.52;
  addBox(body, x, y, dx, dy, 4.05, bodyW);
  arches(body, x, y, dx, dy, [1.18, -1.18], bodyW, 0.7, 0.17);
  addBox(panel, x + dx * 1.32, y + dy * 1.32, dx, dy, 0.78, 1.22);
  addBox(panel, x - dx * 0.05, y - dy * 0.05, dx, dy, 1.5, 1.28);
  addBox(panel, x - dx * 1.72, y - dy * 1.72, dx, dy, 0.36, 1.22);
  addBox(shade, x + dx * 0.84, y + dy * 0.84, dx, dy, 0.26, 1.16);
  addBox(shade, x - dx * 1.15, y - dy * 1.15, dx, dy, 0.5, 1.18);
}

/** A sedan's length with the roof carried almost to a square tail. */
function addWagon(body: Path2D, panel: Path2D, shade: Path2D, x: number, y: number, dx: number, dy: number): void {
  const bodyW = 1.62;
  addBox(body, x, y, dx, dy, 4.5, bodyW);
  arches(body, x, y, dx, dy, [1.48, -1.48], bodyW, 0.82, 0.18);
  addBox(panel, x + dx * 1.68, y + dy * 1.68, dx, dy, 0.72, 1.34);
  addBox(panel, x - dx * 0.05, y - dy * 0.05, dx, dy, 2.2, 1.34);
  addBox(panel, x - dx * 1.88, y - dy * 1.88, dx, dy, 0.38, 1.4);
  addBox(shade, x + dx * 1.2, y + dy * 1.2, dx, dy, 0.22, 1.22);
  addBox(shade, x - dx * 1.42, y - dy * 1.42, dx, dy, 0.36, 1.22);
}

/** Cab forward, an open bed behind it, the tailgate shutting the back. */
function addPickup(body: Path2D, panel: Path2D, shade: Path2D, x: number, y: number, dx: number, dy: number): void {
  const bodyW = 1.66;
  addBox(body, x, y, dx, dy, 4.5, bodyW);
  arches(body, x, y, dx, dy, [1.32, -1.58], bodyW, 0.84, 0.16);
  addBox(panel, x + dx * 1.55, y + dy * 1.55, dx, dy, 0.8, 1.36);
  addBox(panel, x + dx * 0.52, y + dy * 0.52, dx, dy, 1.05, 1.42);
  addBox(panel, x - dx * 2.08, y - dy * 2.08, dx, dy, 0.28, 1.48);
  addBox(shade, x + dx * 1.1, y + dy * 1.1, dx, dy, 0.18, 1.22);
  addBox(shade, x, y, dx, dy, 0.14, 1.05);
  addBox(shade, x - dx * 1.1, y - dy * 1.1, dx, dy, 1.6, 1.18);
}

/** A stub nose and one wide roof almost the whole length: a box, not a wagon. */
function addMinivan(body: Path2D, panel: Path2D, shade: Path2D, x: number, y: number, dx: number, dy: number): void {
  const bodyW = 1.7;
  addBox(body, x, y, dx, dy, 4.4, bodyW);
  arches(body, x, y, dx, dy, [1.55, -1.55], bodyW, 0.7, 0.14);
  addBox(panel, x + dx * 1.85, y + dy * 1.85, dx, dy, 0.42, 1.48);
  addBox(panel, x - dx * 0.05, y - dy * 0.05, dx, dy, 2.7, 1.58);
  addBox(panel, x - dx * 1.98, y - dy * 1.98, dx, dy, 0.28, 1.55);
  addBox(shade, x + dx * 1.48, y + dy * 1.48, dx, dy, 0.26, 1.48);
  addBox(shade, x - dx * 1.62, y - dy * 1.62, dx, dy, 0.32, 1.4);
}

/** One ordinary car. Nose along (dx, dy). Abandoned cars are not drawn here. */
export function addCivilianCar(body: Path2D, panel: Path2D, shade: Path2D, style: CivilianStyle, x: number, y: number, dx: number, dy: number): void {
  if (style === 'sedan') addSedan(body, panel, shade, x, y, dx, dy);
  else if (style === 'hatchback') addHatchback(body, panel, shade, x, y, dx, dy);
  else if (style === 'wagon') addWagon(body, panel, shade, x, y, dx, dy);
  else if (style === 'pickup') addPickup(body, panel, shade, x, y, dx, dy);
  else addMinivan(body, panel, shade, x, y, dx, dy);
}
