// The inspector: a compact corner panel for whatever the viewer clicked. Never
// modal, nothing in it that is not legible at a glance — if it were rich enough to
// read instead of the map, the map would stop mattering.
//
// A building shows its interior as squares, never as dots on the map: dim white
// for residents, bright white for tracked sims (click through to them), red for
// occupiers. One square each up to 60 people, then one per five with a numeral.

import type { BuildingDetail, Inspected, SimDetail } from '../worker/protocol';

const ONE_EACH_UP_TO = 60;
const GROUP = 5;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function bar(label: string, value: number): HTMLElement {
  const row = el('div', 'bar');
  row.append(el('span', 'label', label));
  const track = el('span', 'track');
  const fill = el('span', 'fill');
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  track.append(fill);
  row.append(track);
  return row;
}

const words = (s: string) => s.replace(/([A-Z])/g, ' $1').toLowerCase();

export class Inspector {
  private key = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly onSim: (id: number) => void,
  ) {}

  show(detail: Inspected | null, history: readonly string[]): void {
    const key = JSON.stringify(detail) + history.length;
    if (key === this.key) return;
    this.key = key;
    this.root.replaceChildren();
    if (!detail) return;
    if (detail.kind === 'building') this.building(detail, history);
    else this.sim(detail);
  }

  private building(b: BuildingDetail, history: readonly string[]): void {
    const r = this.root;
    r.append(el('div', 'head', `${b.what[0]!.toUpperCase()}${b.what.slice(1)}, ${b.street}`));
    r.append(el('div', 'sub', b.district));
    r.append(bar('integrity', b.integrity), bar('fortified', b.fortification));
    const state = [`materials ${b.materials}`, b.garrisoned ? 'held' : '', b.breached ? 'breached' : '', b.occupiers > 0 && b.tracked.length > 0 ? 'contested' : ''].filter(Boolean);
    r.append(el('div', 'sub', state.join(' · ')));
    const total = b.residents + b.tracked.length + b.occupiers;
    const grid = el('div', 'squares');
    const per = total > ONE_EACH_UP_TO ? GROUP : 1;
    const add = (cls: string, n: number, onClick?: () => void, title?: string) => {
      for (let i = 0; i < n; i += per) {
        const sq = el('span', `sq ${cls}`, per > 1 ? String(Math.min(per, n - i)) : undefined);
        if (onClick) {
          sq.classList.add('click');
          sq.addEventListener('click', onClick);
        }
        if (title) sq.title = title;
        grid.append(sq);
      }
    };
    add('resident', b.residents);
    if (per === 1) for (const t of b.tracked) add('tracked', 1, () => this.onSim(t.id), t.name ?? 'a survivor');
    else add('tracked', b.tracked.length);
    add('occupier', b.occupiers);
    if (total > 0) r.append(grid);
    if (history.length > 0) {
      const h = el('div', 'history');
      for (const line of history.slice(-6).reverse()) h.append(el('div', undefined, line));
      r.append(h);
    }
  }

  private sim(s: SimDetail): void {
    const r = this.root;
    r.append(el('div', 'head', s.name ?? 'A survivor'));
    r.append(el('div', 'sub', `${words(s.profession)}, ${s.age} · ${words(s.archetype)} · caution ${s.caution.toFixed(2)}`));
    const truth = [s.condition === 'infected' ? (s.bites > 1 ? `bitten ×${s.bites}` : 'bitten') : s.condition, s.insideBuilding !== null ? 'indoors' : 'outdoors', s.doing ?? '', s.role ? `role: ${s.role}` : ''].filter(Boolean);
    r.append(el('div', s.condition === 'infected' ? 'sub warn' : 'sub', truth.join(' · ')));
    r.append(el('div', 'sub', [s.weapon ? `${s.weapon}${s.ammo > 0 ? ` (${s.ammo})` : ''}` : 'unarmed', s.materials > 0 ? `carrying ${s.materials}` : ''].filter(Boolean).join(' · ')));
    if (s.home) r.append(el('div', 'sub', `lives at ${s.home}`));
    if (s.shelter && s.shelter !== s.home) r.append(el('div', 'sub', `sheltering at ${s.shelter}`));
    r.append(el('div', 'sub dim', `believes: ${s.streetsKnown} streets, ${s.buildingsKnown} buildings, ${s.knownInfected} known bitten`));
    if (s.backstory) r.append(el('div', 'story', s.backstory));
  }
}
