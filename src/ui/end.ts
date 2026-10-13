// The end screen: when the run's last tick is reached, the city's totals, and what
// became of those who answered the rescue's broadcast — more of them died on the way
// than got out, as a rule, and that is said rather than buried (rescue.ts rescueTally).

import type { EndSummary } from '../worker/protocol';

function n(x: number): string {
  return x.toLocaleString('en-GB');
}

export class EndScreen {
  constructor(private readonly root: HTMLElement) {}

  show(end: EndSummary): void {
    this.root.replaceChildren();
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'The end of the run';
    const city = document.createElement('p');
    city.textContent = `Of ${n(end.population)} people: ${n(end.evacuated)} got out of the city, ${n(end.dead)} are dead, ${n(end.turned)} turned, and ${n(end.alive)} are still alive inside.`;
    this.root.append(title, city);
    const r = end.rescue;
    if (r !== null && r.answered > 0) {
      const lost = r.dead + r.turned;
      const p = document.createElement('p');
      p.className = 'broadcast';
      p.textContent =
        `The broadcast told everyone left to make for ${r.place}. ${n(r.answered)} set out. ` +
        `${n(r.out)} got out; ${n(r.dead)} died on the way and ${n(r.turned)} turned; ` +
        `${n(r.waiting)} were still waiting at the barrier when it ended, and ${n(r.elsewhere)} are still out there.` +
        (lost > r.out ? ` It killed more of those who answered it than it saved.` : '');
      this.root.append(p);
    }
    if (end.trucked > 0) {
      const t = document.createElement('p');
      t.className = 'sub';
      t.textContent = `The trucks took ${n(end.trucked)} out in all.`;
      this.root.append(t);
    }
    this.root.hidden = false;
  }
}
