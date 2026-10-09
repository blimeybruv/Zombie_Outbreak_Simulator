// Draws snapshots. Reads them, never writes simulation state (it holds none).
//
// Layers, bottom to top: the static city (cached, redrawn only when the camera or
// the light changes), the corpse paint, occupancy fill, trails (near zoom), the
// agents, conversion pulses, and the sounds that carry decisions: a warning shouted
// is a ring as wide as earshot, a shot a flash. At far zoom the agents give way to a density
// field — at that scale individuals are mush.
//
// `ingest` takes each snapshot's events exactly once; `draw` may run many times
// on the same snapshot.

import type { FrameSnapshot, MapSnapshot } from '../worker/protocol';
import { BUILDING_CONTESTED, SIM_FROZEN, SIM_HIDDEN, SIM_INFECTED, SIM_PROMOTED, ZOMBIE_AWAKE, ZOMBIE_DORMANT } from '../worker/protocol';
import type { Camera } from './camera';
import { CorpseLayer } from './corpses';
import { DensityField } from './density';
import * as P from './palette';
import { Trails } from './trails';

// Mid zoom sits between reading the city as density and following people: a faint
// density underlay so mass and flow read, short trails and names so individuals
// can be picked out and followed.
const MID_DENSITY = 0.5; // strength of the far-zoom density field under the dots
const MID_TRAIL = 5; // samples of trail (~0.8 s) at mid zoom; near zoom draws all
const PULSE_MS = 1400; // a conversion registers as an event, not a silent colour swap
const PULSE_RADIUS = 7; // m
const SHOUT_MS = 700;
const FLASH_MS = 160;
const GUNS = new Set(['pistol', 'smg', 'shotgun']);

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
  private readonly bridgeDecks = new Map<number, Path2D>(); // by street width, stroked in background colour
  private readonly bridgeRails: Path2D;
  private readonly litPath: Path2D;
  private readonly density: DensityField;
  private readonly corpses: CorpseLayer;
  private readonly simTrails = new Trails();
  private readonly zombieTrails = new Trails();
  private pulses: { x: number; y: number; start: number }[] = [];
  private sounds: { x: number; y: number; radius: number; shout: boolean; start: number }[] = [];
  /** How a bitten survivor shows at near zoom: an amber ring, a pale amber dot, or not at all (?infected=). */
  infectedStyle: 'ring' | 'fill' | 'off' = 'ring';
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
    // Streets are read from the gaps between buildings, but a river has no buildings to
    // frame a crossing, so bridges are drawn: a deck that cuts the water, and a rail
    // either side over the stretch that is actually water.
    this.bridgeRails = new Path2D();
    const line = map.river.centreline;
    const wetBy = map.river.width / 2 + 2;
    const wet = (x: number, y: number) => {
      for (let j = 0; j + 1 < line.length; j++) if (pointSegment(x, y, line[j]!, line[j + 1]!) <= wetBy) return true;
      return false;
    };
    for (let i = 0; i < map.streetBridge.length; i++) {
      if (!map.streetBridge[i]) continue;
      const s = i * 5;
      const ax = map.streets[s]!, ay = map.streets[s + 1]!, bx = map.streets[s + 2]!, by = map.streets[s + 3]!;
      const width = map.streets[s + 4]!;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const steps = Math.ceil(len / 2);
      let from = -1, to = -1;
      for (let k = 0; k <= steps; k++) {
        if (!wet(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps)) continue;
        if (from < 0) from = k;
        to = k;
      }
      if (from < 0) continue;
      const t0 = from / steps, t1 = to / steps;
      const x0 = ax + (bx - ax) * t0, y0 = ay + (by - ay) * t0, x1 = ax + (bx - ax) * t1, y1 = ay + (by - ay) * t1;
      let deck = this.bridgeDecks.get(width);
      if (!deck) this.bridgeDecks.set(width, (deck = new Path2D()));
      deck.moveTo(x0, y0);
      deck.lineTo(x1, y1);
      const nx = (-(by - ay) / len) * (width / 2), ny = ((bx - ax) / len) * (width / 2);
      for (const side of [1, -1]) {
        this.bridgeRails.moveTo(x0 + nx * side, y0 + ny * side);
        this.bridgeRails.lineTo(x1 + nx * side, y1 + ny * side);
      }
    }
    this.density = new DensityField(map.size);
    this.corpses = new CorpseLayer(map.size);
  }

  /** Takes a new snapshot's events: deaths into the corpse paint, conversions as pulses. */
  ingest(frame: FrameSnapshot, wallMs: number): void {
    this.corpses.add(frame.events, frame.tick);
    for (const e of frame.events) if (e.type === 'simTurned' && e.sim !== null) this.pulses.push({ x: e.x, y: e.y, start: wallMs });
    if (this.pulses.length > 400) this.pulses = this.pulses.slice(-400);
    for (const n of frame.noises) {
      const shout = n.kind === 'shout';
      if (shout || GUNS.has(n.kind)) this.sounds.push({ x: n.x, y: n.y, radius: n.radius, shout, start: wallMs });
    }
    if (this.sounds.length > 400) this.sounds = this.sounds.slice(-400);
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
    g.strokeStyle = P.BACKGROUND;
    g.lineCap = 'butt';
    for (const [width, deck] of this.bridgeDecks) {
      g.lineWidth = width;
      g.stroke(deck);
    }
    g.lineCap = 'round';
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
    g.stroke(this.bridgeRails);
    g.globalAlpha = 1;
    return c;
  }

  /** The building whose footprint contains a world point, if any. */
  buildingAt(x: number, y: number): number | null {
    const o = this.map.outlines;
    for (let i = 0; i < this.bounds.length / 4; i++) {
      const b = i * 4;
      if (x < this.bounds[b]! || x > this.bounds[b + 2]! || y < this.bounds[b + 1]! || y > this.bounds[b + 3]!) continue;
      let inside = false;
      for (let j = 0, k = 3; j < 4; k = j++) {
        const xj = o[i * 8 + j * 2]!, yj = o[i * 8 + j * 2 + 1]!, xk = o[i * 8 + k * 2]!, yk = o[i * 8 + k * 2 + 1]!;
        if (yj > y !== yk > y && x < ((xk - xj) * (y - yj)) / (yk - yj) + xj) inside = !inside;
      }
      if (inside) return i;
    }
    return null;
  }

  /** Where a building is, for centring on it. */
  buildingCentre(id: number): { x: number; y: number } {
    const b = id * 4;
    return { x: (this.bounds[b]! + this.bounds[b + 2]!) / 2, y: (this.bounds[b + 1]! + this.bounds[b + 3]!) / 2 };
  }

  /** The selection: a building's footprint stays outlined while the camera pans; a sim gets a ring. */
  drawSelection(sel: { kind: 'sim' | 'building'; id: number } | null, frame: FrameSnapshot, cam: Camera, dpr: number): void {
    if (!sel || cam.mode === 'far') return;
    const g = this.g;
    cam.apply(g, dpr);
    g.strokeStyle = P.SELECTION;
    g.lineWidth = 1.5 / (cam.scale * dpr);
    if (sel.kind === 'building') {
      const p = new Path2D();
      addOutline(p, this.map.outlines, sel.id);
      g.stroke(p);
    } else if (frame.simKind[sel.id]) {
      g.beginPath();
      g.arc(frame.simXY[sel.id * 2]!, frame.simXY[sel.id * 2 + 1]!, 7 / cam.scale, 0, Math.PI * 2);
      g.stroke();
    }
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
    if (cam.mode === 'mid') this.density.draw(g, frame, cam, dpr, MID_DENSITY);
    this.drawOccupancy(g, frame, cam, dpr, wallMs);
    this.simTrails.sample(frame.simXY, frame.simKind, frame.tick, wallMs);
    this.zombieTrails.sample(frame.zombieXY, frame.zombieKind, frame.tick, wallMs);
    const near = cam.mode === 'near';
    // Trail width is in screen pixels: thin enough at mid zoom not to smear the dots.
    this.zombieTrails.draw(g, cam, dpr, P.ZOMBIE_RGB, near ? 1.2 : 1, near ? undefined : MID_TRAIL);
    this.simTrails.draw(g, cam, dpr, P.LIVING_RGB, near ? 1.2 : 1, near ? undefined : MID_TRAIL);
    this.drawAgents(g, frame, cam, dpr);
    this.drawPulses(g, cam, dpr, wallMs);
    this.drawSounds(g, cam, dpr, wallMs);
  }

  /** Shouted warnings as faint rings growing to earshot; shots as brief flashes. */
  private drawSounds(g: CanvasRenderingContext2D, cam: Camera, dpr: number, wallMs: number): void {
    this.sounds = this.sounds.filter((n) => wallMs - n.start < (n.shout ? SHOUT_MS : FLASH_MS));
    if (this.sounds.length === 0) return;
    cam.apply(g, dpr);
    g.lineWidth = 1 / (cam.scale * dpr);
    for (const n of this.sounds) {
      const t = (wallMs - n.start) / (n.shout ? SHOUT_MS : FLASH_MS);
      const [r, gr, b] = n.shout ? P.SHOUT : P.FLASH;
      g.strokeStyle = `rgba(${r}, ${gr}, ${b}, ${((n.shout ? 0.22 : 0.9) * (1 - t)).toFixed(3)})`;
      g.beginPath();
      g.arc(n.x, n.y, n.shout ? Math.max(1, n.radius * t) : 1.5 + 2 * t, 0, Math.PI * 2);
      g.stroke();
    }
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
    const size = Math.max(2.5, Math.min(6, cam.scale * 1.2)) * dpr;
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
    const k = frame.simKind, f = frame.simFlags, xy = frame.simXY;
    // Near zoom only, the viewer is told who is bitten; the city is not.
    const showInfected = cam.mode === 'near' ? this.infectedStyle : 'off';
    const pale = showInfected === 'fill';
    // A frozen survivor, cornered and keeping still, is drawn dim: hiding in plain sight.
    for (const frozen of [false, true]) {
      g.globalAlpha = frozen ? 0.4 : 1;
      g.fillStyle = P.LIVING;
      for (let i = 0; i < k.length; i++) {
        if (k[i] === SIM_HIDDEN || k[i] === SIM_PROMOTED || ((f[i]! & SIM_FROZEN) !== 0) !== frozen) continue;
        if (pale && f[i]! & SIM_INFECTED) continue;
        const x = sx(xy[i * 2]!), y = sy(xy[i * 2 + 1]!);
        if (x < -size || y < -size || x > w || y > h) continue;
        g.fillRect(x, y, size, size);
      }
      if (pale) {
        g.fillStyle = P.INFECTED_PALE;
        for (let i = 0; i < k.length; i++) {
          if (k[i] === SIM_HIDDEN || k[i] === SIM_PROMOTED || !(f[i]! & SIM_INFECTED) || ((f[i]! & SIM_FROZEN) !== 0) !== frozen) continue;
          g.fillRect(sx(xy[i * 2]!), sy(xy[i * 2 + 1]!), size, size);
        }
      }
    }
    g.globalAlpha = 1;
    g.fillStyle = P.PROMOTED;
    for (let i = 0; i < k.length; i++) {
      if (k[i] !== SIM_PROMOTED) continue;
      g.fillRect(sx(xy[i * 2]!) - 1, sy(xy[i * 2 + 1]!) - 1, size + 2, size + 2);
    }
    if (showInfected === 'ring') {
      g.strokeStyle = P.INFECTED;
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      for (let i = 0; i < k.length; i++) {
        if (k[i] === SIM_HIDDEN || !(f[i]! & SIM_INFECTED)) continue;
        const cx = sx(xy[i * 2]!) + half, cy = sy(xy[i * 2 + 1]!) + half;
        if (cx < -size * 3 || cy < -size * 3 || cx > w + size * 3 || cy > h + size * 3) continue;
        g.moveTo(cx + size * 1.4, cy);
        g.arc(cx, cy, size * 1.4, 0, Math.PI * 2);
      }
      g.stroke();
    }
    // Names on promoted survivors, so they can be picked out and followed (not at far zoom).
    g.font = `${(cam.mode === 'near' ? 11 : 10) * dpr}px ui-monospace, Menlo, Consolas, monospace`;
    g.fillStyle = P.LABEL;
    g.textBaseline = 'middle';
    for (const r of frame.roster) {
      if (k[r.id] !== SIM_PROMOTED) continue;
      g.fillText(r.name, sx(xy[r.id * 2]!) + size + 4 * dpr, sy(xy[r.id * 2 + 1]!) + half);
    }
  }

  private viewBounds(cam: Camera): { x0: number; y0: number; x1: number; y1: number } {
    const a = cam.toWorld(0, 0), b = cam.toWorld(cam.width, cam.height);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }
}

/** Distance from a point to a segment. */
function pointSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - a.x - t * dx, py - a.y - t * dy);
}
