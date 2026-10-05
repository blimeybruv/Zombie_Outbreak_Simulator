// The viewer: starts the simulation worker, draws its snapshots, and wires the
// camera and time controls. The page never holds simulation state, only the most
// recent snapshot of it.

import { config } from './config';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import { Controls } from './ui/controls';
import { Roster } from './ui/roster';
import { Ticker } from './ui/ticker';
import type { EventNote, FrameSnapshot, FromWorker, ToWorker } from './worker/protocol';

const params = new URLSearchParams(location.search);
const runSeed = Number(params.get('run') ?? 1);
const mapSeed = Number(params.get('map') ?? 1);
const advance = Number(params.get('advance') ?? 0);

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const worker = new Worker(new URL('./worker/sim-worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker) => worker.postMessage(m);

const camera = new Camera(config.map.size / 2, config.map.size / 2, 0.5);
let renderer: Renderer | null = null;
let latest: FrameSnapshot | null = null;
let awaiting = false;
/** The sim the camera follows, if any: set from the roster or a ticker line, cleared by dragging. */
let tracked: number | null = null;

const controls = new Controls(document.querySelector<HTMLElement>('#controls')!, {
  speeds: config.playback.speeds,
  ticksPerSecondAt1x: config.playback.ticksPerSecondAt1x,
  onRate: (ticksPerSecond) => send({ type: 'rate', ticksPerSecond }),
});

function track(simId: number): void {
  tracked = simId;
  if (camera.scale < 0.8) {
    camera.scale = 1.2;
    camera.version++;
  }
}

const ticker = new Ticker(document.querySelector<HTMLElement>('#ticker')!, {
  inView: (x, y) => {
    const a = camera.toWorld(0, 0), b = camera.toWorld(camera.width, camera.height);
    return x >= a.x && x <= b.x && y >= a.y && y <= b.y;
  },
  onSelect: (note: EventNote) => {
    if (note.sim !== null) track(note.sim);
    else tracked = null;
    camera.centreOn(note.x, note.y);
  },
  onMajor: () => controls.dropToNormal(),
});
const roster = new Roster(document.querySelector<HTMLElement>('#roster')!, track);

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const msg = e.data;
  if (msg.type === 'map') {
    renderer = new Renderer(canvas, msg.map);
  } else {
    latest = msg.frame;
    stats.tick = latest.tick;
    const now = performance.now();
    renderer?.ingest(latest, now);
    ticker.take(latest.events, latest.notes, controls.currentSpeed, now);
    roster.show(latest, tracked);
    awaiting = false;
    controls.show(latest);
  }
};
send({ type: 'start', runSeed, mapSeed, advance });

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  camera.resize(canvas.clientWidth, canvas.clientHeight);
}
window.addEventListener('resize', resize);
resize();

// Free camera: drag to pan, wheel to zoom about the cursor.
let drag: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY };
  tracked = null;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  camera.panBy(e.clientX - drag.x, e.clientY - drag.y);
  drag = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', () => (drag = null));
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    camera.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  },
  { passive: false },
);

// Frame timing and the camera, for scripts that screenshot the view or measure the
// renderer gate (scripts/view.ts). Read-only as far as the simulation is concerned.
const stats = { frames: 0, drawMs: 0, since: performance.now(), tick: 0 };
/** Centres on the 50 m cell with the most agents in it, living or dead. */
function centreOnBusiest(): void {
  if (!latest) return;
  const cell = 50;
  const cols = Math.ceil(config.map.size / cell);
  const counts = new Uint16Array(cols * cols);
  const add = (xy: Float32Array, kinds: Uint8Array) => {
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] === 0) continue;
      const cx = Math.min(cols - 1, Math.floor(xy[i * 2]! / cell)), cy = Math.min(cols - 1, Math.floor(xy[i * 2 + 1]! / cell));
      counts[cy * cols + cx]!++;
    }
  };
  add(latest.simXY, latest.simKind);
  add(latest.zombieXY, latest.zombieKind);
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i]! > counts[best]!) best = i;
  camera.centreOn(((best % cols) + 0.5) * cell, (Math.floor(best / cols) + 0.5) * cell);
}
(window as unknown as { __view: unknown }).__view = { stats, camera, controls, ticker, centreOnBusiest, ready: () => latest !== null };

function frame(now: number): void {
  if (!awaiting) {
    awaiting = true;
    send({ type: 'frame' });
  }
  if (renderer && latest) {
    // Follow the tracked sim while it is on the map; indoors, the camera waits at the door.
    if (tracked !== null && latest.simKind[tracked]) camera.centreOn(latest.simXY[tracked * 2]!, latest.simXY[tracked * 2 + 1]!);
    const t0 = performance.now();
    renderer.draw(latest, camera, window.devicePixelRatio || 1, now);
    stats.drawMs += performance.now() - t0;
    stats.frames++;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
