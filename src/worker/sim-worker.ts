// The simulation, off the main thread. Owns the World and the clock: it steps the
// simulation at the requested rate, in short slices so messages are handled
// between them, and answers each frame request with a snapshot. If it cannot keep
// up it drops the debt rather than spiralling: the run slows, it never skips ticks.
//
// Like the headless harness, this is a host for sim/; nothing in sim/ knows it is
// running here, or reads the clock.

import { config } from '../config';
import { daylight, timeOfDay } from '../sim/derived';
import { defaultScenario } from '../sim/scenario';
import { createWorld } from '../sim/setup';
import type { SimEvent, World } from '../sim/state';
import { stageOf } from '../sim/systems/common';
import { modeOf } from '../sim/systems/panic';

const STAGES = ['open', 'barricaded', 'reinforced', 'fortified'] as const;
import { step } from '../sim/tick';
import type { Context } from '../sim/context';
import {
  BUILDING_CALL,
  BUILDING_STAGE_SHIFT,
  BUILDING_CONTESTED,
  BUILDING_GARRISON,
  BUILDING_LIT,
  SIM_ARMED,
  SIM_FIGHTING,
  SIM_FLEEING,
  SIM_FROZEN,
  SIM_INFECTED,
  SIM_LIVING,
  SIM_POLICE,
  SIM_PROMOTED,
  ZOMBIE_AWAKE,
  ZOMBIE_DORMANT,
  type EventNote,
  type FrameSnapshot,
  type FromWorker,
  type MapSnapshot,
  type ToWorker,
} from './protocol';
import { inspect } from './inspect';
import { noteFor } from './notes';

const SLICE_MS = 10; // longest run of ticks between checks for messages
const EVENT_CAP = 4000; // events held for one frame; beyond this they are counted, not kept

const scope = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};

let world: World | null = null;
let ctx: Context | null = null;
let rate = 0; // ticks per second
let inspecting: { kind: 'sim' | 'building'; id: number } | null = null;
let anchor = 0; // wall time the current rate took effect
let steppedSinceAnchor = 0;
let pending: SimEvent[] = [];
let noises: FrameSnapshot['noises'] = [];
const NOISE_CAP = 400;
let notes: (EventNote | null)[] = [];
let dropped = 0;
const recent: number[] = []; // wall times of recent ticks, for the achieved rate

function collect(w: World, c: Context): void {
  for (const s of w.stimuli) {
    if (s.createdAt === w.tick && noises.length < NOISE_CAP) noises.push({ x: s.x, y: s.y, kind: s.kind, radius: s.radius });
  }
  for (const e of w.events) {
    if (pending.length < EVENT_CAP) {
      pending.push(e);
      notes.push(noteFor(w, c, e));
    } else dropped++;
  }
}

let origins: number[] = [];

function mapSnapshot(w: World): MapSnapshot {
  const streets = new Float32Array(w.streets.length * 5);
  const streetLit = new Uint8Array(w.streets.length);
  const streetBridge = new Uint8Array(w.streets.length);
  w.streets.forEach((s, i) => {
    const a = w.nodes[s.a]!, b = w.nodes[s.b]!;
    streets.set([a.x, a.y, b.x, b.y, s.width], i * 5);
    streetLit[i] = s.lit ? 1 : 0;
    streetBridge[i] = s.terrain === 'bridge' ? 1 : 0;
  });
  const outlines = new Float32Array(w.buildings.length * 8);
  w.buildings.forEach((b, i) => b.outline.forEach((p, j) => outlines.set([p.x, p.y], i * 8 + j * 2)));
  const buildingChurch = new Uint8Array(w.buildings.map((b) => (b.tag === 'church' ? 1 : 0)));
  // Each entrance with its wall's outward normal: the wall nearest it, facing away from the centre.
  const doors: number[] = [];
  for (const b of w.buildings) {
    const o = b.outline;
    const cx = o.reduce((a, p) => a + p.x, 0) / o.length, cy = o.reduce((a, p) => a + p.y, 0) / o.length;
    for (const e of b.entrances) {
      let best = 0, bestD = Infinity;
      for (let j = 0; j < o.length; j++) {
        const a = o[j]!, c = o[(j + 1) % o.length]!;
        const dx = c.x - a.x, dy = c.y - a.y;
        const t = Math.max(0, Math.min(1, ((e.x - a.x) * dx + (e.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(e.x - a.x - t * dx, e.y - a.y - t * dy);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      const a = o[best]!, c = o[(best + 1) % o.length]!;
      const len = Math.hypot(c.x - a.x, c.y - a.y) || 1;
      let nx = -(c.y - a.y) / len, ny = (c.x - a.x) / len;
      if (nx * (e.x - cx) + ny * (e.y - cy) < 0) [nx, ny] = [-nx, -ny];
      doors.push(b.id, e.x, e.y, nx, ny);
    }
  }
  return {
    size: w.config.map.size,
    streets,
    streetLit,
    streetBridge,
    outlines,
    buildingChurch,
    origins,
    doors: new Float32Array(doors),
    river: { centreline: w.river.centreline.map((p) => ({ x: p.x, y: p.y })), width: w.river.width },
    districts: w.districts.map((d) => ({ name: d.name, ...d.bounds })),
    streetNames: w.streets.map((s) => s.name),
  };
}

function frameSnapshot(w: World): FrameSnapshot {
  const simXY = new Float32Array(w.sims.length * 2);
  const simKind = new Uint8Array(w.sims.length);
  const simFlags = new Uint8Array(w.sims.length);
  const simHeading = new Float32Array(w.sims.length);
  for (const s of w.sims) {
    if ((s.condition !== 'healthy' && s.condition !== 'infected') || s.insideBuilding !== null) continue;
    simXY[s.id * 2] = s.x;
    simXY[s.id * 2 + 1] = s.y;
    simKind[s.id] = s.name !== null ? SIM_PROMOTED : SIM_LIVING;
    const gun = s.weapon;
    const shoots = (gun === 'pistol' || gun === 'smg' || gun === 'shotgun') && s.ammo >= w.config.combat.ranged[gun].ammoPerAttack;
    simFlags[s.id] =
      (s.condition === 'infected' ? SIM_INFECTED : 0) |
      (s.stand === 'freeze' ? SIM_FROZEN : 0) |
      (s.stand === 'fight' || s.nextAttackAt > w.tick ? SIM_FIGHTING : 0) |
      (s.avoidUntil !== null || (s.stand === null && modeOf(s, w.config) === 'flight') ? SIM_FLEEING : 0) |
      (shoots ? SIM_ARMED : 0) |
      (s.archetype === 'police' ? SIM_POLICE : 0);
    simHeading[s.id] = s.heading;
  }
  const zombieXY = new Float32Array(w.zombies.length * 2);
  const zombieKind = new Uint8Array(w.zombies.length);
  for (const z of w.zombies) {
    if (z.state === 'occupying' || z.state === 'destroyed') continue;
    zombieXY[z.id * 2] = z.x;
    zombieXY[z.id * 2 + 1] = z.y;
    zombieKind[z.id] = z.state === 'dormant' ? ZOMBIE_DORMANT : ZOMBIE_AWAKE;
  }
  const fill = new Uint16Array(w.buildings.length);
  const buildingFlags = new Uint8Array(w.buildings.length);
  for (const b of w.buildings) {
    fill[b.id] = Math.min(65535, b.residents + b.sheltered.length + b.zombiesInside);
    buildingFlags[b.id] =
      (b.zombiesInside > 0 && b.sheltered.length > 0 ? BUILDING_CONTESTED : 0) | (b.garrisonedAt !== null ? BUILDING_GARRISON : 0) | (b.lit ? BUILDING_LIT : 0) | (b.dispatchedAt !== null ? BUILDING_CALL : 0) | (STAGES.indexOf(stageOf(w, b)) << BUILDING_STAGE_SHIFT);
  }
  const tod = timeOfDay(w.tick, w.scenario, w.config);
  const now = performance.now();
  while (recent.length > 0 && now - recent[0]! > 1000) recent.shift();
  const frame: FrameSnapshot = {
    tick: w.tick,
    daylight: daylight(tod, w.config),
    hour: tod * 24,
    simXY,
    simKind,
    simFlags,
    simHeading,
    zombieXY,
    zombieKind,
    fill,
    buildingFlags,
    counters: structuredClone(w.counters),
    roster: w.roster.map((id) => {
      const s = w.sims[id]!;
      return { id, name: s.name!, living: s.condition === 'healthy' || s.condition === 'infected' };
    }),
    events: pending,
    notes,
    eventsDropped: dropped,
    achievedRate: recent.length,
    inspected: inspecting ? inspect(w, inspecting) : null,
    noises,
  };
  noises = [];
  pending = [];
  notes = [];
  dropped = 0;
  return frame;
}

function run(): void {
  if (world && ctx && rate > 0 && world.tick < world.config.time.runLength) {
    const start = performance.now();
    const due = Math.floor(((start - anchor) / 1000) * rate) - steppedSinceAnchor;
    // More than a quarter second behind: this machine cannot hold the rate. Let the
    // debt go rather than bursting to catch up.
    if (due > rate / 4) {
      anchor = start;
      steppedSinceAnchor = 0;
    }
    for (let i = 0; i < due && performance.now() - start < SLICE_MS && world.tick < world.config.time.runLength; i++) {
      step(world, ctx, { checkInvariant: false });
      steppedSinceAnchor++;
      recent.push(performance.now());
      collect(world, ctx);
    }
  }
  // Yield between slices so messages are handled. With ticks still due, yield by a
  // message to ourselves: a zero timeout is clamped to 4 ms once nested, which would
  // idle the worker a third of the time at full speed. Ahead of schedule, sleep until
  // the next tick is due rather than spin.
  if (rate > 0 && world && world.tick < world.config.time.runLength) {
    const nextDue = anchor + ((steppedSinceAnchor + 1) / rate) * 1000;
    const wait = nextDue - performance.now();
    if (wait <= 0) yieldChannel.port2.postMessage(null);
    else setTimeout(run, Math.min(wait, 50));
  } else {
    setTimeout(run, 16);
  }
}

const yieldChannel = new MessageChannel();
yieldChannel.port1.onmessage = () => run();

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'start') {
    const made = createWorld({ ...defaultScenario, runSeed: msg.runSeed, mapSeed: msg.mapSeed }, config);
    world = made.world;
    ctx = made.ctx;
    // Patient zero's building, noted before anything moves: the view opens there.
    origins = world.buildings.filter((b) => b.zombiesInside > 0).map((b) => b.id);
    while (world.tick < msg.advance) {
      step(world, ctx, { checkInvariant: false });
      // Deaths while fast-forwarding still belong on the corpse layer.
      for (const e of world.events) {
        if (e.type !== 'simDied' && e.type !== 'zombieDestroyed') continue;
        pending.push(e);
        notes.push(null); // history, not news
      }
    }
    const map = mapSnapshot(world);
    scope.postMessage({ type: 'map', map }, [map.streets.buffer, map.streetLit.buffer, map.streetBridge.buffer, map.outlines.buffer, map.buildingChurch.buffer, map.doors.buffer]);
  } else if (msg.type === 'rate') {
    rate = msg.ticksPerSecond;
    anchor = performance.now();
    steppedSinceAnchor = 0;
  } else if (msg.type === 'inspect') {
    inspecting = msg.target;
  } else if (msg.type === 'frame' && world) {
    const f = frameSnapshot(world);
    scope.postMessage({ type: 'frame', frame: f }, [f.simXY.buffer, f.simKind.buffer, f.simFlags.buffer, f.simHeading.buffer, f.zombieXY.buffer, f.zombieKind.buffer, f.fill.buffer, f.buildingFlags.buffer]);
  }
};

run();
