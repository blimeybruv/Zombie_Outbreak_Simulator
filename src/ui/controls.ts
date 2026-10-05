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

export class Controls {
  private speed: number;
  private paused = true; // the scenario starts paused
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
    this.paused = !this.paused;
    this.refresh();
  }

  setSpeed(s: number): void {
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
    const c = frame.counters;
    const living = c.unturned.outdoors + c.unturned.indoors;
    const dead = c.turned.outdoors + c.turned.occupying;
    const target = this.paused ? 0 : this.speed * this.options.ticksPerSecondAt1x;
    const lag = target > 0 && frame.achievedRate < target * 0.9 ? `  ·  running at ${frame.achievedRate}/s of ${target}` : '';
    this.status.textContent = `${clock(frame.hour)}  ·  tick ${frame.tick}  ·  living ${living} (${c.unturned.outdoors} out)  ·  dead walking ${dead}  ·  lost ${c.unturned.dead + c.turned.destroyed}${lag}`;
  }
}
