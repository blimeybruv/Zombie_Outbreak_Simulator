// The end screen: when the run's last tick is reached, the city's totals, and what
// became of those who answered the rescue's broadcast — more of them died on the way
// than got out, as a rule, and that is said rather than buried (rescue.ts rescueTally).

import type { EndSummary } from '../worker/protocol';

function n(x: number): string {
  return x.toLocaleString('en-US');
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
    const tr = end.trust;
    if (tr !== null && tr.doubted > 0 && tr.believed > 0) {
      const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;
      const p = document.createElement('p');
      p.className = 'broadcast';
      p.textContent =
        `Of those still in the city when the broadcast went out, ${pct(tr.doubtedLived, tr.doubted)} of the ${n(tr.doubted)} who doubted the radio lived or got out, ` +
        `against ${pct(tr.believedLived, tr.believed)} of the ${n(tr.believed)} who believed it.`;
      this.root.append(p);
    }
    const l = end.loners;
    if (l.loners > 0 && l.civilians > 0) {
      const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;
      const p = document.createElement('p');
      p.className = 'broadcast';
      p.textContent =
        `Those who kept away from other people did best: ${pct(l.lonersLived, l.loners)} of the ${n(l.loners)} loners lived or got out, ` +
        `against ${pct(l.civiliansLived, l.civilians)} of the ${n(l.civilians)} who went about among others. Crowds draw the dead and fall together.`;
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
