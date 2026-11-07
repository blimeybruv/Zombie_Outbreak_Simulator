// Time controls and the status line. The viewer's only levers on time: pause and
// speed. Writes nothing to the simulation; it tells the worker a rate.

import type { FrameSnapshot } from '../worker/protocol';

export interface ControlsOptions {
  speeds: readonly number[];
  ticksPerSecondAt1x: number;
  onRate: (ticksPerSecond: number) => void;
}

function clock(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.floor((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Game time since the outbreak began, as hours:minutes:seconds; the hours run past 24. */
function elapsed(seconds: number): string {
  const s = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

export class Controls {
  private speed: number;
  private paused = true; // the scenario starts paused
  private falling = false; // a fallen city still falling (sim/fall.ts): time is not the viewer's yet
  private readonly status: HTMLElement;
  private readonly buttons = new Map<number, HTMLButtonElement>();
  private readonly playButton: HTMLButtonElement;

  constructor(
    root: HTMLElement,
    private readonly options: ControlsOptions,
  ) {
    this.speed = options.speeds.includes(1) ? 1 : options.speeds[0]!;
    this.playButton = document.createElement('button');
    this.playButton.className = 'play';
    this.playButton.addEventListener('click', () => this.toggle());
    root.append(this.playButton);
    for (const s of options.speeds) {
      const b = document.createElement('button');
      b.textContent = `${s}×`;
      b.addEventListener('click', () => this.setSpeed(s));
      this.buttons.set(s, b);
      root.append(b);
    }
    this.status = document.createElement('span');
    this.status.className = 'status';
    root.append(this.status);
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.toggle();
      }
      const n = Number(e.key);
      if (n >= 1 && n <= options.speeds.length) this.setSpeed(options.speeds[n - 1]!);
    });
    this.refresh();
  }

  toggle(): void {
    if (this.falling) return;
    this.paused = !this.paused;
    this.refresh();
  }

  setSpeed(s: number): void {
    if (this.falling) return;
    this.speed = s;
    this.refresh();
  }

  /** Drops to 1× (and keeps playing) — for events significant enough to pull the viewer back. */
  dropToNormal(): void {
    if (this.speed > 1) this.setSpeed(1);
  }

  get currentSpeed(): number {
    return this.paused ? 0 : this.speed;
  }

  private refresh(): void {
    this.playButton.textContent = this.paused ? '▶' : '❚❚';
    for (const [s, b] of this.buttons) b.classList.toggle('on', s === this.speed);
    this.options.onRate(this.paused ? 0 : this.speed * this.options.ticksPerSecondAt1x);
  }

  show(frame: FrameSnapshot): void {
    // While a fallen city falls the worker runs it flat out whatever is set: the buttons
    // are greyed out rather than seeming to do nothing.
    if (frame.falling !== this.falling) {
      this.falling = frame.falling;
      this.playButton.disabled = this.falling;
      for (const b of this.buttons.values()) b.disabled = this.falling;
    }
    const c = frame.counters;
    const living = c.unturned.outdoors + c.unturned.indoors;
    const dead = c.turned.outdoors + c.turned.occupying;
    const target = this.paused ? 0 : this.speed * this.options.ticksPerSecondAt1x;
    const lag = !this.falling && target > 0 && frame.achievedRate < target * 0.9 ? `  ·  running at ${frame.achievedRate}/s of ${target}` : '';
    this.status.textContent = `${this.falling ? 'falling, as fast as it will go  ·  ' : ''}${WEEKDAYS[frame.weekday]} ${clock(frame.hour)} (${elapsed(frame.sinceOutbreak)} since outbreak)  ·  tick ${frame.tick}  ·  living ${living} (${c.unturned.outdoors} out)  ·  evacuated ${c.unturned.evacuated}  ·  infected ${c.turned.symptomatic}  ·  dead walking ${dead}  ·  lost ${c.unturned.dead + c.turned.destroyed}${lag}`;
  }
}
