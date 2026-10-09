// The roster: promoted survivors, in promotion order. Clicking one centres the
// camera on them and follows. The living are listed at full weight — the current
// cast. The dead and the turned are never un-named, but they collapse into one
// "N lost" line whose names show on hover: a record without crowding the cast.

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
      if (!r.living) continue;
      const b = document.createElement('button');
      b.textContent = r.name;
      b.classList.toggle('on', r.id === tracked);
      b.addEventListener('click', () => this.onSelect(r.id));
      this.root.append(b);
    }
    const lost = frame.roster.filter((r) => !r.living);
    if (lost.length > 0) {
      const line = document.createElement('div');
      line.className = 'lost';
      line.textContent = `${lost.length} lost`;
      const names = document.createElement('div');
      names.className = 'lost-names';
      for (const r of [...lost].reverse()) {
        const n = document.createElement('div');
        n.textContent = r.name;
        names.append(n);
      }
      line.append(names);
      this.root.append(line);
    }
  }
}
