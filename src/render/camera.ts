// A free camera: the viewer pans and zooms at will, and nothing frames the action
// for them. World units are metres; `scale` is screen pixels per metre.

export type ZoomMode = 'far' | 'mid' | 'near';

/** Representation changes with zoom, not just scale (reference: Zoom). */
export const FAR_BELOW = 0.3; // px/m
export const NEAR_ABOVE = 1.5; // px/m
export const MIN_SCALE = 0.12;
export const MAX_SCALE = 10;

export class Camera {
  /** World point at the centre of the view. */
  x: number;
  y: number;
  scale: number;
  width = 1;
  height = 1;
  /** Bumped on every change, so cached layers know when to redraw. */
  version = 0;

  constructor(x: number, y: number, scale: number) {
    this.x = x;
    this.y = y;
    this.scale = scale;
  }

  get mode(): ZoomMode {
    return this.scale < FAR_BELOW ? 'far' : this.scale > NEAR_ABOVE ? 'near' : 'mid';
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.version++;
  }

  toScreenX(wx: number): number {
    return (wx - this.x) * this.scale + this.width / 2;
  }

  toScreenY(wy: number): number {
    return (wy - this.y) * this.scale + this.height / 2;
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.width / 2) / this.scale + this.x, y: (sy - this.height / 2) / this.scale + this.y };
  }

  panBy(dxPixels: number, dyPixels: number): void {
    this.x -= dxPixels / this.scale;
    this.y -= dyPixels / this.scale;
    this.version++;
  }

  /** Zooms by `factor`, keeping the world point under the screen point fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.version++;
  }

  centreOn(wx: number, wy: number): void {
    this.x = wx;
    this.y = wy;
    this.version++;
  }

  /** Sets the transform so drawing in world coordinates lands on screen. */
  apply(g: CanvasRenderingContext2D, dpr: number): void {
    const s = this.scale * dpr;
    g.setTransform(s, 0, 0, s, (this.width / 2 - this.x * this.scale) * dpr, (this.height / 2 - this.y * this.scale) * dpr);
  }
}
