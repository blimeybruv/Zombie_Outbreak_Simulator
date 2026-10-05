// Draws snapshots. Reads them, never writes simulation state (it holds none).
//
// Layers, bottom to top: the static city (cached, redrawn only when the camera or
// the light changes), the corpse paint, occupancy fill, trails (near zoom), the
// agents, and conversion pulses. At far zoom the agents give way to a density
// field — at that scale individuals are mush.
//
// `ingest` takes each snapshot's events exactly once; `draw` may run many times
// on the same snapshot.

import type { FrameSnapshot, MapSnapshot } from '../worker/protocol';
import { BUILDING_CONTESTED, SIM_HIDDEN, SIM_PROMOTED, ZOMBIE_AWAKE, ZOMBIE_DORMANT } from '../worker/protocol';
import type { Camera } from './camera';
import { CorpseLayer } from './corpses';
import { DensityField } from './density';
import * as P from './palette';
import { Trails } from './trails';

const PULSE_MS = 1400; // a conversion registers as an event, not a silent colour swap
const PULSE_RADIUS = 7; // m

const FILL_LEVELS = 6; // occupancy alpha is bucketed so each level is one fill call
const FULL_AT = 24; // people inside at which a building reads as full

function addOutline(path: Path2D, o: Float32Array, i: number): void {
  const k = i * 8;
  path.moveTo(o[k]!, o[k + 1]!);
  for (let j = 1; j < 4; j++) path.lineTo(o[k + j * 2]!, o[k + j * 2 + 1]!);
  path.closePath();
}

export class Renderer {
  private readonly g: CanvasRenderingContext2D;
  private readonly staticLayer: HTMLCanvasElement;
  private staticKey = '';
  private readonly outlinePath: Path2D;
  private readonly riverPath: Path2D;
  private readonly litPath: Path2D;
  private readonly density: DensityField;
  private readonly corpses: CorpseLayer;
  private readonly simTrails = new Trails();
  private readonly zombieTrails = new Trails();
  private pulses: { x: number; y: number; start: number }[] = [];
  /** Each building's bounding box, for culling: minX, minY, maxX, maxY. */
  private readonly bounds: Float32Array;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly map: MapSnapshot,
  ) {
    this.g = canvas.getContext('2d', { alpha: false })!;
    this.staticLayer = document.createElement('canvas');
    this.outlinePath = new Path2D();
    const o = map.outlines;
    const n = o.length / 8;
    this.bounds = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const k = i * 8;
      addOutline(this.outlinePath, o, i);
      const xs = [o[k]!, o[k + 2]!, o[k + 4]!, o[k + 6]!];
      const ys = [o[k + 1]!, o[k + 3]!, o[k + 5]!, o[k + 7]!];
      this.bounds.set([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], i * 4);
    }
    this.riverPath = new Path2D();
    map.river.centreline.forEach((p, i) => (i === 0 ? this.riverPath.moveTo(p.x, p.y) : this.riverPath.lineTo(p.x, p.y)));
    this.litPath = new Path2D();
    for (let i = 0; i < map.streetLit.length; i++) {
      if (!map.streetLit[i]) continue;
      const s = i * 5;
      this.litPath.moveTo(map.streets[s]!, map.streets[s + 1]!);
      this.litPath.lineTo(map.streets[s + 2]!, map.streets[s + 3]!);
    }
    this.density = new DensityField(map.size);
    this.corpses = new CorpseLayer(map.size);
  }

  /** Takes a new snapshot's events: deaths into the corpse paint, conversions as pulses. */
  ingest(frame: FrameSnapshot, wallMs: number): void {
    this.corpses.add(frame.events, frame.tick);
    for (const e of frame.events) if (e.type === 'simTurned' && e.sim !== null) this.pulses.push({ x: e.x, y: e.y, start: wallMs });
    if (this.pulses.length > 400) this.pulses = this.pulses.slice(-400);
  }

  /** Redraws the static city when the view or the light has changed since last time. */
  private staticFor(cam: Camera, dpr: number, night: boolean): HTMLCanvasElement {
    const far = cam.mode === 'far';
    const key = `${cam.version}|${night}|${far}|${this.canvas.width}x${this.canvas.height}`;
    if (key === this.staticKey) return this.staticLayer;
    this.staticKey = key;
    const c = this.staticLayer;
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = P.BACKGROUND;
    g.fillRect(0, 0, c.width, c.height);
    cam.apply(g, dpr);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = P.RIVER;
    g.lineWidth = this.map.river.width;
    g.stroke(this.riverPath);
    if (night) {
      // Lit streets are a night-time thing; by day they would only be clutter.
      g.strokeStyle = P.STREET_LIGHT;
      g.lineWidth = 14;
      g.stroke(this.litPath);
    }
    // At far zoom single-pixel outlines turn into texture; let the density field lead.
    g.globalAlpha = far ? 0.45 : 1;
    g.strokeStyle = P.BUILDING_OUTLINE;
    g.lineWidth = 1 / (cam.scale * dpr); // one device pixel, whatever the zoom
    g.stroke(this.outlinePath);
    g.globalAlpha = 1;
    return c;
  }

  draw(frame: FrameSnapshot, cam: Camera, dpr: number, wallMs: number): void {
    const g = this.g;
    const night = frame.daylight < 0.5;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.staticFor(cam, dpr, night), 0, 0);

    this.corpses.draw(g, cam, dpr);
    if (cam.mode === 'far') {
      this.density.draw(g, frame, cam, dpr);
      return;
    }
    this.drawOccupancy(g, frame, cam, dpr, wallMs);
    this.simTrails.sample(frame.simXY, frame.simKind, frame.tick, wallMs);
    this.zombieTrails.sample(frame.zombieXY, frame.zombieKind, frame.tick, wallMs);
    if (cam.mode === 'near') {
      this.zombieTrails.draw(g, cam, dpr, P.ZOMBIE_RGB, 1.2);
      this.simTrails.draw(g, cam, dpr, P.LIVING_RGB, 1.2);
    }
    this.drawAgents(g, frame, cam, dpr);
    this.drawPulses(g, cam, dpr, wallMs);
  }

  /** Expanding, fading rings where someone has just turned. */
  private drawPulses(g: CanvasRenderingContext2D, cam: Camera, dpr: number, wallMs: number): void {
    this.pulses = this.pulses.filter((p) => wallMs - p.start < PULSE_MS);
    if (this.pulses.length === 0) return;
    cam.apply(g, dpr);
    g.lineWidth = 1.5 / (cam.scale * dpr);
    const [r, gr, b] = P.ZOMBIE_RGB;
    for (const p of this.pulses) {
      const t = (wallMs - p.start) / PULSE_MS;
      g.strokeStyle = `rgba(${r}, ${gr}, ${b}, ${(0.8 * (1 - t)).toFixed(3)})`;
      g.beginPath();
      g.arc(p.x, p.y, Math.max(PULSE_RADIUS * t, 4 / cam.scale) + 1, 0, Math.PI * 2);
      g.stroke();
    }
  }

  /** Faint fill tracking how many are inside; residents and occupiers look the same. Contested buildings pulse. */
  private drawOccupancy(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number, wallMs: number): void {
    const view = this.viewBounds(cam);
    const levels = Array.from({ length: FILL_LEVELS }, () => new Path2D());
    const contested = new Path2D();
    const o = this.map.outlines;
    let anyContested = false;
    for (let i = 0; i < frame.fill.length; i++) {
      const n = frame.fill[i]!;
      if (n === 0) continue;
      const b = i * 4;
      if (this.bounds[b + 2]! < view.x0 || this.bounds[b]! > view.x1 || this.bounds[b + 3]! < view.y0 || this.bounds[b + 1]! > view.y1) continue;
      const level = Math.min(FILL_LEVELS - 1, Math.floor((Math.min(n, FULL_AT) / FULL_AT) * FILL_LEVELS));
      addOutline(levels[level]!, o, i);
      if (frame.buildingFlags[i]! & BUILDING_CONTESTED) {
        addOutline(contested, o, i);
        anyContested = true;
      }
    }
    cam.apply(g, dpr);
    const [r, gr, b] = P.BUILDING_FILL;
    for (let l = 0; l < FILL_LEVELS; l++) {
      g.fillStyle = `rgba(${r}, ${gr}, ${b}, ${(0.012 + (0.05 * (l + 1)) / FILL_LEVELS).toFixed(3)})`;
      g.fill(levels[l]!);
    }
    if (anyContested) {
      const pulse = 0.35 + 0.35 * Math.sin(wallMs / 180);
      const [cr, cg, cb] = P.CONTESTED;
      g.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${pulse.toFixed(3)})`;
      g.lineWidth = 2 / (cam.scale * dpr);
      g.stroke(contested);
    }
  }

  private drawAgents(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number): void {
    g.setTransform(1, 0, 0, 1, 0, 0);
    const size = Math.max(2, Math.min(6, cam.scale * 1.2)) * dpr;
    const half = size / 2;
    const w = this.canvas.width, h = this.canvas.height;
    const sx = (x: number) => cam.toScreenX(x) * dpr - half;
    const sy = (y: number) => cam.toScreenY(y) * dpr - half;

    // Zombies first, so the living are always on top.
    const zk = frame.zombieKind, zxy = frame.zombieXY;
    for (const [kind, colour] of [[ZOMBIE_DORMANT, P.ZOMBIE_DORMANT], [ZOMBIE_AWAKE, P.ZOMBIE]] as const) {
      g.fillStyle = colour;
      for (let i = 0; i < zk.length; i++) {
        if (zk[i] !== kind) continue;
        const x = sx(zxy[i * 2]!), y = sy(zxy[i * 2 + 1]!);
        if (x < -size || y < -size || x > w || y > h) continue;
        g.fillRect(x, y, size, size);
      }
    }
    const k = frame.simKind, xy = frame.simXY;
    g.fillStyle = P.LIVING;
    for (let i = 0; i < k.length; i++) {
      if (k[i] === SIM_HIDDEN || k[i] === SIM_PROMOTED) continue;
      const x = sx(xy[i * 2]!), y = sy(xy[i * 2 + 1]!);
      if (x < -size || y < -size || x > w || y > h) continue;
      g.fillRect(x, y, size, size);
    }
    g.fillStyle = P.PROMOTED;
    for (let i = 0; i < k.length; i++) {
      if (k[i] !== SIM_PROMOTED) continue;
      g.fillRect(sx(xy[i * 2]!) - 1, sy(xy[i * 2 + 1]!) - 1, size + 2, size + 2);
    }
  }

  private viewBounds(cam: Camera): { x0: number; y0: number; x1: number; y1: number } {
    const a = cam.toWorld(0, 0), b = cam.toWorld(cam.width, cam.height);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }
}
