// Sound: a readout of the simulation, not a layer beside it. Weapon noise in the
// snapshot is the same stimulus that draws the dead, so the shot you hear is the
// one the horde heard.
//
// Web Audio throughout, all of it synthesised: no assets. Beds and the short
// one-shots are built once at start. A cordon transmission is built when it
// plays, so each one has its own voice. Two kinds of sound:
//
//   one-shots  each noise in the snapshot (shots, blows, shouts; car alarms once the
//              simulation makes them) is a throwaway source through its own chain:
//              distance (quieter, duller and later the farther it is from the middle
//              of the view), a stereo panner, a category gain — and, for gunfire, a
//              send to one shared street echo. Heard out to the noise's own radius,
//              how far the dead hear it, so a fight just off screen is heard too.
//   beds       loops whose levels follow what is in view: the dead (a moan), cars
//              being driven (engines), police cars, SWAT vans and ambulances on the
//              move (a siren), and the city itself (a steady low traffic drone that
//              thins with the living and is quieter at night).
//
// Three more buses sit under the master — city, outbreak, cordon — each with its
// own gain, so a layer can be mixed off without a click (setLayerEnabled). The
// city bus carries that drone, distant engines now and then, a murmur, a looped
// pavement of footsteps by day, and sparse life sounds: phones by day, a door, a
// dog, a horn, a bell, birds by day. At night the voices thin out, with the odd
// drunken shout or a bin going over. No wind, no surf-like noise bed, and no
// insects. The outbreak bus adds a low groan and a rare
// distant scream that follow how much of the city has turned, ducked under the
// moan so the two do not stack. The cordon bus is short radio transmissions
// (a squelch, garbled voices, a squelch tail, then silence) and a distant shot,
// silent until an exit is closed and louder when the view is near one.
//
// The funnel is the work: loudest first, a few per frame, voice caps per category,
// thinner above 4× and only the loudest at 8×. Ambient one-shots share those caps,
// skip entirely at 8×, and never pile up. No per-zombie sounds.
//
// The listener stands at the middle of the view, raised with the zoom: zoomed out,
// everything is farther away, so the city sounds distant from above and close at
// street level.
//
// Browsers block audio until the viewer interacts; `start` is called on the first
// click or key, and the scenario starts paused anyway.

import type { Camera } from '../render/camera';
import type { FrameSnapshot } from '../worker/protocol';
import { CAR_AMBULANCE, CAR_CRUISER, CAR_DRIVING, CAR_STATE_MASK, CAR_VAN, SIM_LIVING, SIM_PROMOTED, ZOMBIE_AWAKE, ZOMBIE_INTACT } from '../worker/protocol';

type Category = 'gun' | 'melee' | 'voice' | 'alarm';
type Bed = 'moan' | 'engine' | 'siren' | 'drone' | 'groan' | 'murmur' | 'steps';
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

/** What the buffer builders need. An AudioContext satisfies it; so does a test double. */
interface SampleCtx {
  readonly sampleRate: number;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
}

/** Which ambient bus a toggle addresses. */
export type AmbientLayer = 'city' | 'outbreak' | 'cordon';

// A steady traffic drone. Day cap matches the old rumble; night is lower; a dead
// city is silent. `traffic` is how present distant engines are (the living share).
const CITY_DRONE = 0.032;
const CITY_DRONE_NIGHT = 0.4;

// The outbreak groan sits under the local moan bed (which reaches MOAN_PEAK). Most of it
// ducks while that crowd is already loud, so the two do not stack.
const MOAN_PEAK = 0.4;
const OUTBREAK_GROAN_PEAK = 0.12;
const OUTBREAK_MOAN_DUCK = 0.65;

// Cordon proximity: full beside a closed barrier, a trace from far off, silent until one closes.
const CORDON_NEAR_M = 250;
const CORDON_FAR_M = 1800;
const CORDON_NEAR_GAIN = 0.16;
const CORDON_FAR_GAIN = 0.02;

/** MapSnapshot.exits: x, y, dx, dy, barrier x, barrier y, width. */
export const EXIT_STRIDE = 7;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Steady drone level, and how present distant engines are. Both die with the living. */
export function cityLevels(daylight: number, living: number): { drone: number; traffic: number } {
  const day = clamp01(daylight);
  const live = clamp01(living);
  return {
    drone: CITY_DRONE * live * (CITY_DRONE_NIGHT + (1 - CITY_DRONE_NIGHT) * day),
    traffic: live,
  };
}

/**
 * Low groan from the dead's share of whoever is still in the city (evacuated count as
 * neither). Squared, so the first deaths barely register and a city half gone is still
 * quiet beside the moan of whatever is on screen.
 */
export function outbreakLevel(dead: number, living: number): number {
  const d = Math.max(0, dead);
  const l = Math.max(0, living);
  if (d + l <= 0) return 0;
  const ratio = d / (d + l);
  return OUTBREAK_GROAN_PEAK * ratio * ratio;
}

/** The groan after ducking under the moan already playing in view (`moan` is that bed's gain). */
export function groanedUnderMoan(dead: number, living: number, moan: number): number {
  const duck = 1 - OUTBREAK_MOAN_DUCK * Math.min(1, Math.max(0, moan) / MOAN_PEAK);
  return outbreakLevel(dead, living) * Math.max(0, duck);
}

/** Proximity gain from metres to the nearest closed exit or its barrier. Open cordons are silent. */
export function cordonLevel(distanceM: number, closed: boolean): number {
  if (!closed || !Number.isFinite(distanceM)) return 0;
  if (distanceM <= CORDON_NEAR_M) return CORDON_NEAR_GAIN;
  if (distanceM >= CORDON_FAR_M) return CORDON_FAR_GAIN;
  const t = (distanceM - CORDON_NEAR_M) / (CORDON_FAR_M - CORDON_NEAR_M);
  return CORDON_NEAR_GAIN + (CORDON_FAR_GAIN - CORDON_NEAR_GAIN) * t;
}

/**
 * Metres from the camera to the nearest closed exit mouth or its barrier. Infinity when
 * none are closed. Both points count: the highway's end and the bar across it.
 */
export function cordonDistance(camX: number, camY: number, exits: ArrayLike<number>, closedBits: number): number {
  let best = Infinity;
  for (let i = 0, k = 0; i + 6 < exits.length; i += EXIT_STRIDE, k++) {
    if ((closedBits & (1 << k)) === 0) continue;
    best = Math.min(best, Math.hypot(camX - exits[i]!, camY - exits[i + 1]!), Math.hypot(camX - exits[i + 4]!, camY - exits[i + 5]!));
  }
  return best;
}

/** How many nearby outdoor people count as a full street of murmur. */
const LIFE_RADIUS_M = 140;
const LIFE_FULL = 6;
/** Under the groan (peaks at 0.12) and the cordon chatter (0.22 up close). */
const MURMUR_PEAK = 0.045;
const MURMUR_NIGHT = 0.22;
const LIFE_NIGHT = 0.35;

/**
 * 0–1 from outdoor living people near the camera (living and promoted dots). Hidden
 * sims — indoors, dead, turned — do not count. A dead street is 0.
 */
export function outdoorLifeNear(camX: number, camY: number, simXY: ArrayLike<number>, simKind: ArrayLike<number>, radiusM = LIFE_RADIUS_M): number {
  const n = Math.min(simKind.length, Math.floor(simXY.length / 2));
  let w = 0;
  for (let i = 0; i < n; i++) {
    const kind = simKind[i]!;
    if (kind !== SIM_LIVING && kind !== SIM_PROMOTED) continue;
    const d = Math.hypot(camX - simXY[i * 2]!, camY - simXY[i * 2 + 1]!);
    if (d >= radiusM) continue;
    w += 1 - d / radiusM;
  }
  return Math.min(1, w / LIFE_FULL);
}

/**
 * Murmur and life-sound levels. `lifeNear` is outdoorLifeNear. Day is busy; night keeps
 * a few late voices and sparser one-shots. Birds are day only. Groan and cordon duck
 * the crowd so they stay in front.
 */
export function crowdMix(lifeNear: number, daylight: number, groan: number, cordon: number): { murmur: number; life: number; birds: number; steps: number; phones: number; night: number } {
  const life = clamp01(lifeNear);
  const day = clamp01(daylight);
  const voices = MURMUR_NIGHT + (1 - MURMUR_NIGHT) * day;
  const groanDuck = 1 - 0.6 * Math.min(1, Math.max(0, groan) / OUTBREAK_GROAN_PEAK);
  const cordonDuck = 1 - 0.55 * Math.min(1, Math.max(0, cordon) / CORDON_NEAR_GAIN);
  const mask = Math.max(0, groanDuck) * Math.max(0, cordonDuck);
  return {
    murmur: MURMUR_PEAK * life * voices * mask,
    life: life * (LIFE_NIGHT + (1 - LIFE_NIGHT) * day) * mask,
    birds: life * day * mask,
    steps: life * day * mask,
    phones: life * day * mask,
    night: life * (1 - day) * mask,
  };
}

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
function shout(ctx: SampleCtx): AudioBuffer {
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
function burst(ctx: SampleCtx, seconds: number, decay: number, cutoff: number): AudioBuffer {
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
function gunshot(ctx: SampleCtx, s: Shot): AudioBuffer {
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
function streetEcho(ctx: SampleCtx): AudioBuffer {
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
function moan(ctx: SampleCtx): AudioBuffer {
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

/**
 * Several rough low engines at fixed pitches, each wandering a fraction of a percent,
 * plus a very thin constant band of tyre noise. No level swell: the join is a short
 * crossfade so the loop does not thump.
 */
function trafficDrone(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 8;
  const fade = Math.floor(rate * 0.04);
  const n = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(1, n, rate);
  const d = buf.getChannelData(0);
  const engines = [
    { f: 41, width: 0.16, gain: 0.62, wander: 0.006, cycles: 1 },
    { f: 48, width: 0.12, gain: 0.78, wander: 0.008, cycles: 2 },
    { f: 55, width: 0.2, gain: 0.5, wander: 0.005, cycles: 1 },
    { f: 67, width: 0.14, gain: 0.42, wander: 0.007, cycles: 3 },
    { f: 86, width: 0.1, gain: 0.3, wander: 0.004, cycles: 2 },
  ];
  const phase = engines.map(() => 0);
  const lpA = Math.exp((-2 * Math.PI * 220) / rate);
  let lp = 0;
  // One-pole highpass under the lowest fundamental, so the pulse's offset does not sit as a pressure.
  const dcA = Math.exp((-2 * Math.PI * 25) / rate);
  let dc = 0;
  let prevLp = 0;
  const tyreHp = Math.exp((-2 * Math.PI * 700) / rate);
  const tyreLp = Math.exp((-2 * Math.PI * 1100) / rate);
  let tyreState = 0;
  let tyrePrev = 0;
  let tyreBand = 0;
  const total = n + fade;
  const raw = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / rate;
    let mix = 0;
    for (let e = 0; e < engines.length; e++) {
      const eng = engines[e]!;
      const wob = 1 + eng.wander * Math.sin((2 * Math.PI * eng.cycles * t) / seconds);
      phase[e] = (phase[e]! + (eng.f * wob) / rate) % 1;
      const p = phase[e]!;
      const pulse = p < eng.width ? 1 : -0.22;
      mix += (pulse * 0.7 + (2 * p - 1) * 0.3) * eng.gain;
    }
    lp = (1 - lpA) * mix + lpA * lp;
    dc = dcA * (dc + lp - prevLp);
    prevLp = lp;
    const noise = rnd();
    const hp = tyreHp * (tyreState + noise - tyrePrev);
    tyreState = hp;
    tyrePrev = noise;
    tyreBand = (1 - tyreLp) * hp + tyreLp * tyreBand;
    raw[i] = dc * 0.5 + tyreBand * 0.035;
  }
  for (let i = 0; i < n; i++) d[i] = raw[i]!;
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    d[i] = raw[i]! * w + raw[n + i]! * (1 - w);
  }
  return buf;
}

/** Engines: a rough low rumble with its harmonics, idling to driving. */
function engine(ctx: SampleCtx): AudioBuffer {
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
function siren(ctx: SampleCtx): AudioBuffer {
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
function alarm(ctx: SampleCtx): AudioBuffer {
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

/** A distant car or bike: pitch falls through the pass, the low-pass opens as it nears. */
function distantEngine(ctx: SampleCtx, fundamental: number, seconds: number, pullAway: boolean): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  let ph = 0;
  let lp = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    const u = t / seconds;
    const f = pullAway ? fundamental * (u < 0.35 ? 1 : 1 + (u - 0.35) * 0.85) : fundamental * (1.28 - 0.55 * u);
    ph += f / rate;
    const p = ph % 1;
    const pulse = p < (pullAway ? 0.28 : 0.16) ? 1 : -0.25;
    const open = pullAway ? Math.min(1, u / 0.3) : Math.sin(Math.PI * u);
    const cut = 140 + (pullAway ? 80 : 260) * open;
    const a = Math.exp((-2 * Math.PI * cut) / rate);
    lp = (1 - a) * pulse + a * lp;
    const env = pullAway ? Math.min(1, t / 0.15) * (u < 0.55 ? 0.7 : 0.7 + (u - 0.55) * 0.4) * Math.min(1, (1 - u) / 0.2) : Math.sin(Math.PI * u) ** 1.1;
    d[i] = lp * env;
  }
  return buf;
}

/** Fewer, lower voices than the moan, so it sits under that crowd instead of doubling it. */
function groan(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 8;
  const buf = ctx.createBuffer(1, rate * seconds, rate);
  const d = buf.getChannelData(0);
  for (let v = 0; v < 3; v++) {
    const pitch = 42 + Math.random() * 36;
    const drift = 0.03 + Math.random() * 0.04;
    const phase0 = Math.random() * seconds;
    const swells = 1;
    const formants = [[280 + Math.random() * 80, 0.985], [560 + Math.random() * 120, 0.96]] as const;
    const st = formants.map(() => ({ y1: 0, y2: 0 }));
    let ph = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / rate;
      const f = pitch * (1 + drift * Math.sin((2 * Math.PI * (t + phase0)) / seconds));
      ph += f / rate;
      const glottal = (ph % 1) * 2 - 1 + rnd() * 0.45;
      let out = 0;
      formants.forEach(([ff, r], k) => {
        const c = 2 * r * Math.cos((2 * Math.PI * ff) / rate);
        const y = glottal * (1 - r) + c * st[k]!.y1 - r * r * st[k]!.y2;
        st[k]!.y2 = st[k]!.y1;
        st[k]!.y1 = y;
        out += y;
      });
      const env = Math.max(0, Math.sin((2 * Math.PI * swells * (t + phase0)) / seconds)) ** 2;
      d[i]! += out * env * 0.55;
    }
  }
  return buf;
}

/** A distant scream: higher than a shout, falling, and mostly noise. */
function scream(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 0.75;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  let y1 = 0, y2 = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    const f = 980 - (520 * t) / seconds;
    const r = 0.97;
    const c = 2 * r * Math.cos((2 * Math.PI * f) / rate);
    const y = rnd() * 0.12 + c * y1 - r * r * y2;
    y2 = y1;
    y1 = y;
    const env = Math.min(1, t / 0.03) * Math.exp(-Math.max(0, t - 0.12) / 0.22);
    d[i] = y * env;
  }
  return buf;
}

/** Vowel-like formant targets (Hz). Jumped between, never smoothed into a word. */
const VOWELS: readonly (readonly [number, number, number])[] = [
  [730, 1090, 2440],
  [270, 2290, 3010],
  [300, 870, 2240],
  [530, 1840, 2480],
  [570, 840, 2410],
  [500, 1500, 2500],
  [390, 1990, 2550],
  [640, 1190, 2390],
];

/**
 * Unintelligible speech into `dest`. `radio` is the cordon chain: 300 Hz–3 kHz, hiss,
 * saturation and a light crush. Without it the band is wider and clean, for the crowd.
 */
function garbleInto(dest: Float32Array, rate: number, start: number, dur: number, pitch: number, radio: boolean, syllableRate?: number, gain = 1, wobble = 1, consonant = 1): void {
  const syl = syllableRate ?? 4 + Math.random() * 3;
  const formants = Math.random() < 0.34 ? 2 : 3;
  const vowels: [number, number, number][] = [];
  const vowelCount = 3 + Math.floor(Math.random() * 3);
  for (let v = 0; v < vowelCount; v++) {
    const src = VOWELS[Math.floor(Math.random() * VOWELS.length)]!;
    vowels.push([src[0], src[1], src[2]]);
  }
  const bw = [90 + Math.random() * 40, 120 + Math.random() * 50, 160 + Math.random() * 50];
  const st = [{ y1: 0, y2: 0 }, { y1: 0, y2: 0 }, { y1: 0, y2: 0 }];
  const coef = [0, 0, 0];
  const rad = [0, 0, 0];
  let lastSyl = -1;
  let ph = Math.random();
  let wander = 0;
  let xPrev = 0;
  let hp = 0;
  let lp = 0;
  let hiss = 0;
  const hpA = Math.exp((-2 * Math.PI * (radio ? 300 : 80)) / rate);
  const lpA = Math.exp((-2 * Math.PI * (radio ? 3000 : 7000)) / rate);
  const hissA = Math.exp((-2 * Math.PI * 2000) / rate);
  const i0 = Math.floor(start * rate);
  const n = Math.floor(dur * rate);
  for (let i = 0; i < n && i0 + i < dest.length; i++) {
    const t = i / rate;
    if ((i & 31) === 0) wander = wander * 0.8 + (Math.random() - 0.5) * 0.035 * wobble;
    const glide = radio ? 0.045 : 0.045 * wobble;
    const contour = 1 + glide * Math.sin((Math.PI * t) / Math.max(0.05, dur)) - 0.03 * (t / Math.max(0.05, dur)) + wander;
    ph += (pitch * contour) / rate;
    const p = ph % 1;
    const pulse = p < 0.32 ? Math.sin((Math.PI * p) / 0.32) : -0.12 * Math.exp(-(p - 0.32) / 0.1);
    const sylPhase = (t * syl) % 1;
    const sylIndex = Math.floor(t * syl);
    if (sylIndex !== lastSyl) {
      lastSyl = sylIndex;
      const vowel = vowels[sylIndex % vowels.length]!;
      for (let k = 0; k < formants; k++) {
        const r = Math.exp((-Math.PI * bw[k]!) / rate);
        rad[k] = r;
        coef[k] = 2 * r * Math.cos((2 * Math.PI * vowel[k]!) / rate);
      }
    }
    let voiced = 0;
    for (let k = 0; k < formants; k++) {
      const r = rad[k]!;
      const y = pulse * (1 - r) + coef[k]! * st[k]!.y1 - r * r * st[k]!.y2;
      st[k]!.y2 = st[k]!.y1;
      st[k]!.y1 = y;
      voiced += y * (k === 0 ? 1 : 0.65);
    }
    const gap = sylPhase < 0.7 ? Math.sin((Math.PI * sylPhase) / 0.7) ** 1.15 : 0;
    const cons = sylPhase < 0.09 ? rnd() * (1 - sylPhase / 0.09) * (radio ? 0.8 : 0.35) * consonant : 0;
    const edge = Math.min(1, t / 0.028) * Math.min(1, (dur - t) / 0.045);
    let x = (voiced * 0.85 + cons) * gap * edge;
    if (radio) {
      hiss = (1 - hissA) * rnd() + hissA * hiss;
      x += hiss * 0.04 * edge;
    }
    const hpOut = hpA * (hp + x - xPrev);
    hp = hpOut;
    xPrev = x;
    lp = (1 - lpA) * hpOut + lpA * lp;
    dest[i0 + i]! += (radio ? Math.round(Math.tanh(lp * 1.7) * 64) / 64 : lp) * gain;
  }
}

/**
 * One radio transmission, 1–4 s: squelch in, garbled speech, squelch out.
 * Sometimes a second voice answers. Hiss is only inside this buffer.
 */
function radioChatter(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const reply = Math.random() < 0.4;
  let talkA = 0.85 + Math.random() * 1.5;
  let talkB = reply ? 0.5 + Math.random() * 1.05 : 0;
  const mid = reply ? 0.12 + Math.random() * 0.16 : 0;
  const open = 0.07;
  const close = 0.11;
  let total = open + talkA + mid + talkB + close;
  if (total > 3.95) {
    const scale = (3.95 - open - mid - close) / (talkA + talkB);
    talkA *= scale;
    talkB *= scale;
    total = open + talkA + mid + talkB + close;
  }
  const buf = ctx.createBuffer(1, Math.ceil(rate * total), rate);
  const d = buf.getChannelData(0);
  const noiseA = Math.exp((-2 * Math.PI * 2400) / rate);

  const squelch = (start: number, seconds: number, beepHz: number, kind: 'open' | 'close') => {
    const n = Math.ceil(seconds * rate);
    const i0 = Math.floor(start * rate);
    let ph = 0;
    let nse = 0;
    for (let i = 0; i < n && i0 + i < d.length; i++) {
      const t = i / rate;
      nse = (1 - noiseA) * rnd() + noiseA * nse;
      ph += beepHz / rate;
      const tone = Math.sin(2 * Math.PI * ph);
      if (kind === 'open') {
        const click = t < 0.006 ? (1 - t / 0.006) * rnd() * 1.3 : 0;
        d[i0 + i]! += click + tone * Math.exp(-t / 0.018) * 0.4 + nse * Math.exp(-t / 0.022) * 1.1;
      } else {
        const beepT = Math.max(0, t - 0.025);
        const beep = tone * Math.min(1, beepT / 0.006) * Math.exp(-beepT / 0.028) * 0.55;
        const tail = nse * Math.min(1, t / 0.012) * Math.exp(-t / 0.035) * 1.15;
        d[i0 + i]! += beep + tail;
      }
    }
  };

  const speak = (start: number, dur: number, pitch: number) => garbleInto(d, rate, start, dur, pitch, true);

  const pitchA = 90 + Math.random() * 70;
  squelch(0, open, 1750 + Math.random() * 400, 'open');
  speak(open, talkA, pitchA);
  if (reply) {
    squelch(open + talkA, mid, 1900 + Math.random() * 500, 'open');
    let pitchB = 90 + Math.random() * 70;
    if (Math.abs(pitchB - pitchA) < 18) pitchB = Math.min(160, Math.max(90, pitchA + (pitchA < 125 ? 28 : -28)));
    speak(open + talkA + mid, talkB, pitchB);
  }
  squelch(open + talkA + mid + talkB, close, 2000 + Math.random() * 300, 'close');
  return buf;
}

/** A handful of voices, staggered, looping as one bed. Male, female and child pitches. */
function murmur(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 8;
  const buf = ctx.createBuffer(1, Math.floor(rate * seconds), rate);
  const d = buf.getChannelData(0);
  const voices: { pitch: number; every: number; talk: number; phase: number; gain: number }[] = [
    { pitch: 90 + Math.random() * 45, every: 2.6, talk: 1.15, phase: 0.3, gain: 0.75 },
    { pitch: 100 + Math.random() * 40, every: 3.2, talk: 1.05, phase: 1.6, gain: 0.7 },
    { pitch: 170 + Math.random() * 55, every: 2.9, talk: 0.95, phase: 0.8, gain: 0.62 },
    { pitch: 185 + Math.random() * 50, every: 3.5, talk: 1.1, phase: 2.2, gain: 0.58 },
    { pitch: 250 + Math.random() * 60, every: 3.8, talk: 0.7, phase: 1.1, gain: 0.4 },
    { pitch: 270 + Math.random() * 55, every: 4.4, talk: 0.6, phase: 2.9, gain: 0.36 },
  ];
  for (const v of voices) {
    for (let t = v.phase; t < seconds; t += v.every) {
      if (t + v.talk >= seconds) break;
      garbleInto(d, rate, t, v.talk, v.pitch, false, 3 + Math.random() * 2, v.gain);
    }
  }
  return buf;
}

/** Four 'ha' syllables, pitch up and then down. */
function laugh(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const has = 4 + Math.floor(Math.random() * 2);
  const step = 0.13;
  const seconds = 0.06 + has * step;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  const base = 180 + Math.random() * 50;
  for (let h = 0; h < has; h++) {
    const mid = (has - 1) / 2;
    const pitch = base + 70 * (1 - Math.abs(h - mid) / Math.max(0.5, mid));
    garbleInto(d, rate, 0.02 + h * step, 0.11, pitch, false, 9, 1);
  }
  return buf;
}

/** Someone calling across the street: one short open phrase, a bit higher. */
function callout(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 0.62;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  garbleInto(buf.getChannelData(0), rate, 0.02, 0.52, 210 + Math.random() * 90, false, 5 + Math.random() * 1.5, 1.15);
  return buf;
}

/** A nearer scrap of conversation, one voice. */
function nearPhrase(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 0.75 + Math.random() * 0.45;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const roll = Math.random();
  const pitch = roll < 0.4 ? 95 + Math.random() * 40 : roll < 0.75 ? 175 + Math.random() * 55 : 250 + Math.random() * 55;
  garbleInto(buf.getChannelData(0), rate, 0.02, seconds - 0.08, pitch, false, 3.2 + Math.random() * 2, 1);
  return buf;
}

/** A few footsteps going past: short low ticks in a walking rhythm. */
function footsteps(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const nSteps = 4;
  const stride = 0.48;
  const buf = ctx.createBuffer(1, Math.ceil(rate * (nSteps * stride + 0.08)), rate);
  const d = buf.getChannelData(0);
  const a = Math.exp((-2 * Math.PI * 480) / rate);
  for (let s = 0; s < nSteps; s++) {
    const i0 = Math.floor(s * stride * rate);
    let y = 0;
    const len = Math.floor(0.055 * rate);
    for (let i = 0; i < len && i0 + i < d.length; i++) {
      const t = i / rate;
      y = (1 - a) * rnd() + a * y;
      const click = t < 0.003 ? rnd() * (1 - t / 0.003) : 0;
      d[i0 + i]! += (click * 0.7 + y * 2.6 * Math.exp(-t / 0.018)) * (s % 2 === 0 ? 1 : 0.72);
    }
  }
  return buf;
}

/** Two or three short barks, each falling. */
function dogBark(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(rate * 0.55), rate);
  const d = buf.getChannelData(0);
  for (const at of [0.02, 0.22, 0.4]) {
    const i0 = Math.floor(at * rate);
    let y1 = 0, y2 = 0;
    const len = Math.floor(0.13 * rate);
    for (let i = 0; i < len && i0 + i < d.length; i++) {
      const t = i / rate;
      const f = 640 - 340 * Math.min(1, t / 0.09);
      const r = 0.955;
      const c = 2 * r * Math.cos((2 * Math.PI * f) / rate);
      const y = rnd() * 0.45 + c * y1 - r * r * y2;
      y2 = y1;
      y1 = y;
      d[i0 + i]! += y * Math.min(1, t / 0.008) * Math.exp(-t / 0.038);
    }
  }
  return buf;
}

/** Latch click and a low thud. */
function doorClose(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 0.32;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  const a = Math.exp((-2 * Math.PI * 160) / rate);
  let y = 0;
  let ph = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    y = (1 - a) * rnd() + a * y;
    const click = t < 0.007 ? rnd() * (1 - t / 0.007) * 1.3 : 0;
    ph += 105 / rate;
    d[i] = click + y * Math.exp(-t / 0.045) * 2 + Math.sin(2 * Math.PI * ph) * Math.exp(-t / 0.07) * 0.3;
  }
  return buf;
}

/** A two-tone horn, dull, as from a street or two away. */
function carHorn(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 0.4;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  let p1 = 0, p2 = 0, lp = 0;
  const lpA = Math.exp((-2 * Math.PI * 1600) / rate);
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    p1 += 330 / rate;
    p2 += 415 / rate;
    const env = Math.min(1, t / 0.02) * Math.min(1, (seconds - t) / 0.05);
    const x = (Math.sin(2 * Math.PI * p1) + Math.sin(2 * Math.PI * p2) * 0.75) * 0.35 * env;
    lp = (1 - lpA) * x + lpA * lp;
    d[i] = Math.tanh(lp * 1.3);
  }
  return buf;
}

/** Two quick pings. */
function bicycleBell(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(rate * 0.65), rate);
  const d = buf.getChannelData(0);
  for (const at of [0.01, 0.15]) {
    const i0 = Math.floor(at * rate);
    let p1 = 0, p2 = 0;
    for (let i = i0; i < d.length; i++) {
      const t = (i - i0) / rate;
      p1 += 2050 / rate;
      p2 += 2620 / rate;
      d[i]! += (Math.sin(2 * Math.PI * p1) * 0.55 + Math.sin(2 * Math.PI * p2) * 0.22) * Math.exp(-t / 0.11);
    }
  }
  return buf;
}

/** Two or three short rising chirps. Day only. */
function birdChirp(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(rate * 0.5), rate);
  const d = buf.getChannelData(0);
  for (const at of [0.02, 0.16, 0.32]) {
    const i0 = Math.floor(at * rate);
    const len = Math.floor(0.08 * rate);
    let ph = 0;
    for (let i = 0; i < len && i0 + i < d.length; i++) {
      const t = i / rate;
      ph += (2100 + 1500 * (t / 0.08)) / rate;
      d[i0 + i]! += Math.sin(2 * Math.PI * ph) * Math.sin(Math.PI * Math.min(1, t / 0.08)) ** 0.8 * 0.45;
    }
  }
  return buf;
}

/** Several walkers at once, different pace and shoe, looped as one pavement. */
function footstepBed(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 6;
  const buf = ctx.createBuffer(1, Math.floor(rate * seconds), rate);
  const d = buf.getChannelData(0);
  const walkers = [
    { pace: 0.44, phase: 0.05, heel: true, gain: 0.7 },
    { pace: 0.51, phase: 0.6, heel: false, gain: 0.4 },
    { pace: 0.39, phase: 1.3, heel: true, gain: 0.9 },
    { pace: 0.57, phase: 0.2, heel: false, gain: 0.28 },
    { pace: 0.48, phase: 2.1, heel: true, gain: 0.5 },
    { pace: 0.62, phase: 1.7, heel: false, gain: 0.33 },
  ];
  const heelA = Math.exp((-2 * Math.PI * 700) / rate);
  const softA = Math.exp((-2 * Math.PI * 280) / rate);
  for (const w of walkers) {
    for (let t = w.phase; t < seconds + w.pace; t += w.pace) {
      const at = t % seconds;
      const i0 = Math.floor(at * rate);
      const len = Math.floor((w.heel ? 0.045 : 0.07) * rate);
      let y = 0;
      const a = w.heel ? heelA : softA;
      for (let i = 0; i < len; i++) {
        const u = i / rate;
        y = (1 - a) * rnd() + a * y;
        const click = w.heel && u < 0.003 ? rnd() * (1 - u / 0.003) * 0.8 : 0;
        const idx = (i0 + i) % d.length;
        d[idx]! += (click + y * (w.heel ? 2.2 : 1.5) * Math.exp(-u / (w.heel ? 0.014 : 0.028))) * w.gain;
      }
    }
  }
  return buf;
}

/** A short original pattern. Not a known product tune. */
function ringtone(ctx: SampleCtx, notes: readonly number[]): AudioBuffer {
  const rate = ctx.sampleRate;
  const note = 0.16;
  const seconds = notes.length * note + 0.05;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  notes.forEach((f, n) => {
    const i0 = Math.floor(n * note * rate);
    let ph = 0;
    const len = Math.floor(0.14 * rate);
    for (let i = 0; i < len && i0 + i < d.length; i++) {
      const t = i / rate;
      ph += f / rate;
      const s = Math.sin(2 * Math.PI * ph);
      const edge = Math.min(1, t / 0.01) * Math.min(1, (0.14 - t) / 0.03);
      d[i0 + i]! += Math.tanh(s * 1.4) * edge * 0.45;
    }
  });
  return buf;
}

/** A phone buzzing in a pocket: ~150 Hz, a few short pulses. */
function phoneBuzz(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const pulses = 5;
  const on = 0.07;
  const off = 0.05;
  const seconds = pulses * (on + off);
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  let ph = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    const slot = t % (on + off);
    ph += 150 / rate;
    const env = slot < on ? Math.sin((Math.PI * slot) / on) : 0;
    d[i] = Math.sin(2 * Math.PI * ph) * env * 0.7;
  }
  return buf;
}

/** A message ping: one decaying tone, not a melody. */
function messagePing(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(rate * 0.28), rate);
  const d = buf.getChannelData(0);
  let ph = 0;
  const f = 740 + Math.random() * 180;
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    ph += f / rate;
    d[i] = Math.sin(2 * Math.PI * ph) * Math.exp(-t / 0.07) * 0.5;
  }
  return buf;
}

/** A keypad or notification blip. */
function notifyBlip(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(rate * 0.06), rate);
  const d = buf.getChannelData(0);
  let ph = 0;
  const f = 980 + Math.random() * 400;
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    ph += f / rate;
    d[i] = Math.sin(2 * Math.PI * ph) * (1 - t / 0.06) * 0.4;
  }
  return buf;
}

/** One slurred shout: slow syllables, a wobbly pitch, mostly vowel. */
function drunkShout(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 0.9 + Math.random() * 0.5;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  garbleInto(buf.getChannelData(0), rate, 0.02, seconds - 0.08, 95 + Math.random() * 55, false, 2.1 + Math.random() * 1.1, 1.15, 4, 0.25);
  return buf;
}

/** Two or three voices together, loose and short. */
function drunkCheer(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 0.7;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  for (const [at, pitch] of [[0, 130], [0.05, 175], [0.09, 210]] as const) {
    garbleInto(d, rate, at, 0.48, pitch + Math.random() * 15, false, 2.4, 0.7, 3, 0.3);
  }
  return buf;
}

/** A rising whoop. */
function whoop(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 0.42;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  let ph = 0;
  let y1 = 0;
  let y2 = 0;
  const r = 0.97;
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    const f = 160 + 340 * (t / seconds) * (1 + 0.04 * Math.sin(t * 28));
    ph += f / rate;
    const p = ph % 1;
    const pulse = p < 0.3 ? Math.sin((Math.PI * p) / 0.3) : 0;
    const c = 2 * r * Math.cos((2 * Math.PI * 640) / rate);
    const y = pulse * (1 - r) + c * y1 - r * r * y2;
    y2 = y1;
    y1 = y;
    d[i] = y * Math.sin(Math.PI * Math.min(1, t / seconds)) * 0.8;
  }
  return buf;
}

/** A few held notes, none of them in tune with each other. */
function drunkSong(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const notes = [188, 241, 163, 214];
  const step = 0.34;
  const buf = ctx.createBuffer(1, Math.ceil(rate * notes.length * step), rate);
  const d = buf.getChannelData(0);
  notes.forEach((pitch, n) => garbleInto(d, rate, n * step, 0.3, pitch, false, 1.8, 0.85, 2.2, 0.15));
  return buf;
}

/** A bin going over: inharmonic hits, a lid that spins down, a scrape. */
function binClatter(ctx: SampleCtx): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 1.4;
  const buf = ctx.createBuffer(1, Math.ceil(rate * seconds), rate);
  const d = buf.getChannelData(0);
  const partials = [171, 263, 397, 548, 812];
  for (const at of [0.02, 0.1, 0.18, 0.27]) {
    const i0 = Math.floor(at * rate);
    const phases = partials.map(() => Math.random() * Math.PI * 2);
    const amps = partials.map(() => 0.35 + Math.random() * 0.65);
    for (let i = i0; i < d.length; i++) {
      const t = (i - i0) / rate;
      let s = 0;
      for (let k = 0; k < partials.length; k++) s += Math.sin(2 * Math.PI * partials[k]! * t + phases[k]!) * amps[k]!;
      const tick = t < 0.008 ? rnd() * (1 - t / 0.008) : 0;
      d[i]! += (s * 0.2 + tick) * Math.exp(-t / 0.16);
    }
  }
  let t = 0.4;
  let gap = 0.072;
  while (t < 1.05 && gap > 0.014) {
    const i0 = Math.floor(t * rate);
    const f = 880 + Math.random() * 360;
    let ph = 0;
    const len = Math.min(d.length - i0, Math.floor(0.02 * rate));
    for (let i = 0; i < len; i++) {
      const u = i / rate;
      ph += f / rate;
      d[i0 + i]! += Math.sin(2 * Math.PI * ph) * Math.exp(-u / 0.007) * 0.32;
    }
    t += gap;
    gap *= 0.84;
  }
  const scrapeA = Math.exp((-2 * Math.PI * 850) / rate);
  let y = 0;
  const s0 = Math.floor(0.98 * rate);
  for (let i = s0; i < d.length; i++) {
    const u = (i - s0) / rate;
    y = (1 - scrapeA) * rnd() + scrapeA * y;
    d[i]! += y * Math.sin(Math.PI * Math.min(1, u / 0.35)) * 1.1;
  }
  return buf;
}

/** The drone, murmur and the daytime pavement ride the city bus. The groan rides the outbreak bus. */
const BED_LAYER: Partial<Record<Bed, AmbientLayer>> = {
  drone: 'city',
  murmur: 'city',
  steps: 'city',
  groan: 'outbreak',
};

const AMBIENT_VOICES = 3;
const LAYER_RAMP = 0.08;

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private echo: ConvolverNode | null = null;
  private readonly gains = new Map<Category, GainNode>();
  private readonly layerGains = new Map<AmbientLayer, GainNode>();
  private readonly beds = new Map<Bed, { gain: GainNode; pan: StereoPannerNode }>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly active: Record<Category, number> = { gun: 0, melee: 0, voice: 0, alarm: 0 };
  private readonly layerOn: Record<AmbientLayer, boolean> = { city: true, outbreak: true, cordon: true };
  private exits: ArrayLike<number> = new Float32Array();
  private nextTraffic = Infinity;
  private nextScream = Infinity;
  private nextRadio = Infinity;
  private nextGun = Infinity;
  private nextLife = Infinity;
  private nextPhrase = Infinity;
  private nextPhone = Infinity;
  private nextDrunk = Infinity;
  private nextBin = Infinity;
  private nextMurmurPan = 0;
  private murmurPan = 0;
  private flying = 0;
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
    for (const name of ['city', 'outbreak', 'cordon'] as const) {
      const g = ctx.createGain();
      g.gain.value = this.layerOn[name] ? 1 : 0;
      g.connect(this.master);
      this.layerGains.set(name, g);
    }
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
    // The groan is built after the older beds so those keep their timbre.
    const loops: Record<Bed, AudioBuffer> = {
      moan: moan(ctx), engine: engine(ctx), siren: siren(ctx), drone: trafficDrone(ctx),
      groan: groan(ctx), murmur: murmur(ctx), steps: footstepBed(ctx),
    };
    for (const buffer of Object.values(loops)) normalise(buffer, 0.7);
    for (const [name, buffer] of Object.entries(loops) as [Bed, AudioBuffer][]) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      const layer = BED_LAYER[name];
      src.connect(gain).connect(pan).connect(layer ? this.layerGains.get(layer)! : this.master);
      src.start(0, Math.random() * buffer.duration); // out of step with each other
      this.beds.set(name, { gain, pan });
    }
    this.buffers.set('pass', normalise(distantEngine(ctx, 78, 2.4, false)));
    this.buffers.set('bike', normalise(distantEngine(ctx, 125, 1.8, false)));
    this.buffers.set('truck', normalise(distantEngine(ctx, 36, 3.2, true)));
    this.buffers.set('accel', normalise(distantEngine(ctx, 58, 1.3, true)));
    this.buffers.set('scream', normalise(scream(ctx)));
    this.buffers.set('steps', normalise(footsteps(ctx)));
    this.buffers.set('bark', normalise(dogBark(ctx)));
    this.buffers.set('door', normalise(doorClose(ctx)));
    this.buffers.set('horn', normalise(carHorn(ctx)));
    this.buffers.set('bell', normalise(bicycleBell(ctx)));
    this.buffers.set('bird', normalise(birdChirp(ctx)));
    this.buffers.set('laugh', normalise(laugh(ctx)));
    this.buffers.set('callout', normalise(callout(ctx)));
    for (let i = 0; i < 3; i++) this.buffers.set(`phrase${i}`, normalise(nearPhrase(ctx)));
    // Original patterns: a small leap, a falling question, a wide odd interval. None is a product tune.
    this.buffers.set('ring0', normalise(ringtone(ctx, [392, 466, 349, 415])));
    this.buffers.set('ring1', normalise(ringtone(ctx, [523, 392, 440, 330])));
    this.buffers.set('ring2', normalise(ringtone(ctx, [440, 622, 370, 494])));
    this.buffers.set('buzz', normalise(phoneBuzz(ctx)));
    this.buffers.set('ping', normalise(messagePing(ctx)));
    this.buffers.set('blip', normalise(notifyBlip(ctx)));
    this.buffers.set('drunk0', normalise(drunkShout(ctx)));
    this.buffers.set('drunk1', normalise(drunkShout(ctx)));
    this.buffers.set('cheer', normalise(drunkCheer(ctx)));
    this.buffers.set('whoop', normalise(whoop(ctx)));
    this.buffers.set('sung', normalise(drunkSong(ctx)));
    this.buffers.set('bin0', normalise(binClatter(ctx)));
    this.buffers.set('bin1', normalise(binClatter(ctx)));
    const t0 = ctx.currentTime;
    this.nextTraffic = t0 + 3 + Math.random() * 5;
    this.nextScream = t0 + 6 + Math.random() * 6;
    this.nextRadio = t0 + 2 + Math.random() * 4;
    this.nextGun = t0 + 5 + Math.random() * 6;
    this.nextLife = t0 + 2 + Math.random() * 5;
    this.nextPhrase = t0 + 7 + Math.random() * 6;
    this.nextPhone = t0 + 4 + Math.random() * 6;
    this.nextDrunk = t0 + 8 + Math.random() * 8;
    this.nextBin = t0 + 11 + Math.random() * 8;
    this.nextMurmurPan = t0 + 1;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  /** Mix one ambient bus in or out. Safe before `start`: the flag is applied when the graph is built. */
  setLayerEnabled(name: AmbientLayer, on: boolean): void {
    this.layerOn[name] = on;
    const g = this.layerGains.get(name);
    if (g && this.ctx) g.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, LAYER_RAMP);
  }

  layerEnabled(name: AmbientLayer): boolean {
    return this.layerOn[name];
  }

  /** Exit mouths and barriers from the map snapshot (stride EXIT_STRIDE). Not simulation state. */
  setExits(exits: ArrayLike<number>): void {
    this.exits = exits;
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
    const moan = Math.min(MOAN_PEAK, 0.04 * Math.sqrt(dead));
    this.bed('moan', moan * fast);

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

    // The city: a steady traffic drone, quieter at night, silent when nobody is left.
    // (The noise hum and the brown-noise rumble both read as surf, so neither is played.
    // The old wind bed is not played either. Crickets stay out.) Murmur, pavement and
    // life sounds follow who is outdoors near the camera, and duck under the groan and the cordon.
    const c = frame.counters;
    const livingCount = c.unturned.outdoors + c.unturned.indoors;
    const deadCount = c.unturned.dead + c.turned.symptomatic + c.turned.outdoors + c.turned.occupying + c.turned.destroyed;
    const population = livingCount + deadCount + c.unturned.evacuated;
    const livingShare = population > 0 ? livingCount / population : 0;
    const city = cityLevels(frame.daylight, livingShare);
    this.bed('drone', city.drone, 0, 1.4);
    // Outbreak: a groan from how much of the city has turned, ducked while the local moan is already loud.
    const groanLevel = groanedUnderMoan(deadCount, livingCount, moan);
    this.bed('groan', groanLevel * fast, 0, 0.8);
    // Cordon proximity: scales the transmissions and the distant shots scheduled below.
    // There is no bed — between bursts the channel is silent.
    const cordon = cordonLevel(cordonDistance(cam.x, cam.y, this.exits, frame.closedExits), frame.closedExits !== 0);
    const lifeNear = outdoorLifeNear(cam.x, cam.y, frame.simXY, frame.simKind);
    const crowd = crowdMix(lifeNear, frame.daylight, groanLevel, cordon);
    if (ctx.currentTime >= this.nextMurmurPan) {
      this.murmurPan = (Math.random() - 0.5) * 0.65;
      this.nextMurmurPan = ctx.currentTime + 5 + Math.random() * 6;
    }
    this.bed('murmur', crowd.murmur * fast, this.murmurPan, 1.6);
    this.bed('steps', 0.05 * crowd.steps * fast, 0, 1.2);

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
    this.scheduleAmbient(ctx.currentTime, speed, livingShare, groanLevel, cordon, frame.daylight, lifeNear, crowd);
  }

  /**
   * Occasional one-shots on the ambient buses. At 8× they are skipped; above 4× the
   * gap doubles. A due event fires at most once, then its next time moves forward, so
   * a stalled frame cannot dump a queue. Randomness here is the audio clock's, never
   * the simulation's.
   */
  private scheduleAmbient(now: number, speed: number, traffic: number, groan: number, cordon: number, daylight: number, lifeNear: number, crowd: { life: number; birds: number; phones: number; night: number }): void {
    const gap = speed > 4 ? 2 : 1;
    const shots = speed < 8;
    if (this.nextTraffic <= now) {
      if (shots && traffic > 0.05 && this.layerOn.city && this.flying < AMBIENT_VOICES) {
        const roll = Math.random();
        const kind = roll < 0.42 ? 'pass' : roll < 0.68 ? 'bike' : roll < 0.88 ? 'truck' : 'accel';
        const from = Math.random() < 0.5 ? -0.6 : 0.6;
        const to = kind === 'pass' || kind === 'bike' ? -from : from * 0.3;
        const near = Math.random() < 0.15 ? 1.35 : 1;
        this.fireAmbient(kind, 'city', 0.048 * near * traffic, from, to);
      }
      // 8–20 s by day; rarer after dark. Doubled again above 4×.
      this.nextTraffic = now + (8 + Math.random() * 12) * gap * (daylight < 0.4 ? 2.4 : 1);
    }
    if (this.nextScream <= now) {
      if (shots && groan > 0.02 && this.layerOn.outbreak) {
        this.fireAmbient('scream', 'outbreak', 0.1 * Math.max(0.35, groan / OUTBREAK_GROAN_PEAK), 0, 0, 'voice');
      }
      this.nextScream = now + (14 + Math.random() * 20) * gap;
    }
    if (this.nextRadio <= now) {
      let span = 0;
      const room = this.flying < AMBIENT_VOICES && this.active.voice < VOICES.voice;
      if (shots && cordon > 0 && this.layerOn.cordon && room && this.ctx) {
        const near = cordon / CORDON_NEAR_GAIN;
        const pan = (Math.random() - 0.5) * 0.4;
        const chatter = normalise(radioChatter(this.ctx));
        if (this.playAmbient(chatter, 'cordon', 0.22 * near, pan, pan, 'voice', 0.03)) span = chatter.duration;
      }
      // The burst is the buffer; what follows is several seconds of silence, doubled above 4×.
      this.nextRadio = now + span + (4 + Math.random() * 5) * gap;
    }
    if (this.nextGun <= now) {
      if (shots && cordon > 0 && this.layerOn.cordon) {
        const near = cordon / CORDON_NEAR_GAIN;
        const pan = (Math.random() - 0.5) * 0.6;
        this.fireAmbient(Math.random() < 0.6 ? 'rifle' : 'pistol', 'cordon', 0.07 * near, pan, pan, 'gun');
      }
      this.nextGun = now + (11 + Math.random() * 16) * gap;
    }
    if (this.nextLife <= now) {
      if (shots && lifeNear > 0.12 && this.layerOn.city && this.flying < AMBIENT_VOICES) {
        const roll = Math.random();
        const day = daylight > 0.45;
        let kind = 'steps';
        let level = 0.042;
        let from = (Math.random() - 0.5) * 1.2;
        let to = from;
        if (!day) {
          if (roll < 0.4) {
            kind = 'steps';
            from = Math.random() < 0.5 ? -0.55 : 0.55;
            to = -from;
          } else if (roll < 0.7) kind = 'door';
          else kind = 'bark';
          level = kind === 'door' ? 0.036 : kind === 'bark' ? 0.04 : 0.042;
        } else if (day && crowd.birds > 0.08 && roll < 0.22) {
          kind = 'bird';
          level = 0.028;
        } else if (roll < 0.4) {
          kind = 'door';
          level = 0.036;
        } else if (roll < 0.55) {
          kind = 'horn';
          level = 0.03;
        } else if (roll < 0.72) {
          kind = 'bell';
          level = 0.032;
        } else if (roll < 0.88) {
          kind = 'bark';
          level = 0.04;
        } else {
          kind = 'steps';
          level = 0.042;
          from = Math.random() < 0.5 ? -0.55 : 0.55;
          to = -from;
        }
        this.fireAmbient(kind, 'city', level * (day ? crowd.life : Math.max(crowd.life, crowd.night)), from, to);
      }
      const night = daylight < 0.4 ? 2.5 : 1;
      const span = lifeNear > 0.12 ? ((7 + Math.random() * 8) * gap * night) / Math.max(0.35, lifeNear) : (16 + Math.random() * 10) * gap;
      this.nextLife = now + span;
    }
    if (this.nextPhrase <= now) {
      const room = this.flying < AMBIENT_VOICES && this.active.voice < VOICES.voice;
      if (shots && lifeNear > 0.12 && this.layerOn.city && room) {
        const roll = Math.random();
        const kind = roll < 0.5 ? `phrase${Math.floor(Math.random() * 3)}` : roll < 0.78 ? 'laugh' : 'callout';
        const pan = (Math.random() - 0.5) * 0.8;
        this.fireAmbient(kind, 'city', 0.065 * crowd.life, pan, pan, 'voice', 0.04);
      }
      this.nextPhrase = now + (14 + Math.random() * 12) * gap * (daylight < 0.4 ? 2.4 : 1);
    }
    if (this.nextPhone <= now) {
      if (shots && daylight > 0.45 && lifeNear > 0.12 && this.layerOn.city && this.flying < AMBIENT_VOICES) {
        const roll = Math.random();
        const kind = roll < 0.45 ? `ring${Math.floor(Math.random() * 3)}` : roll < 0.7 ? 'buzz' : roll < 0.88 ? 'ping' : 'blip';
        const near = Math.random() < 0.2;
        const pan = (Math.random() - 0.5) * (near ? 0.7 : 0.35);
        this.fireAmbient(kind, 'city', (near ? 0.055 : 0.022) * crowd.phones, pan, pan);
      }
      this.nextPhone = now + (12 + Math.random() * 10) * gap;
    }
    if (this.nextDrunk <= now) {
      const room = this.flying < AMBIENT_VOICES && this.active.voice < VOICES.voice;
      if (shots && daylight < 0.4 && lifeNear > 0.1 && this.layerOn.city && room) {
        const roll = Math.random();
        const kind = roll < 0.45 ? (Math.random() < 0.5 ? 'drunk0' : 'drunk1') : roll < 0.7 ? 'cheer' : roll < 0.85 ? 'whoop' : 'sung';
        const pan = (Math.random() - 0.5) * 0.7;
        this.fireAmbient(kind, 'city', 0.075 * crowd.night, pan, pan, 'voice', 0.05);
      }
      this.nextDrunk = now + (16 + Math.random() * 14) * gap;
    }
    if (this.nextBin <= now) {
      if (shots && daylight < 0.4 && lifeNear > 0.08 && this.layerOn.city && this.flying < AMBIENT_VOICES) {
        const near = 0.45 + Math.random() * 0.7;
        const pan = (Math.random() - 0.5) * 0.85;
        this.fireAmbient(Math.random() < 0.5 ? 'bin0' : 'bin1', 'city', 0.05 * near * crowd.night, pan, pan);
      }
      this.nextBin = now + (18 + Math.random() * 16) * gap;
    }
  }

  /** One ambient voice onto a layer bus. No street echo: a distant shot should not bloom on the master. */
  private fireAmbient(kind: string, layer: AmbientLayer, level: number, panFrom = 0, panTo = 0, cat?: Category, rateJitter = JITTER): boolean {
    const buffer = this.buffers.get(kind);
    if (!buffer) return false;
    return this.playAmbient(buffer, layer, level, panFrom, panTo, cat, rateJitter);
  }

  private playAmbient(buffer: AudioBuffer, layer: AmbientLayer, level: number, panFrom: number, panTo: number, cat: Category | undefined, rateJitter: number): boolean {
    const ctx = this.ctx;
    const bus = this.layerGains.get(layer);
    if (!ctx || !bus || !this.layerOn[layer] || this.flying >= AMBIENT_VOICES) return false;
    if (cat && this.active[cat] >= VOICES[cat]) return false;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 1 + (Math.random() - 0.5) * rateJitter;
    const gain = ctx.createGain();
    gain.gain.value = level;
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(panFrom, ctx.currentTime);
    if (panTo !== panFrom) pan.pan.linearRampToValueAtTime(panTo, ctx.currentTime + buffer.duration);
    src.connect(gain).connect(pan).connect(bus);
    this.flying++;
    if (cat) this.active[cat]++;
    src.onended = () => {
      this.flying--;
      if (cat) this.active[cat]--;
    };
    src.start(ctx.currentTime);
    return true;
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

/** A stand-in for AudioContext: the buffer builders only need a sample rate and createBuffer. */
function previewCtx(sampleRate: number): SampleCtx {
  return {
    sampleRate,
    createBuffer(channels, length, rate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: (ch: number) => data[ch]!,
      } as AudioBuffer;
    },
  };
}

/**
 * One layer, alone, as a mono buffer for a listening check. Gains follow the same
 * mapping as playback, then the whole take is peak-normalised so it is audible —
 * in the viewer these beds sit far under the master.
 */
export function renderAmbientPreview(layer: AmbientLayer, seconds = 14, sampleRate = 22050): Float32Array {
  const ctx = previewCtx(sampleRate);
  const out = new Float32Array(Math.ceil(sampleRate * seconds));
  const loop = (buf: AudioBuffer, gainAt: (t: number) => number) => {
    const d = buf.getChannelData(0);
    for (let i = 0; i < out.length; i++) out[i]! += d[i % d.length]! * gainAt(i / sampleRate);
  };
  const add = (buf: AudioBuffer, start: number, gain: number) => {
    const d = buf.getChannelData(0);
    const from = Math.floor(start * sampleRate);
    for (let i = 0; i < d.length && from + i < out.length; i++) out[from + i]! += d[i]! * gain;
  };
  if (layer === 'city') {
    const day = (t: number) => (t < 5 ? 1 : t < 8 ? 1 - (t - 5) / 3 : 0);
    loop(normalise(trafficDrone(ctx), 0.7), (t) => cityLevels(day(t), 0.85).drone);
    add(normalise(distantEngine(ctx, 78, 2.4, false)), 1.2, 0.05);
    add(normalise(distantEngine(ctx, 36, 3.2, true)), 6, 0.045);
  } else if (layer === 'outbreak') {
    loop(normalise(groan(ctx), 0.7), (t) => outbreakLevel(t, seconds - t));
    add(normalise(scream(ctx)), 8, 0.1);
  } else {
    let t = 0.5;
    while (t < seconds - 0.3) {
      const buf = normalise(radioChatter(ctx));
      if (t + 0.2 >= seconds) break;
      add(buf, t, 0.22);
      t += buf.duration + 3.4 + Math.random() * 2.2;
    }
    if (seconds > 8) add(normalise(gunshot(ctx, SHOTS.rifle!)), Math.min(6.2, seconds * 0.35), 0.07);
    if (seconds > 12) add(normalise(gunshot(ctx, SHOTS.pistol!)), Math.min(13.2, seconds * 0.72), 0.06);
  }
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < out.length; i++) out[i]! *= 0.9 / max;
  return out;
}

/** Day, night, or a city emptying out. Peak-normalised for listening; in the viewer these sit much quieter. */
export function renderCityScene(scene: 'day' | 'night' | 'outbreak', seconds = 20, sampleRate = 22050): Float32Array {
  const ctx = previewCtx(sampleRate);
  const out = new Float32Array(Math.ceil(sampleRate * seconds));
  const loop = (buf: AudioBuffer, gainAt: (t: number) => number) => {
    const d = buf.getChannelData(0);
    for (let i = 0; i < out.length; i++) out[i]! += d[i % d.length]! * gainAt(i / sampleRate);
  };
  const add = (buf: AudioBuffer, start: number, gain: number) => {
    const d = buf.getChannelData(0);
    const from = Math.floor(start * sampleRate);
    for (let i = 0; i < d.length && from + i < out.length; i++) out[from + i]! += d[i]! * gain;
  };
  const lifeAt = (t: number) => (scene === 'outbreak' ? Math.max(0, 1 - t / seconds) : scene === 'night' ? 0.55 : 0.9);
  const day = scene === 'night' ? 0 : 1;
  const groanAt = (t: number) => (scene === 'outbreak' ? outbreakLevel(t, Math.max(0.001, seconds - t)) : 0);
  loop(normalise(trafficDrone(ctx), 0.7), (t) => cityLevels(day, lifeAt(t)).drone);
  loop(normalise(murmur(ctx), 0.7), (t) => crowdMix(lifeAt(t), day, groanAt(t), 0).murmur);
  if (scene === 'day') loop(normalise(footstepBed(ctx), 0.7), (t) => 0.05 * crowdMix(lifeAt(t), day, groanAt(t), 0).steps);
  if (scene === 'outbreak') loop(normalise(groan(ctx), 0.7), (t) => groanAt(t));
  if (scene === 'day') {
    add(normalise(distantEngine(ctx, 78, 2.4, false)), 3.5, 0.05);
    add(normalise(distantEngine(ctx, 125, 1.8, false)), 11, 0.045);
    add(normalise(distantEngine(ctx, 36, 3.2, true)), 16.5, 0.04);
  } else if (scene === 'night') {
    add(normalise(distantEngine(ctx, 78, 2.4, false)), 8.5, 0.03);
  } else {
    add(normalise(distantEngine(ctx, 70, 2.2, false)), 1.4, 0.04);
  }
  const spots: [number, string][] = scene === 'night'
    ? [[1.6, 'phrase'], [4.2, 'drunk'], [7.5, 'door'], [11, 'bin'], [14.5, 'bark'], [17.2, 'steps']]
    : scene === 'outbreak'
      ? [[1, 'bird'], [2.6, 'steps'], [4.4, 'laugh'], [6.5, 'bell']]
      : [[1.5, 'bird'], [3.2, 'ring'], [6.4, 'buzz'], [9, 'door'], [11.5, 'ping'], [14.2, 'laugh'], [16.8, 'bell'], [18.6, 'blip']];
  for (const [at, kind] of spots) {
    if (at >= seconds - 0.2) continue;
    const life = lifeAt(at);
    if (life < 0.12) continue;
    const mix = crowdMix(life, day, groanAt(at), 0);
    if (kind === 'bird' && mix.birds < 0.08) continue;
    const made = kind === 'phrase' ? nearPhrase(ctx)
      : kind === 'laugh' ? laugh(ctx)
      : kind === 'callout' ? callout(ctx)
      : kind === 'steps' ? footsteps(ctx)
      : kind === 'door' ? doorClose(ctx)
      : kind === 'bark' ? dogBark(ctx)
      : kind === 'horn' ? carHorn(ctx)
      : kind === 'bell' ? bicycleBell(ctx)
      : kind === 'ring' ? ringtone(ctx, [392, 466, 349, 415])
      : kind === 'buzz' ? phoneBuzz(ctx)
      : kind === 'ping' ? messagePing(ctx)
      : kind === 'blip' ? notifyBlip(ctx)
      : kind === 'drunk' ? drunkShout(ctx)
      : kind === 'bin' ? binClatter(ctx)
      : birdChirp(ctx);
    const weight = kind === 'drunk' || kind === 'bin' ? mix.night : kind === 'ring' || kind === 'buzz' || kind === 'ping' || kind === 'blip' ? mix.phones : mix.life;
    const level = (kind === 'bird' ? 0.028 : kind === 'drunk' ? 0.08 : kind === 'bin' ? 0.055 : kind === 'laugh' || kind === 'callout' || kind === 'phrase' ? 0.065 : kind === 'ring' ? 0.04 : 0.035) * Math.max(weight, scene === 'night' && (kind === 'drunk' || kind === 'bin') ? 0.5 : 0);
    add(normalise(made), at, level);
  }
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < out.length; i++) out[i]! *= 0.9 / max;
  return out;
}

/** The traffic drone alone, peak-normalised. No murmur, pavement, hum, rumble, or one-shots. */
export function renderDroneOnly(seconds = 10, sampleRate = 22050): Float32Array {
  const ctx = previewCtx(sampleRate);
  const drone = normalise(trafficDrone(ctx), 0.9);
  const d = drone.getChannelData(0);
  const out = new Float32Array(Math.ceil(sampleRate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = d[i % d.length]!;
  return out;
}
