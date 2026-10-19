// Draws snapshots. Reads them, never writes simulation state (it holds none).
//
// Layers, bottom to top: the static city (cached, redrawn only when the camera or
// the light changes), standing cars (cached over it, redrawn when one starts, stops or
// is abandoned), the corpse paint, occupancy fill, trails (near zoom), the
// agents, conversion pulses, and the sounds that carry decisions: a warning shouted
// is a ring as wide as earshot, a shot a flash. At far zoom the agents give way to a density
// field — at that scale individuals are mush.
//
// `ingest` takes each snapshot's events exactly once; `draw` may run many times
// on the same snapshot.

import type { FrameSnapshot, MapSnapshot } from '../worker/protocol';
import { SHAPE_CHURCH, SHAPE_L, SHAPE_U } from '../worker/protocol';
import { BUILDING_CALL_WAITING, TENT_STRIDE } from '../worker/protocol';
import { BUILDING_CALL, BUILDING_CONTESTED, BUILDING_STAGE_MASK, BUILDING_STAGE_SHIFT, SIM_ARMED, SIM_FIGHTING, SIM_FLEEING, SIM_FROZEN, SIM_GUARD, SIM_HIDDEN, SIM_INFECTED, SIM_POLICE, SIM_PROMOTED, ZOMBIE_AWAKE, ZOMBIE_DORMANT, ZOMBIE_INTACT, CAR_ABANDONED, CAR_DRIVING, CAR_STATE_MASK, CAR_VAN, CAR_AMBULANCE, CAR_CRUISER, CAR_GONE } from '../worker/protocol';
import { Camera } from './camera';
import { CorpseLayer } from './corpses';
import { DensityField } from './density';
import { Interpolator } from './interpolate';
import { FAR_LIGHT_WIDTH, LAMP_GLOW_RADIUS, LAMP_HEAD_RADIUS, placeKerbLamps } from './lamps';
import * as P from './palette';
import { BorderLines } from './border';
import { Traffic } from './traffic';
import { Trails } from './trails';
import { FIREARMS } from '../sim/state';

// Mid zoom sits between reading the city as density and following people: a faint
// density underlay so mass and flow read, short trails and names so individuals
// can be picked out and followed.
const MID_DENSITY = 0.5; // strength of the far-zoom density field under the dots
const MID_TRAIL = 5; // samples of trail (~0.8 s) at mid zoom; near zoom draws all
const PULSE_MS = 1400; // a conversion registers as an event, not a silent colour swap
const PULSE_RADIUS = 7; // m
const SHOUT_MS = 700;
const DOOR_W = 1.8; // m
const DOOR_D = 0.9; // m
const BAR_OVERHANG = 0.5; // m either side of a door step
const INSET = 1.2; // m: a fortified building's inner outline
// The bitten's amber ring: its pulse period runs from PULSE_SLOW_MS a turn delay away
// (TURN_SLOW ticks or more) to PULSE_FAST_MS at the turn, on an exponential.
const TURN_SLOW = 1200; // ticks: the longest turn delay
const PULSE_SLOW_MS = 3200;
const PULSE_FAST_MS = 260;
const RING_LEVELS = 6; // alpha buckets, one stroke each
const PING_MS = 1100; // officers on the way: one ring closing in
const CALL_WAIT_MS = 2600; // a waiting call's slow pulse
const DISPATCH_MS = 800; // the flash as officers are sent
const FREEZE_PULSE_MS = 1600; // one slow breath of a frozen survivor
const ORIGIN_TICKS = 120; // how long patient zero's building is marked: 12 s of watching at 1×
const ORIGIN_PING_MS = 1500;
const ORIGIN_R_MAX = 70; // px, the mark's radius as each ping starts
const ORIGIN_R_MIN = 22; // px, as it settles
const ORIGIN_FULL_UP_TO = 3; // starting points drawn full size; more shrink with the square root of their number
const ORIGIN_MIN_SCALE = 0.3; // never smaller than this share of full size
const FLASH_MS = 160;
// A mall's parking: double rows of stalls, nose to nose, between drive aisles.
const STALL_W = 2.7; // m
const STALL_D = 5; // m
const AISLE = 7; // m
const DRIVE_GAP = 4.5; // m either side of the driveway kept clear
// A car, as drawn (the simulation's own size is config.cars).
const CAR_L = 4.5; // m
const CAR_W = 1.9; // m
const VAN_L = 6; // m: a SWAT van
const VAN_FLASH_MS = 260; // each colour's half of the light bar's cycle
const STATIC_MARGIN = 0.25;
const ROAD_MAIN_MIN_W = 16; // m: main roads and the highway
const ROAD_ALLEY_MAX_W = 8; // m: alleys
const ROAD_EDGE_W_MAIN = 1.8; // m
const ROAD_EDGE_W = 1.2; // m: a faint line along each long side of a standard carriageway
const ROAD_EDGE_W_ALLEY = 0.7; // m
const GLOW_MID_STOP = 0.22; // fraction of the glow radius: a tight core, then a long falloff
const GLOW_PX_MIN = 32; // sprite pixels across; below this a downscale would look blocky
const GLOW_PX_MAX = 384; // sprite pixels across; above this a near zoom is already 1:1
const CENTER_LINE_W = 1.5; // m
const CENTER_LINE_MIN_W = 14; // m: wider than a standard street (main roads and the highway)
const CENTER_DASH: [number, number] = [8, 6]; // m on, m off
const THROWN_MS = 650; // a struck zombie's flight
const THROWN_LIFT = 2.5; // m: how high it seems to go, drawn as a lift up the screen
const EXIT_STRIDE = 7; // values per exit in the map snapshot
const EXIT_ARROW_SCALE = 0.7; // the exit arrow, smaller than its spacing: signage, quieter than the barrier
const EXIT_ALPHA = 0.4;
const EXIT_LABEL_ALPHA = 0.6;
const BARRIER_DRAW_MS = 900; // a cordon barrier drawing itself across the road
const DNC_SIZE = 0.12; // DO NOT CROSS: letter height as a share of the road's width
const DNC_KERB = 1; // m: the underline stops short of each kerb
const BARRIER_KERB_M = 0.5; // m: past each kerb the barrier reaches — plainly spanning the road, short of the frontages (cordon.kerb)
// A gathering of three or more: a faint ring round it.
const TALK_RING_M = 2.5; // m
const TALK_RING_PER = 0.4; // m per person
const TALK_RING_PX = 5; // device px at least
const GUNS = new Set<string>(FIREARMS);

const FILL_LEVELS = 6; // occupancy alpha is bucketed so each level is one fill call
const FULL_AT = 24; // people inside at which a building reads as full

/** A church's frame: centre, unit long axis pointing east, half its length and half its width. */
/**
 * A church's frame in its plot: centre, the long axis (pointing east), half the drawn
 * length, half the nave's width w (also the apse's radius) and half the tower's h. A
 * nave narrower than the plot reads as a nave even on a squarish plot and leaves the
 * tower room to stand out either side of it; on a long shallow plot (joined suburban
 * houses) the church is cut to four nave-widths and centred, not drawn as a stick.
 */
function churchFrame(o: Float32Array, i: number): { cx: number; cy: number; ax: number; ay: number; half: number; w: number; h: number } {
  const k = i * 8;
  const cx = (o[k]! + o[k + 2]! + o[k + 4]! + o[k + 6]!) / 4, cy = (o[k + 1]! + o[k + 3]! + o[k + 5]! + o[k + 7]!) / 4;
  const ux = o[k + 2]! - o[k]!, uy = o[k + 3]! - o[k + 1]!, vx = o[k + 6]! - o[k]!, vy = o[k + 7]! - o[k + 1]!;
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  const [x, y, long, side] = lu >= lv ? [ux / lu, uy / lu, lu / 2, lv / 2] : [vx / lv, vy / lv, lv / 2, lu / 2];
  const east = x < 0 ? -1 : 1; // the axis points east
  const w = Math.min(side * 0.7, long * 0.36);
  const h = Math.min(w * 1.35, side); // clearly wider than the nave
  return { cx, cy, ax: x * east, ay: y * east, half: Math.min(long, w * 4), w, h };
}

/**
 * A church, in plan, as one continuous outline: a long nave, a square tower wider
 * than the nave standing at its western end, and a semicircular apse at the east
 * whose radius is half the nave's width, so the curve meets the corners. Parts share
 * edges and never overlap: an overlapping outline leaves an interior line that reads as
 * a mistake. The tower carries it — the silhouette still reads as a church a few pixels
 * across at mid zoom. East is the end of the long axis with the larger x, for want of a
 * liturgical east.
 */
function addChurch(path: Path2D, o: Float32Array, i: number): void {
  const { cx, cy, ax, ay, half, w, h } = churchFrame(o, i);
  const px = -ay, py = ax; // across the nave
  const at = (t: number, u: number): [number, number] => [cx + ax * t + px * u, cy + ay * t + py * u];
  const west = -half, towerEnd = -half + 2 * h; // a square tower
  const apseAt = half - w; // where the nave's sides end and the apse begins
  path.moveTo(...at(west, h));
  path.lineTo(...at(towerEnd, h));
  path.lineTo(...at(towerEnd, w));
  path.lineTo(...at(apseAt, w));
  const [acx, acy] = at(apseAt, 0);
  const north = Math.atan2(py, px);
  path.arc(acx, acy, w, north, north - Math.PI, true);
  path.lineTo(...at(towerEnd, -w));
  path.lineTo(...at(towerEnd, -h));
  path.lineTo(...at(west, -h));
  path.closePath();
}

/**
 * A hospital's L or a school's U, as one outline cut from the back of its plot: the
 * L loses a back corner, the U the middle of its back. The front (the wall its first
 * door is on) stays whole, so no door floats. Null, and a plain box, where a door
 * would fall in the cut. Drawing only: the simulation's footprint is the plot.
 */
function shapedOutline(o: Float32Array, i: number, shape: number, doors: number[][]): number[] | null {
  const k = i * 8;
  const p = [0, 1, 2, 3].map((j) => [o[k + j * 2]!, o[k + j * 2 + 1]!] as const);
  const cx = (p[0]![0] + p[1]![0] + p[2]![0] + p[3]![0]) / 4, cy = (p[0]![1] + p[1]![1] + p[2]![1] + p[3]![1]) / 4;
  if (doors.length === 0) return null;
  // The front: the wall whose outward normal best matches the first door's.
  const [, , dnx, dny] = doors[0]!;
  let front = 0, best = -Infinity;
  for (let j = 0; j < 4; j++) {
    const a = p[j]!, b = p[(j + 1) % 4]!;
    const mx = (a[0] + b[0]) / 2 - cx, my = (a[1] + b[1]) / 2 - cy;
    const l = Math.hypot(mx, my) || 1;
    const dot = (mx / l) * dnx! + (my / l) * dny!;
    if (dot > best) {
      best = dot;
      front = j;
    }
  }
  const back = (front + 2) % 4;
  const B0 = p[back]!, B1 = p[(back + 1) % 4]!, C2 = p[(back + 2) % 4]!, C3 = p[(back + 3) % 4]!;
  const len = Math.hypot(B1[0] - B0[0], B1[1] - B0[1]) || 1;
  const ux = (B1[0] - B0[0]) / len, uy = (B1[1] - B0[1]) / len; // along the back, B0 to B1
  const depth = Math.hypot(C2[0] - B1[0], C2[1] - B1[1]) || 1;
  const vx = (C2[0] - B1[0]) / depth, vy = (C2[1] - B1[1]) / depth; // from the back toward the front
  // Whether a door lies in the cut: [s0, s1] along the back, [0, d] in from it, with a metre's grace.
  const inCut = (s0: number, s1: number, d: number) =>
    doors.some(([x, y]) => {
      const s = (x! - B0[0]) * ux + (y! - B0[1]) * uy, t = (x! - B0[0]) * vx + (y! - B0[1]) * vy;
      return s > s0 - 1 && s < s1 + 1 && t < d + 1;
    });
  const at = (s: number, t: number) => [B0[0] + ux * s + vx * t, B0[1] + uy * s + vy * t];
  if (shape === SHAPE_U) {
    const s0 = len * 0.32, s1 = len * 0.68, d = depth * 0.42;
    if (inCut(s0, s1, d)) return null;
    return [...B0, ...at(s0, 0), ...at(s0, d), ...at(s1, d), ...at(s1, 0), ...B1, ...C2, ...C3];
  }
  // The L: the back corner with no door near it, B1's first.
  const cw = len * 0.45, d = depth * 0.45;
  if (!inCut(len - cw, len, d)) return [...B0, ...at(len - cw, 0), ...at(len - cw, d), ...at(len, d), ...C2, ...C3];
  if (!inCut(0, cw, d)) return [...at(0, d), ...at(cw, d), ...at(cw, 0), ...B1, ...C2, ...C3];
  return null;
}

function addPolygon(path: Path2D, pts: number[]): void {
  path.moveTo(pts[0]!, pts[1]!);
  for (let j = 2; j < pts.length; j += 2) path.lineTo(pts[j]!, pts[j + 1]!);
  path.closePath();
}

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
  /** Standing cars, the same size as the static layer and placed with it (standingCars). */
  private readonly carLayer: HTMLCanvasElement;
  private carKey = '';
  /** The world point at the middle of the static layer, as last drawn. */
  /** Outlines cut from their plots (hospitals, schools), by building index. */
  private readonly shapes = new Map<number, number[]>();
  private staticX = 0;
  private staticY = 0;
  private readonly outlinePath: Path2D;
  private readonly riverPath: Path2D;
  /** Scenery cars on the border motorway, drawn from simulation time alone. */
  private readonly traffic: Traffic;
  /** The border across the margin: rails and sleepers, motorway fences, median and sound barrier (border.ts). */
  private readonly border = new BorderLines();
  private readonly bridgeDecks = new Map<number, Path2D>(); // by street width, filled in background colour
  private readonly bridgeRails: Path2D;
  private readonly bridgeAbutments: Path2D;
  private readonly doorPath: Path2D; // a small step outside every entrance, drawn at near zoom
  private readonly doorBars = new Map<number, number[]>(); // per building: x0 y0 x1 y1 across each door step's outer edge
  /** Kerbside lamps on lit streets, placed once. The set is the staggered layout. */
  private readonly lamps: { x: number; y: number }[];
  /** One radial glow, redrawn when the static layer's pixels-per-metre changes. */
  private readonly glow = document.createElement('canvas');
  private glowPx = 0;
  /** Lit streets, stroked only at far zoom. */
  private readonly litPath = new Path2D();
  /** Every street, by width: its surface, drawn always. */
  private readonly streetPaths = new Map<number, Path2D>();
  /** Carriageways by hierarchy, narrow to wide, so a wider fill covers a crossing. */
  private readonly carriageways: { fill: Path2D; left: Path2D; right: Path2D; fillStyle: string; edgeStyle: string; edgeWidth: number }[];
  private readonly centerLinePath: Path2D; // wide streets only, dashed at near zoom
  private readonly groundsPath: Path2D; // a mall's grounds, open where the driveway comes in
  private readonly stallPath: Path2D; // its parking stalls, drawn at near zoom
  private readonly density: DensityField;
  private readonly corpses: CorpseLayer;
  private readonly simTrails = new Trails();
  private readonly barrierSeen: number[] = []; // per exit: when its barrier was first drawn (wall ms)
  private readonly zombieTrails = new Trails();
  private pulses: { x: number; y: number; start: number }[] = [];
  /** The dead a car has struck, in the air: from where it was hit, along the car's path. */
  private thrown: { x: number; y: number; dx: number; dy: number; distance: number; start: number }[] = [];
  /** Per sim: where the bitten are in their pulse (0–1), kept so a changing rate does not jump. */
  private turnPhase = new Float32Array(0);
  private lastPulseMs = 0;
  /** Officers sent to a 911 call: a brief flash at the building. */
  private dispatches: { building: number; start: number }[] = [];
  private sounds: { x: number; y: number; radius: number; shout: boolean; start: number }[] = [];
  private readonly interp = new Interpolator();
  /** Where the outbreak began, pinged with a biohazard mark until ORIGIN_TICKS. */
  private origins: { x: number; y: number }[] = [];
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
    this.carLayer = document.createElement('canvas');
    this.outlinePath = new Path2D();
    const o = map.outlines;
    const n = o.length / 8;
    // Hospitals' Ls and schools' Us, cut once from the back of their plots.
    const doorsOf = new Map<number, number[][]>();
    for (let i = 0; i < map.doors.length; i += 5) {
      const b = map.doors[i]!;
      if (map.buildingShape[b] !== SHAPE_L && map.buildingShape[b] !== SHAPE_U) continue;
      const list = doorsOf.get(b) ?? [];
      list.push([map.doors[i + 1]!, map.doors[i + 2]!, map.doors[i + 3]!, map.doors[i + 4]!]);
      doorsOf.set(b, list);
    }
    for (const [b, doors] of doorsOf) {
      const pts = shapedOutline(o, b, map.buildingShape[b]!, doors);
      if (pts) this.shapes.set(b, pts);
    }
    this.bounds = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const k = i * 8;
      this.addBuilding(this.outlinePath, i);
      const xs = [o[k]!, o[k + 2]!, o[k + 4]!, o[k + 6]!];
      const ys = [o[k + 1]!, o[k + 3]!, o[k + 5]!, o[k + 7]!];
      this.bounds.set([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], i * 4);
    }
    this.riverPath = new Path2D();
    map.river.centreline.forEach((p, i) => (i === 0 ? this.riverPath.moveTo(p.x, p.y) : this.riverPath.lineTo(p.x, p.y)));
    // Every street's surface, at its own width, by day and night alike (a street used to
    // show only at night, lit, and the city's roads vanished at dawn).
    for (let i = 0; i < map.streetLit.length; i++) {
      const s = i * 5;
      const width = map.streets[s + 4]!;
      let path = this.streetPaths.get(width);
      if (!path) this.streetPaths.set(width, (path = new Path2D()));
      path.moveTo(map.streets[s]!, map.streets[s + 1]!);
      path.lineTo(map.streets[s + 2]!, map.streets[s + 3]!);
      if (map.streetLit[i]) {
        this.litPath.moveTo(map.streets[s]!, map.streets[s + 1]!);
        this.litPath.lineTo(map.streets[s + 2]!, map.streets[s + 3]!);
      }
    }
    // Per street end: the widest other street meeting there, if it is a junction (three or
    // more streets) — a road merely continuing is not a crossing.
    const ends = new Map<string, number[]>();
    const endKey = (x: number, y: number) => `${Math.round(x * 10)},${Math.round(y * 10)}`;
    for (let i = 0; i < map.streetLit.length; i++) {
      for (const k of [0, 2]) {
        const key = endKey(map.streets[i * 5 + k]!, map.streets[i * 5 + k + 1]!);
        let list = ends.get(key);
        if (!list) ends.set(key, (list = []));
        list.push(i);
      }
    }
    const crossing = (x: number, y: number, self: number): number => {
      const list = ends.get(endKey(x, y))!;
      if (list.length < 3) return 0;
      let w = 0;
      for (const j of list) if (j !== self) w = Math.max(w, map.streets[j * 5 + 4]!);
      return w;
    };
    const carriageway = (fillStyle: string, edgeStyle: string, edgeWidth: number) => ({
      fill: new Path2D(), left: new Path2D(), right: new Path2D(), fillStyle, edgeStyle, edgeWidth,
    });
    // Narrow first. The second fill, in this order, lets a wider road cover the crossing.
    this.carriageways = [
      carriageway(P.ROAD_FILL_ALLEY, P.ROAD_EDGE_ALLEY, ROAD_EDGE_W_ALLEY),
      carriageway(P.ROAD_FILL, P.ROAD_EDGE, ROAD_EDGE_W),
      carriageway(P.ROAD_FILL_MAIN, P.ROAD_EDGE_MAIN, ROAD_EDGE_W_MAIN),
    ];
    this.centerLinePath = new Path2D();
    for (let i = 0; i < map.streetLit.length; i++) {
      const s = i * 5;
      const x1 = map.streets[s]!, y1 = map.streets[s + 1]!;
      const x2 = map.streets[s + 2]!, y2 = map.streets[s + 3]!;
      const width = map.streets[s + 4]!;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const hw = width / 2;
        const nx = -dy / len * hw, ny = dx / len * hw;
        const road = width >= ROAD_MAIN_MIN_W ? this.carriageways[2]! : width <= ROAD_ALLEY_MAX_W ? this.carriageways[0]! : this.carriageways[1]!;
        road.fill.moveTo(x1 + nx, y1 + ny);
        road.fill.lineTo(x2 + nx, y2 + ny);
        road.fill.lineTo(x2 - nx, y2 - ny);
        road.fill.lineTo(x1 - nx, y1 - ny);
        road.fill.closePath();
        road.left.moveTo(x1 + nx, y1 + ny);
        road.left.lineTo(x2 + nx, y2 + ny);
        road.right.moveTo(x1 - nx, y1 - ny);
        road.right.lineTo(x2 - nx, y2 - ny);
        if (width > CENTER_LINE_MIN_W) {
          // Stopped short of a junction by half the widest other road there: markings
          // stop at the crossing, they do not run through it.
          const ux = dx / len, uy = dy / len;
          const a = Math.min(len / 2, crossing(x1, y1, i) / 2), b = Math.min(len / 2, crossing(x2, y2, i) / 2);
          if (a + b < len) {
            this.centerLinePath.moveTo(x1 + ux * a, y1 + uy * a);
            this.centerLinePath.lineTo(x2 - ux * b, y2 - uy * b);
          }
        }
      }
    }
    this.lamps = placeKerbLamps(map.streets, map.streetLit);
    // Streets are read from the gaps between buildings, but a river has no buildings to
    // frame a crossing, so bridges are drawn: a deck that cuts the water from bank to bank,
    // a rail either side, and an abutment along each bank where it lands. The deck's ends
    // follow the banks, not the road: cut square to a road crossing at an angle, one corner
    // of each end fell short of the bank and left a triangle of water.
    this.bridgeRails = new Path2D();
    this.bridgeAbutments = new Path2D();
    const line = map.river.centreline;
    const bank = map.river.width / 2;
    for (let i = 0; i < map.streetBridge.length; i++) {
      if (!map.streetBridge[i]) continue;
      const s = i * 5;
      const ax = map.streets[s]!, ay = map.streets[s + 1]!, bx = map.streets[s + 2]!, by = map.streets[s + 3]!;
      const width = map.streets[s + 4]!;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const ux = (bx - ax) / len, uy = (by - ay) / len; // along the road
      // The river where this road crosses it: the centreline segment nearest the road's middle.
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      let best = Infinity, cx = 0, cy = 0, rx = 1, ry = 0;
      for (let j = 0; j + 1 < line.length; j++) {
        const d = pointSegment(mx, my, line[j]!, line[j + 1]!);
        if (d >= best) continue;
        best = d;
        const p = line[j]!, q = line[j + 1]!;
        const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
        rx = (q.x - p.x) / l;
        ry = (q.y - p.y) / l;
        cx = p.x;
        cy = p.y;
      }
      const cross = ux * ry - uy * rx; // sine of the crossing angle
      if (Math.abs(cross) < 0.2) continue; // running along the river, not across it
      const nx = -uy * (width / 2), ny = ux * (width / 2); // to one side of the road
      const qx = -ry, qy = rx; // across the river
      // Where a line along the road, offset by (ox, oy), meets the bank at signed distance b from the centreline.
      const meet = (ox: number, oy: number, b: number): [number, number] => {
        // (a + o + u t - c) · q = b, solved for t.
        const t = (b - ((ax + ox - cx) * qx + (ay + oy - cy) * qy)) / (ux * qx + uy * qy);
        return [ax + ox + ux * t, ay + oy + uy * t];
      };
      // Banks in the order the road meets them.
      const near = (ux * qx + uy * qy > 0 ? -1 : 1) * bank, far = -near;
      const corners = [meet(nx, ny, near), meet(nx, ny, far), meet(-nx, -ny, far), meet(-nx, -ny, near)];
      let deck = this.bridgeDecks.get(width);
      if (!deck) this.bridgeDecks.set(width, (deck = new Path2D()));
      deck.moveTo(...corners[0]!);
      for (const c of corners.slice(1)) deck.lineTo(...c);
      deck.closePath();
      this.bridgeRails.moveTo(...corners[0]!);
      this.bridgeRails.lineTo(...corners[1]!);
      this.bridgeRails.moveTo(...corners[3]!);
      this.bridgeRails.lineTo(...corners[2]!);
      // An abutment along each bank, a little wider than the deck where it lands.
      for (const [a, b] of [[corners[0]!, corners[3]!], [corners[1]!, corners[2]!]] as const) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const l = Math.hypot(dx, dy) || 1;
        const over = Math.min(6, width * 0.4);
        this.bridgeAbutments.moveTo(a[0] - (dx / l) * over, a[1] - (dy / l) * over);
        this.bridgeAbutments.lineTo(b[0] + (dx / l) * over, b[1] + (dy / l) * over);
      }
    }
    this.border.build(map, this.bridgeDecks, this.bridgeRails);
    this.traffic = new Traffic(map);
    // Doors: a step DOOR_W wide standing DOOR_D proud of the wall, so it shows where
    // people go in and out — a dot reaching a door otherwise simply vanishes.
    this.doorPath = new Path2D();
    const step = (x: number, y: number, nx: number, ny: number, w: number, b: number) => {
      const tx = -ny * (w / 2), ty = nx * (w / 2);
      // The bar a barricade puts across it: a little wider than the step, at its outer edge.
      const bars = this.doorBars.get(b) ?? [];
      const k = 1 + BAR_OVERHANG / (w / 2);
      bars.push(x + tx * k + nx * DOOR_D, y + ty * k + ny * DOOR_D, x - tx * k + nx * DOOR_D, y - ty * k + ny * DOOR_D);
      this.doorBars.set(b, bars);
      this.doorPath.moveTo(x + tx, y + ty);
      this.doorPath.lineTo(x + tx + nx * DOOR_D, y + ty + ny * DOOR_D);
      this.doorPath.lineTo(x - tx + nx * DOOR_D, y - ty + ny * DOOR_D);
      this.doorPath.lineTo(x - tx, y - ty);
    };
    const d = map.doors;
    for (let i = 0; i < d.length; i += 5) {
      if (map.buildingShape[d[i]!] === SHAPE_CHURCH) continue; // its plot's doors would float beside the drawn church
      step(d[i + 1]!, d[i + 2]!, d[i + 3]!, d[i + 4]!, DOOR_W, d[i]!);
    }
    // A church's door: the west face of its tower, a little grander.
    for (let i = 0; i < map.buildingShape.length; i++) {
      if (map.buildingShape[i] !== SHAPE_CHURCH) continue;
      const f = churchFrame(map.outlines, i);
      step(f.cx - f.ax * f.half, f.cy - f.ay * f.half, -f.ax, -f.ay, DOOR_W * 1.6, i);
    }
    // Malls: the grounds' edge, broken where the driveway enters, and rows of stalls
    // either side of it.
    this.groundsPath = new Path2D();
    this.stallPath = new Path2D();
    for (let i = 0; i < map.lots.length; i += 10) {
      const l = map.lots;
      const x0 = l[i]!, y0 = l[i + 1]!;
      const w = Math.hypot(l[i + 2]! - x0, l[i + 3]! - y0) || 1;
      const dx = (l[i + 2]! - x0) / w, dy = (l[i + 3]! - y0) / w; // along the front
      const depth = Math.hypot(l[i + 6]! - x0, l[i + 7]! - y0) || 1;
      const ix = (l[i + 6]! - x0) / depth, iy = (l[i + 7]! - y0) / depth; // inward
      const parking = l[i + 8]!, entry = l[i + 9]!;
      const at = (u: number, v: number): [number, number] => [x0 + dx * u + ix * v, y0 + dy * u + iy * v];
      this.groundsPath.moveTo(...at(entry - DRIVE_GAP, 0));
      this.groundsPath.lineTo(...at(0, 0));
      this.groundsPath.lineTo(...at(0, depth));
      this.groundsPath.lineTo(...at(w, depth));
      this.groundsPath.lineTo(...at(w, 0));
      this.groundsPath.lineTo(...at(entry + DRIVE_GAP, 0));
      const spans: [number, number][] = [[AISLE / 2, entry - DRIVE_GAP], [entry + DRIVE_GAP, w - AISLE / 2]];
      for (let v = AISLE / 2; v + 2 * STALL_D <= parking - AISLE / 2; v += 2 * STALL_D + AISLE) {
        for (const [u0, u1] of spans) {
          if (u1 - u0 < STALL_W) continue;
          this.stallPath.moveTo(...at(u0, v + STALL_D));
          this.stallPath.lineTo(...at(u1, v + STALL_D));
          for (let u = u0; u <= u1 + 0.01; u += STALL_W) {
            this.stallPath.moveTo(...at(u, v));
            this.stallPath.lineTo(...at(u, v + 2 * STALL_D));
          }
        }
      }
    }
    this.density = new DensityField(map.size);
    this.origins = map.origins.map((o) => ({ x: o.x, y: o.y }));
    this.corpses = new CorpseLayer(map.size);
  }

  /**
   * Positions for this animation frame, blended between ticks. Call once per frame,
   * before `draw` and before reading `simAt`.
   */
  advance(frame: FrameSnapshot, wallMs: number, ticksPerSecond: number): void {
    this.interp.update(frame, wallMs, ticksPerSecond);
  }

  /** Where a sim is drawn this frame. */
  simAt(id: number): { x: number; y: number } {
    return { x: this.interp.sim[id * 2]!, y: this.interp.sim[id * 2 + 1]! };
  }

  /** Takes a new snapshot's events: deaths into the corpse paint, conversions as pulses. */
  ingest(frame: FrameSnapshot, wallMs: number): void {
    this.corpses.add(frame.events, frame.tick);
    for (const e of frame.events) {
      if (e.type === 'simTurned' && e.sim !== null) this.pulses.push({ x: e.x, y: e.y, start: wallMs });
      if (e.type === 'policeDispatched') this.dispatches.push({ building: e.building, start: wallMs });
      if (e.type === 'carHit') this.thrown.push({ x: e.x, y: e.y, dx: e.dx, dy: e.dy, distance: e.distance, start: wallMs });
    }
    if (this.pulses.length > 400) this.pulses = this.pulses.slice(-400);
    if (this.thrown.length > 100) this.thrown = this.thrown.slice(-100);
    for (const n of frame.noises) {
      const shout = n.kind === 'shout';
      if (shout || GUNS.has(n.kind)) this.sounds.push({ x: n.x, y: n.y, radius: n.radius, shout, start: wallMs });
    }
    if (this.sounds.length > 400) this.sounds = this.sounds.slice(-400);
  }

  /**
   * The glow bitmap for the current layer. Diameter tracks the layer's device pixels
   * per metre, clamped, so a near zoom is one sprite pixel per screen pixel and a
   * mid zoom is downscaled rather than a handful of blocks.
   */
  private glowSprite(pxPerMetre: number): HTMLCanvasElement {
    const px = Math.max(GLOW_PX_MIN, Math.min(GLOW_PX_MAX, Math.ceil(LAMP_GLOW_RADIUS * 2 * pxPerMetre)));
    if (px === this.glowPx) return this.glow;
    this.glowPx = px;
    this.glow.width = px;
    this.glow.height = px;
    const g = this.glow.getContext('2d')!;
    const r = px / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0, P.LAMP_GLOW_CORE);
    grd.addColorStop(GLOW_MID_STOP, P.LAMP_GLOW_MID);
    grd.addColorStop(1, P.LAMP_GLOW_EDGE);
    g.clearRect(0, 0, px, px);
    g.fillStyle = grd;
    g.fillRect(0, 0, px, px);
    return this.glow;
  }

  /**
   * The static city, drawn larger than the view by STATIC_MARGIN of it on every side and
   * kept while the camera only pans: following someone, or dragging, shifts the image
   * rather than redrawing the city each frame (which cost 40–50 ms a frame in the build
   * container). Redrawn on a zoom, at nightfall and daybreak, when a car starts, stops
   * or is abandoned, or when the view leaves the margin. Returns where to draw it, in
   * device pixels.
   */
  private staticFor(cam: Camera, dpr: number, night: boolean, frame: FrameSnapshot): { layer: HTMLCanvasElement; x: number; y: number } {
    const far = cam.mode === 'far';
    const key = `${cam.scale}|${night}|${far}|${cam.mode}|${this.canvas.width}x${this.canvas.height}`;
    const c = this.staticLayer;
    const k = cam.scale * dpr;
    const placed = () => ({ layer: c, x: (this.canvas.width - c.width) / 2 + (this.staticX - cam.x) * k, y: (this.canvas.height - c.height) / 2 + (this.staticY - cam.y) * k });
    if (key === this.staticKey) {
      const p = placed();
      if (p.x <= 0 && p.y <= 0 && p.x + c.width >= this.canvas.width && p.y + c.height >= this.canvas.height) {
        this.standingCars(cam, dpr, frame);
        return p;
      }
    }
    this.staticKey = key;
    this.staticX = cam.x;
    this.staticY = cam.y;
    c.width = Math.ceil(this.canvas.width * (1 + 2 * STATIC_MARGIN));
    c.height = Math.ceil(this.canvas.height * (1 + 2 * STATIC_MARGIN));
    // A camera over the larger layer, at the same scale and centre.
    const view = cam;
    cam = new Camera(view.x, view.y, view.scale);
    cam.resize(c.width / dpr, c.height / dpr);
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
    // Streets first, opaque so that where two widths meet they do not add up: under the
    // border (a level crossing's rails run across the road) and the bridge decks.
    // The stroke is the full carriageway, so the lighter fill, the edge and the centre
    // line are drawn after it — anything before it would be covered.
    g.strokeStyle = P.STREET;
    for (const [width, path] of this.streetPaths) {
      g.lineWidth = width;
      g.stroke(path);
    }
    for (const road of this.carriageways) {
      g.fillStyle = road.fillStyle;
      g.fill(road.fill);
    }
    for (const road of this.carriageways) {
      g.strokeStyle = road.edgeStyle;
      g.lineWidth = road.edgeWidth;
      g.stroke(road.left);
      g.stroke(road.right);
    }
    // Each side runs the full segment, so at a junction it crosses the other carriageway.
    // Filling again covers any edge that lies inside a road; the kerb outside the quads stays.
    // Wider last, so the overlap at a crossing takes the wider road's fill.
    for (const road of this.carriageways) {
      g.fillStyle = road.fillStyle;
      g.fill(road.fill);
    }
    // The static layer's cache key includes cam.mode, same as the parking stalls below,
    // so a near-only stroke here is baked into the near layer and left out of the others.
    if (cam.mode === 'near') {
      g.strokeStyle = P.CENTER_LINE;
      g.lineWidth = CENTER_LINE_W;
      g.setLineDash(CENTER_DASH);
      g.stroke(this.centerLinePath);
      g.setLineDash([]);
    }
    this.border.draw(g, cam, dpr);
    g.fillStyle = P.BACKGROUND;
    for (const deck of this.bridgeDecks.values()) g.fill(deck);
    if (night && far) {
      // Individual pools are a few pixels at this scale and the layer covers the whole
      // city, so lit streets are one faint stroke instead.
      g.strokeStyle = P.STREET_LIGHT;
      g.lineWidth = FAR_LIGHT_WIDTH;
      g.stroke(this.litPath);
    } else if (night) {
      // The sprite is one device pixel per metre-pixel of this layer, so a near zoom
      // stamps it 1:1. It is rebuilt only when that size changes.
      const sprite = this.glowSprite(cam.scale * dpr);
      const halfW = cam.width / 2 / cam.scale;
      const halfH = cam.height / 2 / cam.scale;
      const minX = cam.x - halfW, maxX = cam.x + halfW;
      const minY = cam.y - halfH, maxY = cam.y + halfH;
      const d = LAMP_GLOW_RADIUS * 2;
      g.imageSmoothingEnabled = true;
      for (const lamp of this.lamps) {
        if (lamp.x < minX || lamp.x > maxX || lamp.y < minY || lamp.y > maxY) continue;
        g.drawImage(sprite, lamp.x - LAMP_GLOW_RADIUS, lamp.y - LAMP_GLOW_RADIUS, d, d);
      }
      if (cam.mode === 'near') {
        g.fillStyle = P.LAMP_HEAD;
        g.beginPath();
        for (const lamp of this.lamps) {
          if (lamp.x < minX || lamp.x > maxX || lamp.y < minY || lamp.y > maxY) continue;
          g.moveTo(lamp.x + LAMP_HEAD_RADIUS, lamp.y);
          g.arc(lamp.x, lamp.y, LAMP_HEAD_RADIUS, 0, Math.PI * 2);
        }
        g.fill();
      }
    }
    // At far zoom single-pixel outlines turn into texture; let the density field lead.
    g.globalAlpha = far ? 0.45 : 1;
    g.strokeStyle = P.BUILDING_OUTLINE;
    g.lineWidth = 1 / (cam.scale * dpr); // one device pixel, whatever the zoom
    g.stroke(this.outlinePath);
    g.stroke(this.bridgeRails);
    // The abutments: heavier than a rail, the bridge set into the bank.
    g.lineWidth = Math.max(2.5 / (cam.scale * dpr), 1); // 2.5 px, or a metre once that is wider
    g.stroke(this.bridgeAbutments);
    g.lineWidth = 1 / (cam.scale * dpr);
    if (cam.mode === 'near') g.stroke(this.doorPath);
    g.globalAlpha = far ? 0.25 : 0.6;
    g.stroke(this.groundsPath);
    if (cam.mode === 'near') g.stroke(this.stallPath);
    g.globalAlpha = 1;
    this.drawExits(g, cam, dpr);
    cam = view;
    this.carKey = '';
    this.standingCars(cam, dpr, frame);
    return placed();
  }

  /**
   * Cars standing still, on a layer of their own over the static city and placed with it,
   * redrawn only when one starts, stops or is abandoned (the states' signature changes).
   * They were drawn into the city layer itself, so every car that parked or was
   * abandoned redrew the whole city: late in a run, with people driving for the exit,
   * that was a hitch every few seconds.
   */
  private standingCars(cam: Camera, dpr: number, frame: FrameSnapshot): void {
    let sig = 0;
    const st = frame.carState;
    for (let i = 0; i < st.length; i++) sig = (sig * 31 + st[i]! + 1) | 0;
    const key = `${this.staticKey}|${this.staticX}|${this.staticY}|${sig}`;
    if (key === this.carKey) return;
    this.carKey = key;
    const c = this.carLayer, city = this.staticLayer;
    if (c.width !== city.width || c.height !== city.height) {
      c.width = city.width;
      c.height = city.height;
    }
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    if (cam.mode === 'far') return;
    const at = new Camera(this.staticX, this.staticY, cam.scale);
    at.resize(c.width / dpr, c.height / dpr);
    at.apply(g, dpr);
    this.drawCars(g, frame, at, dpr, false);
  }

  /** A building's outline, as drawn: a church in plan, a hospital's L or a school's U, else its plot. */
  private addBuilding(path: Path2D, i: number): void {
    if (this.map.buildingShape[i] === SHAPE_CHURCH) return addChurch(path, this.map.outlines, i);
    const pts = this.shapes.get(i);
    if (pts) addPolygon(path, pts);
    else addOutline(path, this.map.outlines, i);
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
      this.addBuilding(p, sel.id);
      g.stroke(p);
    } else if (frame.simKind[sel.id]) {
      g.beginPath();
      g.arc(this.interp.sim[sel.id * 2]!, this.interp.sim[sel.id * 2 + 1]!, 7 / cam.scale, 0, Math.PI * 2);
      g.stroke();
    }
  }

  draw(frame: FrameSnapshot, cam: Camera, dpr: number, wallMs: number): void {
    const g = this.g;
    const night = frame.daylight < 0.5;
    g.setTransform(1, 0, 0, 1, 0, 0);
    const city = this.staticFor(cam, dpr, night, frame);
    g.drawImage(city.layer, city.x, city.y);
    if (cam.mode !== 'far') g.drawImage(this.carLayer, city.x, city.y);
    this.traffic.draw(g, cam, dpr, this.interp.time);

    this.corpses.draw(g, cam, dpr);
    if (cam.mode === 'far') {
      this.density.draw(g, frame, cam, dpr);
      this.drawCalls(g, frame, cam, dpr, wallMs);
      this.drawOrigin(g, frame, cam, dpr, wallMs);
      return;
    }
    if (cam.mode === 'mid') this.density.draw(g, frame, cam, dpr, MID_DENSITY);
    this.drawOccupancy(g, frame, cam, dpr, wallMs);
    if (cam.mode === 'near') this.drawStages(g, frame, cam, dpr);
    this.simTrails.sample(frame.simXY, frame.simKind, frame.tick, wallMs);
    this.zombieTrails.sample(frame.zombieXY, frame.zombieKind, frame.tick, wallMs);
    const near = cam.mode === 'near';
    // Trail width is in screen pixels: thin enough at mid zoom not to smear the dots.
    this.zombieTrails.draw(g, cam, dpr, P.ZOMBIE_RGB, near ? 1.2 : 1, near ? undefined : MID_TRAIL);
    this.simTrails.draw(g, cam, dpr, P.LIVING_RGB, near ? 1.2 : 1, near ? undefined : MID_TRAIL);
    // Flight: whoever is running for their life leaves a long bright streak, at mid zoom too.
    const fleeing: number[] = [];
    for (let i = 0; i < frame.simFlags.length; i++) if (frame.simFlags[i]! & SIM_FLEEING) fleeing.push(i);
    if (fleeing.length > 0) this.simTrails.draw(g, cam, dpr, P.LIVING_RGB, near ? 1.8 : 1.4, undefined, 0.8, fleeing);
    this.drawCars(g, frame, cam, dpr, true);
    this.drawVanLights(g, frame, cam, dpr, wallMs);
    this.drawBarriers(g, frame, cam, dpr, wallMs);
    this.drawTents(g, frame, cam, dpr);
    this.drawTalk(g, frame, cam, dpr);
    if (cam.mode === 'near') this.drawSquads(g, frame, cam, dpr);
    this.drawAgents(g, frame, cam, dpr, wallMs);
    this.drawPulses(g, cam, dpr, wallMs);
    this.drawThrown(g, cam, dpr, wallMs);
    this.drawSounds(g, cam, dpr, wallMs);
    this.drawCalls(g, frame, cam, dpr, wallMs);
    this.drawOrigin(g, frame, cam, dpr, wallMs);
  }

  /**
   * Where it began: a red ☣ in a ring over patient zero's building, shrinking onto it
   * like a ping, from the start (the run opens paused) until ORIGIN_TICKS have run.
   */
  /**
   * Cars: a rectangle along its heading. Driving, filled, every frame (`moving`);
   * standing still, into the static layer: abandoned, dark and crossed — a road that
   * will not reopen — at mid and near zoom; parked, a dim outline, at near zoom only
   * (at mid zoom a parked car is a pixel of clutter).
   */
  private drawCars(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number, moving: boolean): void {
    const xyh = frame.carXYH, st = frame.carState;
    if (st.length === 0) return;
    const near = cam.mode === 'near';
    const hw = CAR_W / 2;
    const parked = new Path2D(), driving = new Path2D(), abandoned = new Path2D(), crosses = new Path2D(), vans = new Path2D(), ambulances = new Path2D();
    for (let i = 0; i < st.length; i++) {
      const x = xyh[i * 3]!, y = xyh[i * 3 + 1]!, h = xyh[i * 3 + 2]!;
      const c = Math.cos(h), s = Math.sin(h);
      const state = st[i]! & CAR_STATE_MASK;
      if (state === CAR_GONE) continue; // off the map
      const amb = (st[i]! & CAR_AMBULANCE) !== 0;
      const cruiser = (st[i]! & CAR_CRUISER) !== 0;
      const long = (st[i]! & CAR_VAN) !== 0 || amb;
      const van = long || cruiser; // a service vehicle: drawn in its colour, at mid zoom too
      const hl = long ? VAN_L / 2 : CAR_L / 2;
      const pt = (u: number, v: number): [number, number] => [x + c * u - s * v, y + s * u + c * v];
      // A van shows at mid zoom too, parked or not: it is a squad's way out, or its box.
      if ((state === CAR_DRIVING) !== moving || (state !== CAR_DRIVING && state !== CAR_ABANDONED && !near && !van)) continue;
      const path = amb && state !== CAR_ABANDONED ? ambulances : van && state !== CAR_ABANDONED ? vans : state === CAR_DRIVING ? driving : state === CAR_ABANDONED ? abandoned : parked;
      path.moveTo(...pt(hl, hw));
      path.lineTo(...pt(-hl, hw));
      path.lineTo(...pt(-hl, -hw));
      path.lineTo(...pt(hl, -hw));
      path.closePath();
      if (state === CAR_ABANDONED) {
        crosses.moveTo(...pt(hl, hw));
        crosses.lineTo(...pt(-hl, -hw));
        crosses.moveTo(...pt(hl, -hw));
        crosses.lineTo(...pt(-hl, hw));
      }
    }
    g.lineWidth = 1 / (cam.scale * dpr);
    g.strokeStyle = P.CAR;
    g.stroke(parked);
    g.fillStyle = P.CAR_DRIVING;
    g.fill(driving);
    g.fillStyle = P.CAR_ABANDONED;
    g.fill(abandoned);
    g.fillStyle = P.POLICE;
    g.fill(vans);
    g.fillStyle = P.AMBULANCE;
    g.fill(ambulances);
    g.strokeStyle = P.CAR;
    g.stroke(abandoned);
    g.stroke(crosses);
  }

  /**
   * Conversations: a faint line from each person in one to its middle, so a pair reads
   * as a link and a gathering as a hub. Mid and near zoom; at far zoom it is two pixels.
   */
  private drawTalk(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number): void {
    const t = frame.talk;
    if (t.length === 0) return;
    const sum = new Map<number, { x: number; y: number; n: number }>();
    for (let i = 0; i < t.length; i += 2) {
      const p = this.simAt(t[i]!);
      const c = sum.get(t[i + 1]!) ?? { x: 0, y: 0, n: 0 };
      c.x += p.x;
      c.y += p.y;
      c.n++;
      sum.set(t[i + 1]!, c);
    }
    const path = new Path2D();
    for (let i = 0; i < t.length; i += 2) {
      const c = sum.get(t[i + 1]!)!;
      if (c.n < 2) continue;
      const p = this.simAt(t[i]!);
      path.moveTo(p.x, p.y);
      path.lineTo(c.x / c.n, c.y / c.n);
    }
    // Three or more: a ring round the knot, never smaller than TALK_RING_PX, so a
    // gathering still reads at mid zoom where it is a pixel or two across.
    const minR = TALK_RING_PX / (cam.scale * dpr);
    for (const c of sum.values()) {
      if (c.n < 3) continue;
      const r = Math.max(minR, TALK_RING_M + TALK_RING_PER * c.n);
      path.moveTo(c.x / c.n + r, c.y / c.n);
      path.arc(c.x / c.n, c.y / c.n, r, 0, Math.PI * 2);
    }
    g.strokeStyle = P.TALK;
    g.lineWidth = Math.max(1 / (cam.scale * dpr), 0.35);
    g.stroke(path);
  }

  /** A SWAT van or police car on the move: a light bar on the roof, red and blue taking turns; an ambulance's, red, on and off. */
  private drawVanLights(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number, wallMs: number): void {
    const xyh = frame.carXYH, st = frame.carState;
    // At least a few pixels, with a soft glow round each light, so a moving van or
    // ambulance can be picked out at mid zoom, where the vehicle itself is a speck.
    const r = Math.max(0.6, 3 / (cam.scale * dpr));
    const swap = Math.floor(wallMs / VAN_FLASH_MS) % 2 === 1;
    for (let i = 0; i < st.length; i++) {
      const amb = (st[i]! & CAR_AMBULANCE) !== 0;
      const cruiser = (st[i]! & CAR_CRUISER) !== 0;
      if (((st[i]! & CAR_VAN) === 0 && !amb && !cruiser) || (st[i]! & CAR_STATE_MASK) !== CAR_DRIVING) continue;
      const len = cruiser ? CAR_L : VAN_L;
      if (amb && swap) continue; // off half the time
      const x = xyh[i * 3]!, y = xyh[i * 3 + 1]!, h = xyh[i * 3 + 2]!;
      const c = Math.cos(h), s = Math.sin(h);
      // Across the cab, a little forward of the middle.
      for (const side of [1, -1]) {
        const u = len * 0.15, v = side * CAR_W * 0.28;
        const red = amb || (side === 1) !== swap;
        const lx = x + c * u - s * v, ly = y + s * u + c * v;
        g.fillStyle = red ? P.SIREN_RED_GLOW : P.SIREN_BLUE_GLOW;
        g.beginPath();
        g.arc(lx, ly, r * 3, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = red ? P.SIREN_RED : P.SIREN_BLUE;
        g.beginPath();
        g.arc(lx, ly, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  /**
   * Ways off the map: an arrow at the edge pointing out along the highway, and the word
   * clear of it further in, at every zoom — kept faint and small: signage, not the
   * thing to look at. The barrier, once there is one, is.
   */
  private drawExits(g: CanvasRenderingContext2D, cam: Camera, dpr: number): void {
    const e = this.map.exits;
    const px = 1 / (cam.scale * dpr); // one device pixel in metres
    const r = Math.max(14, 16 * px);
    const a = r * EXIT_ARROW_SCALE;
    g.fillStyle = P.EXIT;
    g.font = `${Math.round(10 * dpr)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < e.length; i += EXIT_STRIDE) {
      const x = e[i]!, y = e[i + 1]!, dx = e[i + 2]!, dy = e[i + 3]!;
      const nx = -dy, ny = dx;
      const tx = x - dx * r * 1.2, ty = y - dy * r * 1.2; // just inside the edge
      g.globalAlpha = EXIT_ALPHA;
      g.beginPath();
      g.moveTo(tx + dx * a, ty + dy * a);
      g.lineTo(tx - dx * a * 0.4 + nx * a * 0.8, ty - dy * a * 0.4 + ny * a * 0.8);
      g.lineTo(tx - dx * a * 0.4 - nx * a * 0.8, ty - dy * a * 0.4 - ny * a * 0.8);
      g.closePath();
      g.fill();
      // The label, in screen pixels, further in.
      g.globalAlpha = EXIT_LABEL_ALPHA;
      g.save();
      g.translate(tx - dx * r * 2.2, ty - dy * r * 2.2);
      g.scale(px, px);
      g.fillText('EXIT', 0, 0);
      g.restore();
    }
    g.globalAlpha = 1;
  }

  /**
   * The cordon's barriers: a hard bright bar across the highway in the institutional
   * blue — the one thing in the city an outside authority put there. It draws itself
   * across the road from the middle out when it first appears, so it reads as an event.
   */
  private drawBarriers(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number, wallMs: number): void {
    if (frame.closedExits === 0) return;
    const e = this.map.exits;
    const px = 1 / (cam.scale * dpr);
    g.strokeStyle = P.POLICE;
    g.lineWidth = Math.max(3, 5 * px); // square ends: it stops where it stops, at the kerbs
    for (let i = 0, k = 0; i < e.length; i += EXIT_STRIDE, k++) {
      if (!(frame.closedExits & (1 << k))) continue;
      this.barrierSeen[k] ??= wallMs;
      const grow = Math.min(1, (wallMs - this.barrierSeen[k]!) / BARRIER_DRAW_MS);
      const nx = -e[i + 3]!, ny = e[i + 2]!, bx = e[i + 4]!, by = e[i + 5]!;
      const half = (e[i + 6]! / 2 + BARRIER_KERB_M) * grow; // kerb to kerb, and a little past
      // Breached, nobody left to hold it: still there, but faded, abandoned.
      g.globalAlpha = frame.breachedExits & (1 << k) ? 0.3 : 1;
      g.beginPath();
      g.moveTo(bx - nx * half, by - ny * half);
      g.lineTo(bx + nx * half, by + ny * half);
      g.stroke();
      if (cam.mode !== 'far') this.drawDoNotCross(g, e[i + 2]!, e[i + 3]!, bx, by, e[i + 6]!, px);
    }
    g.globalAlpha = 1;
  }

  /** The rescue's tents beside the road beyond its barrier: an outline and a ridge along it, filled faintly while anyone waits in them for a truck. */
  private drawTents(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number): void {
    const t = frame.tents;
    if (t.length === 0 || cam.mode === 'far') return;
    const outline = new Path2D(), ridges = new Path2D();
    for (let i = 0; i < t.length; i += TENT_STRIDE) {
      const x = t[i]!, y = t[i + 1]!, dx = t[i + 2]!, dy = t[i + 3]!, hl = t[i + 4]! / 2, hw = t[i + 5]! / 2;
      const nx = -dy, ny = dx;
      outline.moveTo(x + dx * hl + nx * hw, y + dy * hl + ny * hw);
      outline.lineTo(x - dx * hl + nx * hw, y - dy * hl + ny * hw);
      outline.lineTo(x - dx * hl - nx * hw, y - dy * hl - ny * hw);
      outline.lineTo(x + dx * hl - nx * hw, y + dy * hl - ny * hw);
      outline.closePath();
      ridges.moveTo(x + dx * hl, y + dy * hl);
      ridges.lineTo(x - dx * hl, y - dy * hl);
    }
    if (frame.tented > 0) {
      g.fillStyle = P.TENT_FILL;
      g.fill(outline);
    }
    g.strokeStyle = P.TENT;
    g.lineWidth = Math.max(1 / (cam.scale * dpr), 0.3);
    g.stroke(outline);
    g.stroke(ridges);
  }

  /**
   * DO NOT CROSS, painted across the road where the soldiers' warnings begin, underlined:
   * read by whoever comes up the road toward the barrier, the line nearest them.
   */
  private drawDoNotCross(g: CanvasRenderingContext2D, dx: number, dy: number, bx: number, by: number, width: number, px: number): void {
    const at = this.map.cordonWarn;
    const x = bx - dx * at, y = by - dy * at;
    const size = width * DNC_SIZE; // m: letter height, so the words span most of the road
    g.save();
    g.translate(x, y);
    // Upright for someone facing the barrier: the barrier is "up" the letters.
    g.rotate(Math.atan2(dy, dx) + Math.PI / 2);
    g.fillStyle = P.POLICE;
    g.strokeStyle = P.POLICE;
    g.font = `bold ${size}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillText('DO NOT CROSS', 0, 0);
    const w = Math.min(g.measureText('DO NOT CROSS').width, width - 2 * DNC_KERB);
    g.lineWidth = Math.max(px, size * 0.12);
    g.beginPath();
    g.moveTo(-w / 2, size * 0.35);
    g.lineTo(w / 2, size * 0.35);
    g.stroke();
    g.restore();
  }

  /** Squads: a thin line from each follower to its leader, so the unit reads as one. Near zoom. */
  private drawSquads(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number): void {
    const q = frame.squad;
    if (q.length === 0) return;
    const path = new Path2D();
    for (let i = 0; i < q.length; i += 2) {
      const a = this.simAt(q[i]!), b = this.simAt(q[i + 1]!);
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
    }
    g.strokeStyle = P.SQUAD;
    g.lineWidth = Math.max(1 / (cam.scale * dpr), 0.3);
    g.stroke(path);
  }

  private drawOrigin(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number, wallMs: number): void {
    if (this.origins.length === 0 || frame.tick >= ORIGIN_TICKS) return;
    const t = (wallMs % ORIGIN_PING_MS) / ORIGIN_PING_MS; // 0 wide, 1 settled
    // Many starting points: smaller pings, so the city shows between them.
    const n = this.origins.length;
    const size = n <= ORIGIN_FULL_UP_TO ? 1 : Math.max(ORIGIN_MIN_SCALE, Math.sqrt(ORIGIN_FULL_UP_TO / n));
    const r = (ORIGIN_R_MAX - (ORIGIN_R_MAX - ORIGIN_R_MIN) * t) * dpr * size;
    g.setTransform(1, 0, 0, 1, 0, 0);
    const [cr, cg, cb] = P.ZOMBIE_RGB;
    const colour = `rgba(${cr}, ${cg}, ${cb}, ${(0.35 + 0.6 * t).toFixed(3)})`;
    g.fillStyle = colour;
    // A ring round the symbol; the two shrink together.
    g.strokeStyle = colour;
    g.lineWidth = 2 * dpr;
    g.beginPath();
    for (const o of this.origins) {
      const x = cam.toScreenX(o.x) * dpr, y = cam.toScreenY(o.y) * dpr;
      g.moveTo(x + r * 1.35, y);
      g.arc(x, y, r * 1.35, 0, Math.PI * 2);
    }
    g.stroke();
    g.font = `${Math.round(r * 2)}px "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", "DejaVu Sans", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const o of this.origins) g.fillText('\u2623', cam.toScreenX(o.x) * dpr, cam.toScreenY(o.y) * dpr); // ☣
    g.textAlign = 'start';
  }

    /**
   * 911 calls, kept below the brightness of what they are about. A call going unanswered
   * (half its time gone and nobody sent) is a faint slow pulse at the building; when it
   * lapses it simply stops, which is the telling case. The moment officers are sent is the one bright
   * thing: a single ring flashing outward. While they are on their way, a dim ring closes
   * in on the building, again and again, until they arrive or give up.
   */
  private drawCalls(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number, wallMs: number): void {
    const view = this.viewBounds(cam);
    const waiting = new Path2D(), coming = new Path2D();
    let anyWaiting = false, anyComing = false;
    const minR = 10 / cam.scale; // at least 10 px across, so a call reads at far zoom
    const t = (wallMs % PING_MS) / PING_MS; // 0 wide, 1 gone
    const breath = 0.5 + 0.5 * Math.sin((wallMs / CALL_WAIT_MS) * Math.PI * 2);
    for (let i = 0; i < frame.buildingFlags.length; i++) {
      const f = frame.buildingFlags[i]!;
      if (!(f & (BUILDING_CALL | BUILDING_CALL_WAITING))) continue;
      const b = i * 4;
      const x0 = this.bounds[b]!, y0 = this.bounds[b + 1]!, x1 = this.bounds[b + 2]!, y1 = this.bounds[b + 3]!;
      if (x1 < view.x0 - 60 || x0 > view.x1 + 60 || y1 < view.y0 - 60 || y0 > view.y1 + 60) continue;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const base = Math.max(Math.hypot(x1 - x0, y1 - y0) / 2 + 6, minR);
      if (f & BUILDING_CALL) {
        const r = base * (1 - t * 0.85);
        coming.moveTo(cx + r, cy);
        coming.arc(cx, cy, r, 0, Math.PI * 2);
        anyComing = true;
      } else {
        waiting.moveTo(cx + base, cy);
        waiting.arc(cx, cy, base, 0, Math.PI * 2);
        anyWaiting = true;
      }
    }
    this.dispatches = this.dispatches.filter((d) => wallMs - d.start < DISPATCH_MS);
    cam.apply(g, dpr);
    const [r, gr, bl] = P.POLICE_RGB;
    if (anyWaiting) {
      g.strokeStyle = `rgba(${r}, ${gr}, ${bl}, ${(0.08 + 0.14 * breath).toFixed(3)})`;
      g.lineWidth = 1 / (cam.scale * dpr);
      g.stroke(waiting);
    }
    if (anyComing) {
      g.strokeStyle = `rgba(${r}, ${gr}, ${bl}, ${(0.15 + 0.3 * t).toFixed(3)})`; // brightening as it closes in
      g.lineWidth = 1.5 / (cam.scale * dpr);
      g.stroke(coming);
    }
    for (const d of this.dispatches) {
      const u = (wallMs - d.start) / DISPATCH_MS;
      const b = d.building * 4;
      const x0 = this.bounds[b]!, y0 = this.bounds[b + 1]!, x1 = this.bounds[b + 2]!, y1 = this.bounds[b + 3]!;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const rr = Math.max(Math.hypot(x1 - x0, y1 - y0) / 2 + 6, minR) + (25 + 12 / cam.scale) * u;
      const flash = new Path2D();
      flash.arc(cx, cy, rr, 0, Math.PI * 2);
      g.strokeStyle = `rgba(${r}, ${gr}, ${bl}, ${(0.9 * (1 - u)).toFixed(3)})`;
      g.lineWidth = 2 / (cam.scale * dpr);
      g.stroke(flash);
    }
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
  /**
   * One of the dead struck by a car, flying: a body thrown along the car's path, rising
   * and falling (drawn larger at the top of its arc, its shadow left on the ground), a
   * faint streak behind it. Wall time, so it reads at any playback speed. Mid and near zoom.
   */
  private drawThrown(g: CanvasRenderingContext2D, cam: Camera, dpr: number, wallMs: number): void {
    this.thrown = this.thrown.filter((f) => wallMs - f.start < THROWN_MS);
    if (this.thrown.length === 0 || cam.mode === 'far') return;
    cam.apply(g, dpr);
    const px = 1 / (cam.scale * dpr);
    const [r, gr, b] = P.ZOMBIE_RGB;
    for (const f of this.thrown) {
      const t = (wallMs - f.start) / THROWN_MS;
      const along = f.distance * (1 - (1 - t) ** 2); // fast off the bumper, slowing as it lands
      const lift = Math.sin(Math.PI * t); // up and down again
      const x = f.x + f.dx * along, y = f.y + f.dy * along;
      g.strokeStyle = `rgba(${r}, ${gr}, ${b}, ${(0.35 * (1 - t)).toFixed(3)})`;
      g.lineWidth = Math.max(px, 0.6);
      g.beginPath();
      g.moveTo(f.x, f.y);
      g.lineTo(x, y);
      g.stroke();
      g.fillStyle = `rgba(0, 0, 0, ${(0.4 * lift).toFixed(3)})`; // its shadow, under it
      g.beginPath();
      g.arc(x, y, Math.max(2 * px, 0.6), 0, Math.PI * 2);
      g.fill();
      g.fillStyle = P.ZOMBIE;
      g.beginPath();
      g.arc(x - f.dy * lift * 0.5, y + f.dx * lift * 0.5 - lift * THROWN_LIFT, Math.max(2 * px, 0.6) * (1 + lift), 0, Math.PI * 2);
      g.fill();
    }
  }

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

  /**
   * How well each door is held, at near zoom: a bar across the door step when
   * barricaded; a heavier outline as well when reinforced; and an inner outline too
   * when fortified.
   */
  private drawStages(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number): void {
    const view = this.viewBounds(cam);
    const o = this.map.outlines;
    const bars = new Path2D(), walls = new Path2D(), inner = new Path2D();
    let any = false;
    for (let i = 0; i < frame.buildingFlags.length; i++) {
      const stage = (frame.buildingFlags[i]! & BUILDING_STAGE_MASK) >> BUILDING_STAGE_SHIFT;
      if (stage === 0) continue;
      const b = i * 4;
      if (this.bounds[b + 2]! < view.x0 || this.bounds[b]! > view.x1 || this.bounds[b + 3]! < view.y0 || this.bounds[b + 1]! > view.y1) continue;
      any = true;
      const bar = this.doorBars.get(i) ?? [];
      for (let j = 0; j < bar.length; j += 4) {
        bars.moveTo(bar[j]!, bar[j + 1]!);
        bars.lineTo(bar[j + 2]!, bar[j + 3]!);
      }
      if (stage < 2) continue;
      this.addBuilding(walls, i);
      if (stage < 3 || this.map.buildingShape[i] !== 0) continue; // the inner wall is drawn for plain boxes only
      const k = i * 8;
      const cx = (o[k]! + o[k + 2]! + o[k + 4]! + o[k + 6]!) / 4, cy = (o[k + 1]! + o[k + 3]! + o[k + 5]! + o[k + 7]!) / 4;
      for (let c = 0; c < 4; c++) {
        const x = o[k + c * 2]!, y = o[k + c * 2 + 1]!;
        const d = Math.hypot(cx - x, cy - y) || 1;
        const t = Math.min(0.4, INSET / d);
        if (c === 0) inner.moveTo(x + (cx - x) * t, y + (cy - y) * t);
        else inner.lineTo(x + (cx - x) * t, y + (cy - y) * t);
      }
      inner.closePath();
    }
    if (!any) return;
    cam.apply(g, dpr);
    g.strokeStyle = P.HELD;
    g.lineWidth = 2.2 / (cam.scale * dpr);
    g.stroke(bars);
    g.lineWidth = 2 / (cam.scale * dpr);
    g.stroke(walls);
    g.lineWidth = 1 / (cam.scale * dpr);
    g.stroke(inner);
  }

  /** Faint fill tracking how many are inside; residents and occupiers look the same. A contested building has a faint red rim, barely breathing. */
  private drawOccupancy(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number, wallMs: number): void {
    const view = this.viewBounds(cam);
    const levels = Array.from({ length: FILL_LEVELS }, () => new Path2D());
    const contested = new Path2D();
    let anyContested = false;
    for (let i = 0; i < frame.fill.length; i++) {
      const n = frame.fill[i]!;
      if (n === 0) continue;
      const b = i * 4;
      if (this.bounds[b + 2]! < view.x0 || this.bounds[b]! > view.x1 || this.bounds[b + 3]! < view.y0 || this.bounds[b + 1]! > view.y1) continue;
      const level = Math.min(FILL_LEVELS - 1, Math.floor((Math.min(n, FULL_AT) / FULL_AT) * FILL_LEVELS));
      this.addBuilding(levels[level]!, i);
      if (frame.buildingFlags[i]! & BUILDING_CONTESTED) {
        this.addBuilding(contested, i);
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
      const pulse = 0.4 + 0.12 * Math.sin(wallMs / 400);
      const [cr, cg, cb] = P.CONTESTED;
      g.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${pulse.toFixed(3)})`;
      g.lineWidth = 2 / (cam.scale * dpr);
      g.stroke(contested);
    }
  }

  private drawAgents(g: CanvasRenderingContext2D, frame: FrameSnapshot, cam: Camera, dpr: number, wallMs: number): void {
    g.setTransform(1, 0, 0, 1, 0, 0);
    const size = Math.max(2.5, Math.min(6, cam.scale * 1.2)) * dpr;
    const half = size / 2;
    const w = this.canvas.width, h = this.canvas.height;
    const sx = (x: number) => cam.toScreenX(x) * dpr - half;
    const sy = (y: number) => cam.toScreenY(y) * dpr - half;

    // Zombies first, so the living are always on top.
    const zk = frame.zombieKind, zxy = this.interp.zombie;
    // Near zoom only, the viewer is told which of the dead turned from one bite and pass
    // for living at a distance.
    const intact = cam.mode === 'near' ? P.ZOMBIE_INTACT : P.ZOMBIE;
    for (const [kind, colour] of [[ZOMBIE_DORMANT, P.ZOMBIE_DORMANT], [ZOMBIE_AWAKE, P.ZOMBIE], [ZOMBIE_INTACT, intact]] as const) {
      g.fillStyle = colour;
      for (let i = 0; i < zk.length; i++) {
        if (zk[i] !== kind) continue;
        const x = sx(zxy[i * 2]!), y = sy(zxy[i * 2 + 1]!);
        if (x < -size || y < -size || x > w || y > h) continue;
        g.fillRect(x, y, size, size);
      }
    }
    const k = frame.simKind, f = frame.simFlags, xy = this.interp.sim;
    // Near zoom only, the viewer is told who is bitten; the city is not.
    const showInfected = cam.mode === 'near' ? this.infectedStyle : 'off';
    const pale = showInfected === 'fill';
    // Colour says who (police light blue, the National Guard pale green); shape says what they can do: anyone who can
    // shoot back is a triangle pointing the way they face.
    const colourOf = (i: number) => (pale && f[i]! & SIM_INFECTED ? P.INFECTED_PALE : f[i]! & SIM_POLICE ? P.POLICE : f[i]! & SIM_GUARD ? P.GUARD : P.LIVING);
    const hd = frame.simHeading;
    // A triangle about the area of a square, a little longer than wide so it points: it
    // says "can shoot back" without standing out from the dots around it.
    const r = Math.max(size * 0.85, 3 * dpr);
    const triangle = (path: Path2D, i: number, x: number, y: number, scale: number) => {
      const a = hd[i]!, cx = x + half, cy = y + half, rr = r * scale;
      path.moveTo(cx + Math.cos(a) * rr * 1.35, cy + Math.sin(a) * rr * 1.35);
      path.lineTo(cx + Math.cos(a + 2.4) * rr, cy + Math.sin(a + 2.4) * rr);
      path.lineTo(cx + Math.cos(a - 2.4) * rr, cy + Math.sin(a - 2.4) * rr);
      path.closePath();
    };
    // Freeze: a survivor cornered and keeping still is drawn dim, pulsing slowly — hiding
    // in plain sight, barely there.
    const frozenAlpha = 0.2 + 0.35 * (0.5 + 0.5 * Math.sin((wallMs / FREEZE_PULSE_MS) * Math.PI * 2));
    for (const frozen of [false, true]) {
      g.globalAlpha = frozen ? frozenAlpha : 1;
      for (const colour of [P.LIVING, P.POLICE, P.GUARD, P.INFECTED_PALE]) {
        g.fillStyle = colour;
        const armed = new Path2D();
        for (let i = 0; i < k.length; i++) {
          if (k[i] === SIM_HIDDEN || k[i] === SIM_PROMOTED || ((f[i]! & SIM_FROZEN) !== 0) !== frozen || colourOf(i) !== colour) continue;
          const x = sx(xy[i * 2]!), y = sy(xy[i * 2 + 1]!);
          if (x < -size * 2 || y < -size * 2 || x > w + size || y > h + size) continue;
          if (f[i]! & SIM_ARMED) triangle(armed, i, x, y, 1);
          else g.fillRect(x, y, size, size);
        }
        g.fill(armed);
      }
    }
    g.globalAlpha = 1;
    for (let i = 0; i < k.length; i++) {
      if (k[i] !== SIM_PROMOTED) continue;
      g.fillStyle = f[i]! & SIM_POLICE ? P.POLICE : f[i]! & SIM_GUARD ? P.GUARD : P.PROMOTED;
      const x = sx(xy[i * 2]!), y = sy(xy[i * 2 + 1]!);
      if (f[i]! & SIM_ARMED) {
        const p = new Path2D();
        triangle(p, i, x, y, 1.15);
        g.fill(p);
      } else g.fillRect(x - 1, y - 1, size + 2, size + 2);
    }
    // Fight: standing its ground, or has just struck or fired — a bright outline.
    const fighting = new Path2D();
    let anyFight = false;
    for (let i = 0; i < k.length; i++) {
      if (k[i] === SIM_HIDDEN || !(f[i]! & SIM_FIGHTING)) continue;
      const x = sx(xy[i * 2]!), y = sy(xy[i * 2 + 1]!);
      if (x < -size * 2 || y < -size * 2 || x > w + size || y > h + size) continue;
      const pad = 1.2 * dpr;
      // Traced just outside the shape, not as a bigger one round it.
      if (f[i]! & SIM_ARMED) triangle(fighting, i, x, y, k[i] === SIM_PROMOTED ? 1.4 : 1.25);
      else fighting.rect(x - pad, y - pad, size + pad * 2, size + pad * 2);
      anyFight = true;
    }
    if (anyFight) {
      g.strokeStyle = P.FIGHT;
      g.lineWidth = 0.9 * dpr;
      g.stroke(fighting);
    }
    if (showInfected === 'ring') {
      // The bitten pulse faster the nearer they are to turning: a slow, shallow breath a
      // turn delay away, frantic and deep in the last minute (period and depth on an
      // exponential, so the change shows). Motion means imminence: someone long from
      // turning is nearly a steady ring. Each keeps its own phase as its rate changes.
      const dt = this.lastPulseMs === 0 ? 0 : Math.min(200, wallMs - this.lastPulseMs);
      this.lastPulseMs = wallMs;
      if (this.turnPhase.length < k.length) {
        const grown = new Float32Array(k.length);
        grown.set(this.turnPhase);
        this.turnPhase = grown;
      }
      const levels = Array.from({ length: RING_LEVELS }, () => new Path2D());
      for (let i = 0; i < k.length; i++) {
        if (k[i] === SIM_HIDDEN || !(f[i]! & SIM_INFECTED)) continue;
        const left = Math.min(1, frame.simTurnIn[i]! / TURN_SLOW); // 1 a full delay away, 0 at the turn
        this.turnPhase[i] = (this.turnPhase[i]! + dt / (PULSE_FAST_MS * (PULSE_SLOW_MS / PULSE_FAST_MS) ** left)) % 1;
        const cx = sx(xy[i * 2]!) + half, cy = sy(xy[i * 2 + 1]!) + half;
        if (cx < -size * 3 || cy < -size * 3 || cx > w + size * 3 || cy > h + size * 3) continue;
        const depth = 0.9 * 0.06 ** left; // 0.9 at the turn, about 0.05 a full delay away
        const a = 1 - depth * (0.5 + 0.5 * Math.cos(this.turnPhase[i]! * Math.PI * 2));
        const r = size * (1.4 + 0.35 * depth * (0.5 - 0.5 * Math.cos(this.turnPhase[i]! * Math.PI * 2)));
        const p = levels[Math.min(RING_LEVELS - 1, Math.floor(a * RING_LEVELS))]!;
        p.moveTo(cx + r, cy);
        p.arc(cx, cy, r, 0, Math.PI * 2);
      }
      g.strokeStyle = P.INFECTED;
      g.lineWidth = 1.5 * dpr;
      levels.forEach((p, l) => {
        g.globalAlpha = (l + 1) / RING_LEVELS;
        g.stroke(p);
      });
      g.globalAlpha = 1;
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

