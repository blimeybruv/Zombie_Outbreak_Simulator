// Sound: a readout of the simulation, not a layer beside it. Weapon noise in the
// snapshot is the same stimulus that draws the dead, so the shot you hear is the
// one the horde heard.
//
// Web Audio throughout, all of it synthesised into AudioBuffers once at start: no
// assets. Two kinds of sound:
//
//   one-shots  each noise in the snapshot (shots, blows, shouts; car alarms once the
//              simulation makes them) is a throwaway source through its own chain:
//              distance (quieter, duller and later the farther it is from the middle
//              of the view), a stereo panner, a category gain — and, for gunfire, a
//              send to one shared street echo. Heard out to the noise's own radius,
//              how far the dead hear it, so a fight just off screen is heard too.
//   beds       loops whose levels follow what is in view: the dead (a moan), cars
//              being driven (engines), police cars, SWAT vans and ambulances on the
//              move (a siren), and the city itself (wind always; the hum of a living
//              city thinning as it empties; crickets after dark).
//
// The funnel is the work: loudest first, a few per frame, voice caps per category,
// thinner above 4× and only the loudest at 8×. No per-zombie sounds.
//
// The listener stands at the middle of the view, raised with the zoom: zoomed out,
// everything is farther away, so the city sounds distant from above and close at
// street level.
//
// Browsers block audio until the viewer interacts; `start` is called on the first
// click or key, and the scenario starts paused anyway.

import type { Camera } from '../render/camera';
import type { FrameSnapshot } from '../worker/protocol';
import { CAR_AMBULANCE, CAR_CRUISER, CAR_DRIVING, CAR_STATE_MASK, CAR_VAN, ZOMBIE_AWAKE, ZOMBIE_INTACT } from '../worker/protocol';

type Category = 'gun' | 'melee' | 'voice' | 'alarm';
type Bed = 'moan' | 'engine' | 'siren' | 'wind' | 'hum' | 'night';
const VOICES: Record<Category, number> = { gun: 8, melee: 4, voice: 3, alarm: 2 };
const PER_FRAME = { normal: 4, thin: 2, loudestOnly: 1 };
const JITTER = 0.12; // ± half this, in playback rate, so identical shots do not sound synthetic

const CATEGORY: Record<string, Category | undefined> = {
  pistol: 'gun',
  smg: 'gun',
  shotgun: 'gun',
  rifle: 'gun',
  club: 'melee',
  sledgehammer: 'melee',
  shout: 'voice',
  // Groundwork: a car alarm, played as soon as the simulation makes the noise (reference, "Sound").
  alarm: 'alarm',
};

// Distance. Metres from the listener: the listener's height is this share of the view's
// width, so a city-wide view hears everything from far off.
const HEIGHT_SHARE = 0.18;
const SOUND_SPEED = 343; // m/s: a far shot arrives late
const MAX_DELAY = 1.2; // s
const NEAR = 40; // m: full level within this
const DULL = 450; // m: the high end falls away by e every this far
const ECHO_NEAR = 0.12; // street echo sent at close range …
const ECHO_FAR = 0.45; // … and far off, where it is most of what arrives

const rnd = () => Math.random() * 2 - 1;

/** Scales a buffer to a given peak, so levels are set by the gains alone and nothing clips. */
function normalise(buf: AudioBuffer, peak = 0.9): AudioBuffer {
  let max = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) for (const v of buf.getChannelData(ch)) max = Math.max(max, Math.abs(v));
  if (max === 0) return buf;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i]! *= peak / max;
  }
  return buf;
}

/** A short call: noise band-passed into the range of a raised voice, rising then falling. */
function shout(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 0.45;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  // Two-pole resonator around a pitch that glides 520 → 760 → 600 Hz.
  let y1 = 0, y2 = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    const f = t < 0.15 ? 520 + (240 * t) / 0.15 : 760 - (160 * (t - 0.15)) / 0.3;
    const r = 0.985;
    const c = 2 * r * Math.cos((2 * Math.PI * f) / rate);
    const y = rnd() * 0.05 + c * y1 - r * r * y2;
    y2 = y1;
    y1 = y;
    const env = Math.min(1, t / 0.04) * Math.exp(-Math.max(0, t - 0.2) / 0.08);
    d[i] = y * env * 0.6;
  }
  return buf;
}

/** Noise shaped by an envelope and a one-pole low-pass; enough for a thud. */
function burst(ctx: AudioContext, seconds: number, decay: number, cutoff: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  const a = Math.exp((-2 * Math.PI * cutoff) / rate);
  let y = 0;
  for (let i = 0; i < d.length; i++) {
    y = (1 - a) * rnd() + a * y;
    d[i] = y * Math.exp(-i / rate / decay) * 3;
  }
  return buf;
}

interface Shot {
  /** Body: filtered noise, its decay (s) and cutoff (Hz). */
  decay: number;
  cutoff: number;
  /** The low thump under it (Hz, level). */
  thump: number;
  thumpLevel: number;
  /** The tail: a long, dull rumble (s, level). */
  tail: number;
  tailLevel: number;
  /** Rounds per burst, and the gap between them (s). */
  rounds: number;
  gap: number;
}

const SHOTS: Record<string, Shot> = {
  pistol: { decay: 0.045, cutoff: 2600, thump: 110, thumpLevel: 0.35, tail: 0.35, tailLevel: 0.12, rounds: 1, gap: 0 },
  rifle: { decay: 0.06, cutoff: 3400, thump: 80, thumpLevel: 0.5, tail: 0.6, tailLevel: 0.2, rounds: 1, gap: 0 },
  shotgun: { decay: 0.1, cutoff: 1300, thump: 55, thumpLevel: 0.9, tail: 0.7, tailLevel: 0.25, rounds: 1, gap: 0 },
  smg: { decay: 0.03, cutoff: 3000, thump: 120, thumpLevel: 0.3, tail: 0.3, tailLevel: 0.1, rounds: 3, gap: 0.07 },
};

/** A gunshot in three layers: a crack (a couple of milliseconds of everything), a body and a thump, and a dull tail. */
function gunshot(ctx: AudioContext, s: Shot): AudioBuffer {
  const rate = ctx.sampleRate;
  const one = Math.max(s.tail, s.decay * 6);
  const buf = ctx.createBuffer(1, Math.ceil(rate * (one + s.gap * (s.rounds - 1))), rate);
  const d = buf.getChannelData(0);
  const body = Math.exp((-2 * Math.PI * s.cutoff) / rate);
  const dull = Math.exp((-2 * Math.PI * 350) / rate);
  for (let r = 0; r < s.rounds; r++) {
    const start = Math.floor(r * s.gap * rate);
    let yb = 0, yt = 0;
    for (let i = 0; start + i < d.length && i < one * rate; i++) {
      const t = i / rate;
      const crack = t < 0.0025 ? rnd() * (1 - t / 0.0025) * 1.4 : 0;
      yb = (1 - body) * rnd() + body * yb;
      yt = (1 - dull) * rnd() + dull * yt;
      const thump = Math.sin(2 * Math.PI * s.thump * t * (1 - t * 2)) * Math.exp(-t / (s.decay * 1.5)) * s.thumpLevel;
      const tail = yt * Math.min(1, t / 0.02) * Math.exp(-t / (s.tail / 3)) * s.tailLevel * 4;
      d[start + i]! += crack + yb * Math.exp(-t / s.decay) * 3 + thump + tail;
    }
  }
  return buf;
}

/**
 * The street's echo: a stereo impulse response — a few early reflections off the
 * buildings either side (15–70 ms), then a diffuse tail a second and a half long.
 */
function streetEcho(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 1.6;
  const buf = ctx.createBuffer(2, Math.ceil(rate * seconds), rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (const [ms, g] of [[15, 0.6], [27, 0.45], [41, 0.35], [58, 0.3], [70, 0.22]] as const) {
      const at = Math.floor(((ms + (ch === 0 ? 0 : 6)) / 1000) * rate);
      d[at] = g * (ch === 0 ? 1 : -1);
    }
    for (let i = Math.floor(0.08 * rate); i < d.length; i++) d[i]! += rnd() * 0.18 * Math.exp(-(i / rate - 0.08) / 0.38);
  }
  return buf;
}

/** The dead as a crowd: low voices, each a buzz at its own drifting pitch through two vowel resonances, rising and falling out of step. */
function moan(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 8;
  const buf = ctx.createBuffer(1, rate * seconds, rate);
  const d = buf.getChannelData(0);
  for (let v = 0; v < 7; v++) {
    const pitch = 70 + Math.random() * 60;
    const drift = 0.04 + Math.random() * 0.06;
    const phase0 = Math.random() * seconds;
    const swells = 1 + Math.floor(Math.random() * 2); // whole cycles per loop, so it loops cleanly
    const formants = [[420 + Math.random() * 200, 0.97], [800 + Math.random() * 300, 0.95]] as const;
    const st = formants.map(() => ({ y1: 0, y2: 0 }));
    let ph = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / rate;
      const f = pitch * (1 + drift * Math.sin((2 * Math.PI * (t + phase0)) / seconds));
      ph += f / rate;
      const glottal = (ph % 1) * 2 - 1 + rnd() * 0.3; // a rough buzz
      let out = 0;
      formants.forEach(([ff, r], k) => {
        const c = 2 * r * Math.cos((2 * Math.PI * ff) / rate);
        const y = glottal * (1 - r) + c * st[k]!.y1 - r * r * st[k]!.y2;
        st[k]!.y2 = st[k]!.y1;
        st[k]!.y1 = y;
        out += y;
      });
      const env = Math.max(0, Math.sin((2 * Math.PI * swells * (t + phase0)) / seconds)) ** 2;
      d[i]! += out * env * 0.5;
    }
  }
  return buf;
}

/** Brown noise through a slow swell: wind between the buildings. */
function wind(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 10;
  const buf = ctx.createBuffer(1, rate * seconds, rate);
  const d = buf.getChannelData(0);
  let y = 0;
  for (let i = 0; i < d.length; i++) {
    y = 0.997 * y + 0.03 * rnd();
    const t = i / rate;
    const gust = 0.5 + 0.3 * Math.sin((2 * Math.PI * t) / seconds) + 0.2 * Math.sin((2 * Math.PI * 3 * t) / seconds);
    d[i] = y * gust * 2;
  }
  return buf;
}

/** The low, even murmur of a city going about its day: traffic and people, far off. */
function hum(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 6;
  const buf = ctx.createBuffer(1, rate * seconds, rate);
  const d = buf.getChannelData(0);
  const a = Math.exp((-2 * Math.PI * 220) / rate);
  let y = 0;
  for (let i = 0; i < d.length; i++) {
    y = (1 - a) * rnd() + a * y;
    d[i] = y * 3;
  }
  return buf;
}

/** Crickets: short trains of high chirps, a few insects out of step. */
function crickets(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 4;
  const buf = ctx.createBuffer(1, rate * seconds, rate);
  const d = buf.getChannelData(0);
  for (let k = 0; k < 4; k++) {
    const f = 4200 + Math.random() * 900;
    const period = 0.5 + Math.random() * 0.4;
    const offset = Math.random() * period;
    const level = 0.03 + Math.random() * 0.03;
    for (let i = 0; i < d.length; i++) {
      const t = i / rate;
      const p = ((t + offset) % period) / period;
      if (p > 0.18) continue;
      const pulse = Math.sin(Math.PI * ((p * 3 * 0.18 * 10) % 1)); // three pulses in a chirp
      d[i]! += Math.sin(2 * Math.PI * f * t) * pulse * level;
    }
  }
  return buf;
}

/** Engines: a rough low rumble with its harmonics, idling to driving. */
function engine(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 2;
  const buf = ctx.createBuffer(1, rate * seconds, rate);
  const d = buf.getChannelData(0);
  const a = Math.exp((-2 * Math.PI * 180) / rate);
  let y = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    y = (1 - a) * rnd() + a * y;
    const f = 42; // whole cycles in two seconds, so it loops cleanly
    d[i] = (Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * 2 * f * t) * 0.25 + y * 2) * 0.6;
  }
  return buf;
}

/** A siren's wail: a tone sweeping up and down, with a little of its odd harmonics. */
function siren(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 4;
  const buf = ctx.createBuffer(1, rate * seconds, rate);
  const d = buf.getChannelData(0);
  let ph = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    const f = 950 + 380 * Math.sin((2 * Math.PI * t) / seconds - Math.PI / 2);
    ph += f / rate;
    const s = Math.sin(2 * Math.PI * ph);
    d[i] = (s + Math.sin(6 * Math.PI * ph) * 0.2) * 0.35;
  }
  return buf;
}

/** A car alarm: two tones taking turns, square-edged, a second and a half of it. */
function alarm(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 1.6;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  let ph = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    const f = Math.floor(t / 0.2) % 2 === 0 ? 1450 : 1050;
    ph += f / rate;
    const sq = Math.tanh(Math.sin(2 * Math.PI * ph) * 4);
    d[i] = sq * 0.3 * Math.min(1, t / 0.01) * Math.min(1, (seconds - t) / 0.05);
  }
  return buf;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private echo: ConvolverNode | null = null;
  private readonly gains = new Map<Category, GainNode>();
  private readonly beds = new Map<Bed, { gain: GainNode; pan: StereoPannerNode }>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly active: Record<Category, number> = { gun: 0, melee: 0, voice: 0, alarm: 0 };
  private muted = false;

  /** Call from a user gesture. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ctx.destination);
    for (const [cat, level] of [['gun', 0.75], ['melee', 0.3], ['voice', 0.4], ['alarm', 0.2]] as const) {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(this.master);
      this.gains.set(cat, g);
    }
    this.echo = ctx.createConvolver();
    this.echo.buffer = normalise(streetEcho(ctx), 0.6);
    this.echo.connect(this.gains.get('gun')!);
    for (const [name, s] of Object.entries(SHOTS)) this.buffers.set(name, normalise(gunshot(ctx, s)));
    this.buffers.set('club', normalise(burst(ctx, 0.18, 0.04, 260)));
    this.buffers.set('sledgehammer', normalise(burst(ctx, 0.3, 0.07, 180)));
    this.buffers.set('shout', normalise(shout(ctx)));
    this.buffers.set('alarm', normalise(alarm(ctx)));
    // Loops at one peak too: their levels are the bed gains in update().
    const loops: Record<Bed, AudioBuffer> = { moan: moan(ctx), engine: engine(ctx), siren: siren(ctx), wind: wind(ctx), hum: hum(ctx), night: crickets(ctx) };
    for (const buffer of Object.values(loops)) normalise(buffer, 0.7);
    for (const [name, buffer] of Object.entries(loops) as [Bed, AudioBuffer][]) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      src.connect(gain).connect(pan).connect(this.master);
      src.start(0, Math.random() * buffer.duration); // out of step with each other
      this.beds.set(name, { gain, pan });
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  private bed(name: Bed, level: number, pan = 0, smoothing = 0.4): void {
    const b = this.beds.get(name)!;
    const now = this.ctx!.currentTime;
    b.gain.gain.setTargetAtTime(level, now, smoothing);
    b.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, smoothing);
  }

  /** Plays what this frame made audible. Reads the snapshot; writes nothing back. */
  update(frame: FrameSnapshot, cam: Camera, speed: number): void {
    const ctx = this.ctx;
    if (!ctx || this.muted || speed === 0) {
      if (ctx) for (const name of this.beds.keys()) this.bed(name, 0, 0, 0.3);
      return;
    }
    const a = cam.toWorld(0, 0), b = cam.toWorld(cam.width, cam.height);
    const onScreen = (x: number, y: number) => x >= a.x && x <= b.x && y >= a.y && y <= b.y;
    const height = (b.x - a.x) * HEIGHT_SHARE;
    const away = (x: number, y: number) => Math.hypot(x - cam.x, y - cam.y, height);
    const panOf = (x: number) => (x - cam.x) / Math.max(1, (b.x - a.x) / 2);
    const fast = speed > 4 ? 0.5 : 1;

    // The dead, as a crowd: by how many awake are in view, the nearer the louder.
    let dead = 0;
    for (let i = 0; i < frame.zombieKind.length; i++) {
      if (frame.zombieKind[i] !== ZOMBIE_AWAKE && frame.zombieKind[i] !== ZOMBIE_INTACT) continue;
      const x = frame.zombieXY[i * 2]!, y = frame.zombieXY[i * 2 + 1]!;
      if (onScreen(x, y)) dead += NEAR / Math.max(NEAR, away(x, y) / 3);
    }
    this.bed('moan', Math.min(0.4, 0.04 * Math.sqrt(dead)) * fast);

    // Cars being driven, and the sirens of those on a call: nearer counts for more.
    let engines = 0, ex = 0;
    let sirenNear = 0, sirenX = 0;
    const st = frame.carState, xyh = frame.carXYH;
    for (let i = 0; i < st.length; i++) {
      if ((st[i]! & CAR_STATE_MASK) !== CAR_DRIVING) continue;
      const x = xyh[i * 3]!, y = xyh[i * 3 + 1]!;
      const w = NEAR / Math.max(NEAR, away(x, y));
      engines += w;
      ex += w * x;
      if ((st[i]! & (CAR_VAN | CAR_CRUISER | CAR_AMBULANCE)) !== 0 && w > sirenNear) {
        sirenNear = w;
        sirenX = x;
      }
    }
    this.bed('engine', Math.min(0.3, 0.12 * Math.sqrt(engines)) * fast, engines > 0 ? panOf(ex / engines) * 0.7 : 0);
    this.bed('siren', Math.min(0.22, 0.25 * sirenNear) * fast, panOf(sirenX) * 0.8, 0.25);

    // The city: wind always; the hum of the living city, as it empties; crickets after dark.
    const c = frame.counters;
    const population = c.unturned.outdoors + c.unturned.indoors + c.unturned.dead + c.unturned.evacuated + c.turned.symptomatic + c.turned.outdoors + c.turned.occupying + c.turned.destroyed;
    const living = population > 0 ? (c.unturned.outdoors + c.unturned.indoors) / population : 0;
    this.bed('wind', 0.05 + 0.04 * (1 - living), 0, 1);
    this.bed('hum', 0.07 * living * frame.daylight, 0, 1);
    this.bed('night', 0.5 * (1 - frame.daylight), 0, 1);

    // One-shots: heard out to their own reach (how far the dead hear them) or the view,
    // loudest at the listener first, a few per frame.
    const budget = speed >= 8 ? PER_FRAME.loudestOnly : speed > 4 ? PER_FRAME.thin : PER_FRAME.normal;
    const reach = Math.hypot(b.x - a.x, b.y - a.y) / 2;
    const heard = frame.noises
      .filter((n) => CATEGORY[n.kind] && this.buffers.has(n.kind) && Math.hypot(n.x - cam.x, n.y - cam.y) <= Math.max(reach, n.radius))
      .map((n) => ({ n, d: away(n.x, n.y) }))
      .sort((p, q) => q.n.radius / Math.max(NEAR, q.d) - p.n.radius / Math.max(NEAR, p.d));
    let played = 0;
    for (const { n, d } of heard) {
      if (played >= budget) break;
      const cat = CATEGORY[n.kind]!;
      if (this.active[cat] >= VOICES[cat]) continue;
      this.play(n.kind, cat, d, Math.hypot(n.x - cam.x, n.y - cam.y), panOf(n.x));
      played++;
    }
  }

  /**
   * One sound, `d` metres from the listener (height included): quieter and duller the
   * farther, later by its distance along the ground, with the street's echo under gunfire.
   */
  private play(kind: string, cat: Category, d: number, ground: number, panX: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.get(kind)!;
    src.playbackRate.value = 1 + (Math.random() - 0.5) * JITTER;
    const dull = ctx.createBiquadFilter();
    dull.type = 'lowpass';
    dull.frequency.value = Math.max(500, 16000 * Math.exp(-d / DULL));
    const level = ctx.createGain();
    level.gain.value = Math.min(1, NEAR / Math.max(NEAR, d)) ** 0.8;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, panX)) * 0.85;
    src.connect(dull).connect(level).connect(pan).connect(this.gains.get(cat)!);
    if (cat === 'gun' && this.echo) {
      const send = ctx.createGain();
      const far = Math.min(1, d / 600);
      send.gain.value = (ECHO_NEAR + (ECHO_FAR - ECHO_NEAR) * far) * Math.max(0.3, level.gain.value);
      level.connect(send).connect(this.echo);
    }
    this.active[cat]++;
    src.onended = () => this.active[cat]--;
    src.start(ctx.currentTime + Math.min(MAX_DELAY, ground / SOUND_SPEED));
  }
}
