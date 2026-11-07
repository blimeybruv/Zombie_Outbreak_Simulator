// The viewer: starts the simulation worker, draws its snapshots, and wires the
// camera and time controls. The page never holds simulation state, only the most
// recent snapshot of it.

import { Audio } from './audio/audio';
import { config } from './config';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import { line } from './ui/copy';
import { Controls } from './ui/controls';
import { FrameCounter } from './ui/frame-counter';
import { EndScreen } from './ui/end';
import { Inspector } from './ui/inspector';
import { Roster } from './ui/roster';
import { addressFor, settingsFrom, showSetup } from './ui/setup';
import { Ticker } from './ui/ticker';
import { Director } from './ui/director';
import { FrameTiming } from './ui/frame-timing';
import type { EventNote, FrameSnapshot, FromWorker, ToWorker } from './worker/protocol';

const params = new URLSearchParams(location.search);
// Without `start` in the address, the setup screen first (ui/setup.ts); Start reloads with it.
const starting = params.has('start');
if (!starting) showSetup(document.querySelector<HTMLElement>('#setup')!, params);
const settings = settingsFrom(params);
const { runSeed, mapSeed } = settings;
const advance = Number(params.get('advance') ?? 0);
const newRun = document.querySelector<HTMLButtonElement>('#newrun')!;
newRun.hidden = !starting;
document.querySelector<HTMLElement>('#controls')!.hidden = !starting;
newRun.addEventListener('click', () => (location.href = addressFor(settings, false, params)));
// The director (ui/director.ts): the camera goes to scenes on its own until the viewer takes it back.
const director = new Director();
// Where each frame's time goes (ui/frame-timing.ts), for scripts/frame-check.ts.
const timing = new FrameTiming();
const directorButton = document.querySelector<HTMLButtonElement>('#director')!;
directorButton.hidden = !starting;
function direct(on: boolean): void {
  director.enable(on);
  directorButton.classList.toggle('on', on);
  if (on) tracked = null;
}
directorButton.addEventListener('click', () => direct(!director.enabled));

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const worker = new Worker(new URL('./worker/sim-worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker) => worker.postMessage(m);

const camera = new Camera(config.map.size / 2, config.map.size / 2, 0.5);
let renderer: Renderer | null = null;
const audio = new Audio();
// Browsers allow sound only after the viewer interacts.
for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, () => audio.start(), { once: true });
window.addEventListener('keydown', (e) => {
  if (e.key === 'm' || e.key === 'M') audio.toggleMute();
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const layer = e.key === 'c' || e.key === 'C' ? 'city' : e.key === 'o' || e.key === 'O' ? 'outbreak' : e.key === 'k' || e.key === 'K' ? 'cordon' : e.key === 'r' || e.key === 'R' ? 'army' : null;
  if (layer) audio.setLayerEnabled(layer, !audio.layerEnabled(layer));
  if (e.key === 'd' || e.key === 'D') direct(!director.enabled);
});
let latest: FrameSnapshot | null = null;
/** Ticks per second now requested (0 paused): how long the ticks between two snapshots take. */
let rate = 0;
let awaiting = false;
/** The sim the camera follows, if any: set from the roster or a ticker line, cleared by dragging. */
let tracked: number | null = null;
/** What the inspector shows, if anything. */
let selected: { kind: 'sim' | 'building'; id: number } | null = null;
/** Each building's own history, as ticker copy, so the inspector can show its past. */
const buildingHistory = new Map<number, string[]>();

function select(target: typeof selected): void {
  selected = target;
  send({ type: 'inspect', target });
}

const controls = new Controls(document.querySelector<HTMLElement>('#controls')!, {
  speeds: config.playback.speeds,
  ticksPerSecondAt1x: config.playback.ticksPerSecondAt1x,
  onRate: (ticksPerSecond) => {
    rate = ticksPerSecond;
    send({ type: 'rate', ticksPerSecond });
  },
});

function track(simId: number): void {
  direct(false);
  tracked = simId;
  select({ kind: 'sim', id: simId });
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
    direct(false);
    if (note.sim !== null) track(note.sim);
    else tracked = null;
    camera.centreOn(note.x, note.y);
  },
  onMajor: () => controls.dropToNormal(),
});
const roster = new Roster(document.querySelector<HTMLElement>('#roster')!, track);
const inspector = new Inspector(document.querySelector<HTMLElement>('#inspector')!, track);
const endScreen = new EndScreen(document.querySelector<HTMLElement>('#end')!);
const fallCaption = document.querySelector<HTMLElement>('#fall')!;

/** While a fallen city falls (sim/fall.ts): the city falling in time-lapse, and when the viewer takes over. */
function showFall(f: FrameSnapshot): void {
  fallCaption.hidden = !f.falling;
  if (!f.falling) return;
  const m = Math.floor(f.sinceOutbreak / 60);
  const since = `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  fallCaption.replaceChildren();
  const head = document.createElement('div');
  head.textContent = `The city is falling. ${since} since the outbreak; ${f.livingInCity.toLocaleString('en-US')} still alive.`;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `You take over when ${settings.survivors} are left.`;
  fallCaption.append(head, sub);
}

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const msg = e.data;
  if (msg.type === 'map') {
    renderer = new Renderer(canvas, msg.map);
    audio.setExits(msg.map.exits);
    // Open on where it began: the first building the dead started in, close enough to see the street.
    // Or on `at=x,y` in the address, close in (the oddity check's links, scripts/oddities.ts).
    const at = params.get('at')?.split(',').map(Number);
    const origin = at !== undefined && at.length === 2 && at.every(Number.isFinite) ? { x: at[0]!, y: at[1]! } : msg.map.origins[0];
    if (settings.start === 'fallen' && at === undefined) {
      // A fallen city: the whole of it, to watch it fall.
      camera.scale = (0.95 * Math.min(camera.width, camera.height)) / msg.map.size;
      camera.centreOn(msg.map.size / 2, msg.map.size / 2);
      camera.version++;
    } else if (origin !== undefined) {
      camera.scale = at !== undefined ? 4 : 1;
      camera.centreOn(origin.x, origin.y);
      camera.version++;
    }
    const infected = params.get('infected');
    if (infected === 'ring' || infected === 'fill' || infected === 'off') renderer.infectedStyle = infected;
  } else if (msg.type === 'ended') {
    endScreen.show(msg.end);
  } else {
    const f = msg.frame;
    latest = f;
    showFall(f);
    stats.tick = f.tick;
    timing.snapshot(f.perf);
    const now = performance.now();
    timing.time('ingest', () => renderer?.ingest(f, now));
    timing.time('ticker', () => ticker.take(f.events, f.notes, controls.currentSpeed, now));
    timing.time('offers', () => director.offer(f.events, f.notes, f.tick));
    timing.time('history', () =>
      f.events.forEach((ev, i) => {
        const n = f.notes[i];
        if (!n || n.building === null) return;
        const text = line(ev, n);
        if (text === null) return;
        const h = buildingHistory.get(n.building) ?? [];
        h.push(text);
        if (h.length > 20) h.shift();
        buildingHistory.set(n.building, h);
      }),
    );
    timing.time('panels', () => {
      inspector.show(f.inspected, f.inspected?.kind === 'building' ? (buildingHistory.get(f.inspected.id) ?? []) : []);
      roster.show(f, tracked);
      controls.show(f);
    });
    awaiting = false;
    timing.time('audio', () => audio.update(f, camera, controls.currentSpeed));
  }
};
if (starting) send({ type: 'start', runSeed, mapSeed, advance, settings });

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
let pressedAt: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY };
  pressedAt = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (pressedAt && Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) > 4) {
    tracked = null; // a drag lets go
    direct(false); // and takes the camera back from the director
  }
  camera.panBy(e.clientX - drag.x, e.clientY - drag.y);
  drag = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  drag = null;
  const click = pressedAt && Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) <= 4;
  pressedAt = null;
  if (click) pick(e.clientX - canvas.getBoundingClientRect().left, e.clientY - canvas.getBoundingClientRect().top);
});

/** A click inspects: the nearest person within a few pixels, else the building underneath, else nothing. Not at far zoom. */
function pick(sx: number, sy: number): void {
  if (!latest || !renderer || camera.mode === 'far') return;
  const w = camera.toWorld(sx, sy);
  const reach = 8 / camera.scale;
  let best = -1;
  let bestD = reach;
  for (let i = 0; i < latest.simKind.length; i++) {
    if (!latest.simKind[i]) continue;
    const d = Math.hypot(latest.simXY[i * 2]! - w.x, latest.simXY[i * 2 + 1]! - w.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best >= 0) return track(best);
  const b = renderer.buildingAt(w.x, w.y);
  tracked = null;
  if (b === null) return select(null);
  select({ kind: 'building', id: b });
  const c = renderer.buildingCentre(b);
  camera.centreOn(c.x, c.y);
}
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
/** Centres on the first survivor outdoors carrying any of `flags` (protocol SIM_*); false if none. */
function centreOnFlagged(flags: number): boolean {
  if (!latest) return false;
  for (let i = 0; i < latest.simFlags.length; i++) {
    if (!latest.simKind[i] || !(latest.simFlags[i]! & flags)) continue;
    camera.centreOn(latest.simXY[i * 2]!, latest.simXY[i * 2 + 1]!);
    return true;
  }
  return false;
}
(window as unknown as { __view: unknown }).__view = {
  stats,
  camera,
  controls,
  ticker,
  centreOnBusiest,
  centreOnFlagged,
  director: { enable: direct, focus: () => director.focus() },
  timing,
  ready: () => latest !== null,
};

const frameCounter = new FrameCounter(document.querySelector<HTMLElement>('#fps')!, import.meta.env.DEV || params.has('fps'));

function frame(now: number): void {
  timing.frame(now, latest ? latest.simKind.reduce((a, k) => a + (k ? 1 : 0), 0) + latest.zombieKind.reduce((a, k) => a + (k === 1 ? 1 : 0), 0) : 0);
  if (!awaiting) {
    awaiting = true;
    send({ type: 'frame' });
  }
  let drawMs = 0;
  if (renderer && latest) {
    const f = latest;
    timing.time('advance', () => renderer!.advance(f, now, rate));
    // The director's scene, eased to, close in.
    const to = timing.time('director', () => director.update(f));
    if (to !== null) {
      const dc = config.director;
      camera.centreOn(camera.x + (to.x - camera.x) * dc.ease, camera.y + (to.y - camera.y) * dc.ease);
      // In at once, not eased: every change of scale redraws the whole static city (35 ms
      // a frame, eased every frame, in the frame check); a pan only shifts it.
      if (camera.scale !== dc.scale) camera.scale = dc.scale;
      camera.version++;
    }
    // Follow the tracked sim while it is on the map; indoors, the camera waits at the door.
    else if (tracked !== null && latest.simKind[tracked]) {
      const p = renderer.simAt(tracked);
      camera.centreOn(p.x, p.y);
    }
    const t0 = performance.now();
    timing.time('draw', () => renderer!.draw(f, camera, window.devicePixelRatio || 1, now));
    timing.drew(renderer.layerMs);
    timing.time('selection', () => renderer!.drawSelection(selected, f, camera, window.devicePixelRatio || 1));
    drawMs = performance.now() - t0;
    stats.drawMs += drawMs;
    stats.frames++;
  }
  timing.time('counter', () => frameCounter.tick(now, drawMs, latest, controls.currentSpeed * config.playback.ticksPerSecondAt1x));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
