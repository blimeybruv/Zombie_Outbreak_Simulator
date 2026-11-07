// The setup screen: the run's settings, chosen before it starts. Once a run starts
// nothing can be touched but the camera, roster, ticker and time.
//
// Every setting lives in the page address, so a run is reproducible from its address
// alone (the seeds and the settings) and can be shared. Without `start` in the address
// the page shows this panel, prefilled from the address; Start reloads with every
// setting and `start=1`.

import { config } from '../config';
import { defaultScenario } from '../sim/scenario';
import { OUTBREAK_ORIGINS, RUN_STARTS, ZOMBIE_GAITS, type OutbreakOrigin, type RunStart, type Scenario, type ZombieGait } from '../sim/state';

/** What the viewer may set: everything else in a scenario is the defaults'. */
export type Settings = Pick<Scenario, 'population' | 'initialZombies' | 'origin' | 'start' | 'survivors' | 'archetypeMix' | 'homeFirearms' | 'startHour' | 'zombieGait' | 'power' | 'mapSeed' | 'runSeed'>;

const ORIGIN_WORDS: Record<OutbreakOrigin, string> = { enclosed: 'all in one building', scattered: 'scattered through buildings', street: 'out on the streets' };
const GAIT_WORDS: Record<ZombieGait, string> = { shambler: 'shamblers', runner: 'runners' };
const START_WORDS: Record<RunStart, string> = { outbreak: 'the outbreak', fallen: 'a fallen city' };

const clamp = (v: number, [lo, hi]: readonly number[]) => Math.min(hi!, Math.max(lo!, v));

/** The archetype mix with this prepper share, civilians taking up the difference; the defaults' own object when unchanged, so a default run draws exactly as before. */
function withPreppers(share: number): Scenario['archetypeMix'] {
  const d = defaultScenario.archetypeMix;
  if (share === d.prepper) return d;
  return { ...d, prepper: share, civilian: Math.max(0, d.civilian + d.prepper - share) };
}
const num = (p: URLSearchParams, key: string, fallback: number) => {
  const v = Number(p.get(key));
  return p.has(key) && Number.isFinite(v) ? v : fallback;
};

/** The settings in an address, each clamped to its range, defaults for the rest. */
export function settingsFrom(p: URLSearchParams): Settings {
  const s = config.setup;
  const d = defaultScenario;
  const origin = p.get('origin');
  const gait = p.get('zombies');
  const opening = p.get('opening');
  return {
    population: Math.round(clamp(num(p, 'population', d.population), s.population)),
    initialZombies: Math.round(clamp(num(p, 'initial', d.initialZombies), s.initialZombies)),
    origin: (OUTBREAK_ORIGINS as readonly string[]).includes(origin ?? '') ? (origin as OutbreakOrigin) : d.origin,
    // `start` in the address already means "skip this screen": the opening is `opening`.
    start: (RUN_STARTS as readonly string[]).includes(opening ?? '') ? (opening as RunStart) : d.start,
    survivors: Math.round(clamp(num(p, 'left', d.survivors), s.survivors)),
    // In whole percent in the address.
    archetypeMix: withPreppers(clamp(Math.round(num(p, 'preppers', d.archetypeMix.prepper * 100)) / 100, s.preppers)),
    homeFirearms: clamp(Math.round(num(p, 'guns', d.homeFirearms * 100)) / 100, s.homeFirearms),
    startHour: Math.round(clamp(num(p, 'hour', d.startHour), [0, 23])),
    zombieGait: (ZOMBIE_GAITS as readonly string[]).includes(gait ?? '') ? (gait as ZombieGait) : d.zombieGait,
    power: p.has('power') ? p.get('power') !== '0' : d.power,
    mapSeed: Math.max(0, Math.floor(num(p, 'map', d.mapSeed))),
    runSeed: Math.max(0, Math.floor(num(p, 'run', d.runSeed))),
  };
}

/** The address for a run with these settings (`start` to skip this screen). */
export function addressFor(s: Settings, start: boolean, keep: URLSearchParams): string {
  const p = new URLSearchParams(keep);
  p.set('population', String(s.population));
  p.set('initial', String(s.initialZombies));
  p.set('origin', s.origin);
  p.set('opening', s.start);
  p.set('left', String(s.survivors));
  p.set('preppers', String(Math.round(s.archetypeMix.prepper * 100)));
  p.set('guns', String(Math.round(s.homeFirearms * 100)));
  p.set('hour', String(s.startHour));
  p.set('zombies', s.zombieGait);
  p.set('power', s.power ? '1' : '0');
  p.set('map', String(s.mapSeed));
  p.set('run', String(s.runSeed));
  if (start) p.set('start', '1');
  else p.delete('start');
  return `${location.pathname}?${p.toString()}`;
}

function row(label: string, control: HTMLElement, note?: HTMLElement): HTMLElement {
  const r = document.createElement('label');
  r.className = 'row';
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = label;
  r.append(l, control);
  if (note) r.append(note);
  return r;
}

function slider(min: number, max: number, step: number, value: number, show: (v: number) => string): { input: HTMLInputElement; note: HTMLElement } {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const note = document.createElement('span');
  note.className = 'value';
  const update = () => (note.textContent = show(Number(input.value)));
  input.addEventListener('input', update);
  update();
  return { input, note };
}

function select<T extends string>(options: readonly T[], words: Record<T, string>, value: T): HTMLSelectElement {
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = words[o];
    opt.selected = o === value;
    sel.append(opt);
  }
  return sel;
}

function seed(value: number): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'seed';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.value = String(value);
  const dice = document.createElement('button');
  dice.type = 'button';
  dice.textContent = 'random';
  // The page may roll a seed; the simulation never sees anything but the number.
  dice.addEventListener('click', () => (input.value = String(Math.floor(Math.random() * 1_000_000))));
  wrap.append(input, dice);
  return wrap;
}

/** Shows the setup panel in `root`, prefilled from the address. */
export function showSetup(root: HTMLElement, params: URLSearchParams): void {
  const s = settingsFrom(params);
  const c = config.setup;
  root.hidden = false;
  root.replaceChildren();
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = 'Outbreak';
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = 'Set up the city, then watch. Once it starts, nothing can be changed but where you look and how fast time passes.';

  const pop = slider(c.population[0]!, c.population[1]!, c.population[2]!, s.population, (v) => `${v.toLocaleString()} people`);
  const initial = slider(c.initialZombies[0]!, c.initialZombies[1]!, 1, s.initialZombies, (v) => `${v} ${v === 1 ? 'zombie' : 'zombies'}`);
  const origin = select(OUTBREAK_ORIGINS, ORIGIN_WORDS, s.origin);
  const opening = select(RUN_STARTS, START_WORDS, s.start);
  // Separate dials, not one axis (B): preparedness and guns vary apart.
  const preppers = slider(c.preppers[0]! * 100, c.preppers[1]! * 100, 1, Math.round(s.archetypeMix.prepper * 100), (v) => `${v}% preppers`);
  const guns = slider(c.homeFirearms[0]! * 100, c.homeFirearms[1]! * 100, 1, Math.round(s.homeFirearms * 100), (v) => (v === 0 ? 'none at home' : `${v}% armed at home`));
  const left = slider(c.survivors[0]!, c.survivors[1]!, 10, s.survivors, (v) => `${v} left alive`);
  const hour = slider(0, 23, 1, s.startHour, (v) => `${String(v).padStart(2, '0')}:00`);
  const gait = select(ZOMBIE_GAITS, GAIT_WORDS, s.zombieGait);
  const power = document.createElement('input');
  power.type = 'checkbox';
  power.checked = s.power;
  const mapSeed = seed(s.mapSeed);
  const runSeed = seed(s.runSeed);

  const start = document.createElement('button');
  start.className = 'start';
  start.textContent = 'Start';
  start.addEventListener('click', () => {
    const chosen: Settings = {
      population: Number(pop.input.value),
      initialZombies: Number(initial.input.value),
      origin: origin.value as OutbreakOrigin,
      start: opening.value as RunStart,
      survivors: Number(left.input.value),
      archetypeMix: withPreppers(Number(preppers.input.value) / 100),
      homeFirearms: Number(guns.input.value) / 100,
      startHour: Number(hour.input.value),
      zombieGait: gait.value as ZombieGait,
      power: power.checked,
      mapSeed: Number(mapSeed.querySelector('input')!.value) || 0,
      runSeed: Number(runSeed.querySelector('input')!.value) || 0,
    };
    location.href = addressFor(chosen, true, params);
  });

  // A fallen city sets its own first wave (config.fallen.wave), scattered: the viewer
  // chooses how few are left instead.
  const initialRow = row('Initial zombies', initial.input, initial.note);
  const originRow = row('Where they start', origin);
  const leftRow = row('Survivors', left.input, left.note);
  const openingNote = document.createElement('div');
  openingNote.className = 'sub';
  const showOpening = () => {
    const f = opening.value === 'fallen';
    initialRow.hidden = f;
    originRow.hidden = f;
    leftRow.hidden = !f;
    openingNote.hidden = !f;
    openingNote.textContent = 'The outbreak runs from a first wave until only that many are left, and you watch the city fall before taking over.';
  };
  opening.addEventListener('change', showOpening);
  showOpening();

  root.append(
    title,
    sub,
    row('Begin with', opening),
    openingNote,
    row('People', pop.input, pop.note),
    initialRow,
    originRow,
    leftRow,
    row('Preparedness', preppers.input, preppers.note),
    row('Guns', guns.input, guns.note),
    row('Start hour', hour.input, hour.note),
    row('Zombies', gait),
    row('Power', power),
    row('City', mapSeed),
    row('Run', runSeed),
    start,
  );
}
