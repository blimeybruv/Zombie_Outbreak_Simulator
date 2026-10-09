// Sound: a readout of the simulation, not a layer beside it. Weapon noise in the
// snapshot is the same stimulus that draws the dead, so the shot you hear is the
// one the horde heard.
//
// Web Audio throughout. Sounds are synthesised into AudioBuffers once at start (no
// assets yet); each shot is a throwaway source node through a stereo panner set
// from its place on screen, a category gain, and the master. The funnel is the
// work: cull what is off screen, play the loudest few per frame, cap voices per
// category, thin above 4× and keep only the loudest at 8×. No per-zombie sounds:
// one looping moan bed whose gain follows how many of the dead are on screen.
//
// Browsers block audio until the viewer interacts; `start` is called on the first
// click or key, and the scenario starts paused anyway.

import type { Camera } from '../render/camera';
import type { FrameSnapshot } from '../worker/protocol';
import { ZOMBIE_AWAKE } from '../worker/protocol';

type Category = 'gun' | 'melee' | 'voice';
const VOICES: Record<Category, number> = { gun: 8, melee: 4, voice: 3 };
const PER_FRAME = { normal: 4, thin: 2, loudestOnly: 1 };
const JITTER = 0.12; // ± half this, in playback rate, so identical shots do not sound synthetic

const CATEGORY: Record<string, Category | undefined> = { pistol: 'gun', smg: 'gun', shotgun: 'gun', club: 'melee', sledgehammer: 'melee', shout: 'voice' };

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
    const y = (Math.random() * 2 - 1) * 0.05 + c * y1 - r * r * y2;
    y2 = y1;
    y1 = y;
    const env = Math.min(1, t / 0.04) * Math.exp(-Math.max(0, t - 0.2) / 0.08);
    d[i] = y * env * 0.6;
  }
  return buf;
}

/** Noise shaped by an envelope and a one-pole low-pass; enough for a gunshot or a thud. */
function burst(ctx: AudioContext, seconds: number, decay: number, cutoff: number, bursts = 1, gap = 0): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(rate * (seconds + gap * (bursts - 1))), rate);
  const d = buf.getChannelData(0);
  const a = Math.exp((-2 * Math.PI * cutoff) / rate);
  for (let b = 0; b < bursts; b++) {
    let y = 0;
    const start = Math.floor(b * gap * rate);
    for (let i = 0; i < seconds * rate && start + i < d.length; i++) {
      const t = i / rate;
      y = (1 - a) * (Math.random() * 2 - 1) + a * y;
      d[start + i]! += y * Math.exp(-t / decay) * 3;
    }
  }
  return buf;
}

/** A low swell of brown noise, slowly breathing: the dead, as a crowd. */
function moan(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = 6;
  const buf = ctx.createBuffer(1, rate * seconds, rate);
  const d = buf.getChannelData(0);
  let y = 0;
  for (let i = 0; i < d.length; i++) {
    y = 0.995 * y + 0.02 * (Math.random() * 2 - 1);
    const t = i / rate;
    const swell = 0.55 + 0.45 * Math.sin((2 * Math.PI * t) / seconds) * Math.sin((2 * Math.PI * 3 * t) / seconds);
    d[i] = y * swell * 2.5;
  }
  return buf;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly gains = new Map<Category | 'bed', GainNode>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly active: Record<Category, number> = { gun: 0, melee: 0, voice: 0 };
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
    for (const [cat, level] of [['gun', 0.5], ['melee', 0.35], ['voice', 0.3], ['bed', 0]] as const) {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(this.master);
      this.gains.set(cat, g);
    }
    this.buffers.set('pistol', burst(ctx, 0.35, 0.05, 2400));
    this.buffers.set('smg', burst(ctx, 0.12, 0.03, 2800, 3, 0.07));
    this.buffers.set('shotgun', burst(ctx, 0.6, 0.11, 1100));
    this.buffers.set('club', burst(ctx, 0.18, 0.04, 260));
    this.buffers.set('sledgehammer', burst(ctx, 0.3, 0.07, 180));
    this.buffers.set('shout', shout(ctx));
    const bed = ctx.createBufferSource();
    bed.buffer = moan(ctx);
    bed.loop = true;
    bed.connect(this.gains.get('bed')!);
    bed.start();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  /** Plays what this frame made audible. Reads the snapshot; writes nothing back. */
  update(frame: FrameSnapshot, cam: Camera, speed: number): void {
    const ctx = this.ctx;
    if (!ctx || this.muted || speed === 0) {
      if (ctx) this.gains.get('bed')!.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
      return;
    }
    const a = cam.toWorld(0, 0), b = cam.toWorld(cam.width, cam.height);
    const onScreen = (x: number, y: number) => x >= a.x && x <= b.x && y >= a.y && y <= b.y;

    // The bed follows the awake dead on screen.
    let dead = 0;
    for (let i = 0; i < frame.zombieKind.length; i++) {
      if (frame.zombieKind[i] === ZOMBIE_AWAKE && onScreen(frame.zombieXY[i * 2]!, frame.zombieXY[i * 2 + 1]!)) dead++;
    }
    const bedLevel = Math.min(0.35, 0.025 * Math.sqrt(dead)) * (speed > 4 ? 0.5 : 1);
    this.gains.get('bed')!.gain.setTargetAtTime(bedLevel, ctx.currentTime, 0.4);

    // One-shots: on screen only, loudest first, a few per frame.
    const budget = speed >= 8 ? PER_FRAME.loudestOnly : speed > 4 ? PER_FRAME.thin : PER_FRAME.normal;
    const heard = frame.noises.filter((n) => CATEGORY[n.kind] && onScreen(n.x, n.y)).sort((p, q) => q.radius - p.radius);
    let played = 0;
    for (const n of heard) {
      if (played >= budget) break;
      const cat = CATEGORY[n.kind]!;
      if (this.active[cat] >= VOICES[cat]) continue;
      this.play(n, cat, cam);
      played++;
    }
  }

  private play(n: { x: number; y: number; kind: string }, cat: Category, cam: Camera): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.get(n.kind)!;
    src.playbackRate.value = 1 + (Math.random() - 0.5) * JITTER;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, (cam.toScreenX(n.x) / cam.width) * 2 - 1));
    const level = ctx.createGain();
    // Nearer the middle of the view is nearer the listener.
    const off = Math.hypot(cam.toScreenX(n.x) - cam.width / 2, cam.toScreenY(n.y) - cam.height / 2) / Math.hypot(cam.width / 2, cam.height / 2);
    level.gain.value = 1 - 0.6 * Math.min(1, off);
    src.connect(level).connect(pan).connect(this.gains.get(cat)!);
    this.active[cat]++;
    src.onended = () => this.active[cat]--;
    src.start();
  }
}
