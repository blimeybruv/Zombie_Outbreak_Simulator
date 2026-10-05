// The roster: promoted survivors, in promotion order. Clicking one centres the
// camera on them and follows. The dead and the turned stay on it, dimmed — the
// roster never un-names anyone.

import type { FrameSnapshot } from '../worker/protocol';

export class Roster {
  private key = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly onSelect: (simId: number) => void,
  ) {}

  show(frame: FrameSnapshot, tracked: number | null): void {
    const key = frame.roster.map((r) => `${r.id}${r.living ? '' : '†'}`).join(',') + `|${tracked}`;
    if (key === this.key) return;
    this.key = key;
    this.root.replaceChildren();
    if (frame.roster.length === 0) return;
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'Survivors';
    this.root.append(title);
    for (const r of frame.roster) {
      const b = document.createElement('button');
      b.textContent = r.name;
      b.classList.toggle('gone', !r.living);
      b.classList.toggle('on', r.id === tracked);
      b.addEventListener('click', () => this.onSelect(r.id));
      this.root.append(b);
    }
  }
}
