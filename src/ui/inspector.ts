// The inspector: a compact corner panel for whatever the viewer clicked. Never
// modal, nothing in it that is not legible at a glance — if it were rich enough to
// read instead of the map, the map would stop mattering.
//
// A building shows its interior as squares, never as dots on the map: dim white
// for residents, bright white for tracked sims (click through to them) — light blue
// for police and pale green for anyone with a rifle, as on the map — red for
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

/** What each trait means, for the viewer: what they are about to watch it do. */
const TRAITS: Record<string, string> = {
  caution:
    'How much danger they will go out of their way to avoid. The cautious take long detours round streets they believe are bad, the most cautious will not trust a street they know nothing about, and they are slower to open the door to strangers.',
  sociality:
    'How readily they stop to talk and go along with others. Talk is how people learn: about the outbreak, which streets are bad, which buildings are held, who has been bitten.',
  trust:
    'How much they believe what they are told. Sceptics hear news as older than it is, need more people to tell them before they believe in the outbreak, and doubt the radio when it calls everyone out.',
  nerve: 'How much fear they can take before it takes over. When cornered, blocked or run to exhaustion, someone whose nerve goes freezes where they stand.',
};

const ARCHETYPES: Record<string, string> = {
  civilian: 'An ordinary person. Goes home if home is near, goes along with others, and fights only when cornered.',
  loner: 'Keeps to themselves: never goes along with anyone, prefers quiet streets, and picks shelters with fewer people in them.',
  prepper: 'Ready for this. Makes for home from anywhere in the city, and chooses shelters for their walls, their quiet and their supplies.',
  reckless: 'Goes looking for a fight. Will take on the dead in the open and contest a building they have overrun.',
  police: 'A police officer: does not panic, answers calls, runs toward gunfire, and falls back only when outmatched.',
  reservist: 'A reservist: an ordinary person until the call-up, then makes for the armory to draw a rifle and deploy in a squad.',
  'Army Ranger': 'Part of the rescue company: sweeps a corridor up from the exit and sends back anyone it meets.',
  'traffic police': 'A traffic officer: waits at the station until the cordon closes, then sets up a checkpoint on the road out and turns back anyone heading for it.',
  soldier: 'Holds the cordon at a road out of the city. Fires warning shots at anyone who comes near the barrier, and to wound or kill at anyone who comes close.',
};

/** A trait as a word, by fifths of its range; the number stays in the tooltip. */
const WORDS: Record<string, readonly string[]> = {
  caution: ['heedless', 'bold', 'careful', 'cautious', 'very cautious'],
  sociality: ['solitary', 'reserved', 'sociable', 'outgoing', 'gregarious'],
  trust: ['suspicious', 'sceptical', 'open-minded', 'trusting', 'credulous'],
  nerve: ['brittle', 'jumpy', 'steady', 'cool-headed', 'unshakeable'],
};
const WORD_EDGES = [0.15, 0.33, 0.66, 0.85];

function traitWord(name: string, value: number): string {
  let i = 0;
  while (i < WORD_EDGES.length && value >= WORD_EDGES[i]!) i++;
  return WORDS[name]![i]!;
}

function hoursText(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`;
  return h < 1.5 ? 'an hour' : `${Math.round(h)} hours`;
}

const HOW: Record<NonNullable<SimDetail['ending']>['how'], (place: string) => string> = {
  fedOn: (p) => `Killed by the dead on ${p}`,
  breach: (p) => `Killed when the dead broke into ${p}`,
  shot: (p) => `Shot by soldiers getting round the barrier on ${p}`,
  mistaken: (p) => `Shot by the Rangers on ${p}, taken for one of the dead`,
  returned: (p) => `Shot at the cordon on ${p} by someone getting round the barrier`,
  crash: (p) => `Killed in a car crash on ${p}`,
  turned: (p) => `Turned on ${p}`,
  evacuated: (p) => `Got out of the city by ${p}`,
};

function tip(text: string, explanation: string | undefined): HTMLElement {
  const e = el('span', explanation ? 'tip' : undefined, text);
  if (explanation) e.dataset['tip'] = explanation;
  return e;
}

export class Inspector {
  private key = '';
  /** The part that changes rarely (a sim's name and traits), kept in place so a hover on it survives the frame's refresh. */
  private readonly top = el('div');
  private topKey = '';
  /** The part rebuilt whenever anything in it changes. */
  private readonly body = el('div');

  constructor(
    private readonly root: HTMLElement,
    private readonly onSim: (id: number) => void,
  ) {
    for (const part of [this.top, this.body]) part.style.cssText = 'display: flex; flex-direction: column; gap: 3px;';
    root.append(this.top, this.body);
    root.classList.add('idle');
  }

  show(detail: Inspected | null, history: readonly string[]): void {
    const key = JSON.stringify(detail) + history.length;
    if (key === this.key) return;
    this.key = key;
    this.body.replaceChildren();
    this.root.classList.toggle('idle', detail === null);
    if (!detail) {
      this.top.replaceChildren();
      this.topKey = '';
      return;
    }
    if (detail.kind === 'building') {
      this.top.replaceChildren();
      this.topKey = '';
      this.building(detail, history);
    } else this.sim(detail);
  }

  private building(b: BuildingDetail, history: readonly string[]): void {
    const r = this.body;
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
    for (const kind of [null, 'police', 'guard'] as const) {
      const cls = kind === null ? 'tracked' : `tracked ${kind}`;
      const these = b.tracked.filter((t) => t.kind === kind);
      if (per === 1) for (const t of these) add(cls, 1, () => this.onSim(t.id), t.name ?? (kind === 'police' ? 'an officer' : kind === 'guard' ? 'a soldier' : 'a survivor'));
      else add(cls, these.length);
    }
    add('occupier', b.occupiers);
    if (total > 0) r.append(grid);
    if (history.length > 0) {
      const h = el('div', 'history');
      for (const line of history.slice(-6).reverse()) h.append(el('div', undefined, line));
      r.append(h);
    }
  }

  private sim(s: SimDetail): void {
    const topKey = `${s.id}|${s.name}|${s.archetype}`;
    if (topKey !== this.topKey) {
      this.topKey = topKey;
      const traits = el('div', 'sub');
      traits.append(`${words(s.profession)}, ${s.age} · `, tip(s.archetype === 'Army Ranger' ? s.archetype : words(s.archetype), ARCHETYPES[s.archetype]));
      for (const [name, value] of [['caution', s.caution], ['sociality', s.sociality], ['trust', s.trust], ['nerve', s.nerve]] as const) {
        traits.append(' · ', tip(traitWord(name, value), `${TRAITS[name]} (${name[0]!.toUpperCase()}${name.slice(1)} ${value.toFixed(2)}.)`));
      }
      this.top.replaceChildren(el('div', 'head', s.name ?? 'A survivor'), traits);
    }
    const r = this.body;
    // The dead, the turned and those who got out: what happened to them, first and mostly.
    if (s.ending !== null || (s.condition !== 'healthy' && s.condition !== 'infected')) return this.ended(s);
    const truth = [s.condition === 'infected' ? (s.bites > 1 ? `bitten ×${s.bites}` : 'bitten') : s.condition, s.insideBuilding !== null ? 'indoors' : 'outdoors', s.doing ?? '', s.role ? `role: ${s.role}` : ''].filter(Boolean);
    r.append(el('div', s.condition === 'infected' ? 'sub warn' : 'sub', truth.join(' · ')));
    r.append(el('div', 'sub', [s.weapon ? `${s.weapon}${s.ammo > 0 ? ` (${s.ammo})` : ''}` : 'unarmed', s.materials > 0 ? `carrying ${s.materials}` : ''].filter(Boolean).join(' · ')));
    if (s.home) r.append(el('div', 'sub', `lives at ${s.home}`));
    if (s.shelter && s.shelter !== s.home) r.append(el('div', 'sub', `sheltering at ${s.shelter}`));
    r.append(el('div', 'sub dim', `Knows ${s.streetsKnown} streets and ${s.buildingsKnown} buildings, from what they have seen and been told.`));
    const kb = s.knownBitten;
    if (kb.count > 0) {
      const who =
        kb.names.length === 0
          ? `${kb.count === 1 ? 'someone' : `${kb.count} people`}`
          : kb.names.length >= kb.count
            ? kb.names.join(' and ')
            : `${kb.names.join(', ')} and ${kb.count - kb.names.length} more`;
      r.append(el('div', 'sub warn', `Knows ${who} ${kb.count === 1 ? 'has' : 'have'} been bitten, and would turn ${kb.count === 1 ? 'them' : 'them'} away from a shelter.`));
    }
    if (s.thoughts.length > 0) {
      const t = el('div', 'thoughts');
      for (const line of s.thoughts) t.append(el('div', undefined, line));
      r.append(t);
    }
    if (s.backstory) r.append(el('div', 'story', s.backstory));
  }

  /** What happened to someone no longer alive in the city: how, where and when; then the little else that still matters. */
  private ended(s: SimDetail): void {
    const r = this.body;
    const e = s.ending;
    if (e !== null) {
      r.append(el('div', e.how === 'evacuated' ? 'head' : 'sub warn', `${HOW[e.how](e.place)}, ${hoursText(e.hoursIn)} into the outbreak.`));
      if (e.roseAfter !== null) r.append(el('div', 'sub warn', `Got up again ${hoursText(e.roseAfter)} later.`));
    } else r.append(el('div', 'sub warn', s.condition === 'evacuated' ? 'Got out of the city.' : s.condition === 'turned' ? 'Turned.' : 'Dead.'));
    if (s.kills > 0) r.append(el('div', 'sub', `Destroyed ${s.kills} of the dead${s.weapon ? `, with a ${s.weapon}` : ''}.`));
    if (s.home) r.append(el('div', 'sub dim', `Lived at ${s.home}.`));
  }
}
