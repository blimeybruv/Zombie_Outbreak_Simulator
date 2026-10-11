// The setup screen: the run's settings, chosen before it starts. Once a run starts
// nothing can be touched but the camera, roster, ticker and time.
//
// Every setting lives in the page address, so a run is reproducible from its address
// alone (the seeds and the settings) and can be shared. Without `start` in the address
// the page shows this panel, prefilled from the address; Start reloads with every
// setting and `start=1`.

import { config } from '../config';
import { defaultScenario } from '../sim/scenario';
import { OUTBREAK_ORIGINS, ZOMBIE_GAITS, type OutbreakOrigin, type Scenario, type ZombieGait } from '../sim/state';

/** What the viewer may set: everything else in a scenario is the defaults'. */
export type Settings = Pick<Scenario, 'population' | 'initialZombies' | 'origin' | 'startHour' | 'zombieGait' | 'power' | 'mapSeed' | 'runSeed'>;

const ORIGIN_WORDS: Record<OutbreakOrigin, string> = { enclosed: 'all in one building', scattered: 'scattered through buildings', street: 'out on the streets' };
const GAIT_WORDS: Record<ZombieGait, string> = { shambler: 'shamblers', runner: 'runners' };

const clamp = (v: number, [lo, hi]: readonly number[]) => Math.min(hi!, Math.max(lo!, v));
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
  return {
    population: Math.round(clamp(num(p, 'population', d.population), s.population)),
    initialZombies: Math.round(clamp(num(p, 'initial', d.initialZombies), s.initialZombies)),
    origin: (OUTBREAK_ORIGINS as readonly string[]).includes(origin ?? '') ? (origin as OutbreakOrigin) : d.origin,
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
      startHour: Number(hour.input.value),
      zombieGait: gait.value as ZombieGait,
      power: power.checked,
      mapSeed: Number(mapSeed.querySelector('input')!.value) || 0,
      runSeed: Number(runSeed.querySelector('input')!.value) || 0,
    };
    location.href = addressFor(chosen, true, params);
  });

  root.append(
    title,
    sub,
    row('Survivors', pop.input, pop.note),
    row('Initial zombies', initial.input, initial.note),
    row('Where they start', origin),
    row('Start hour', hour.input, hour.note),
    row('Zombies', gait),
    row('Power', power),
    row('City', mapSeed),
    row('Run', runSeed),
    start,
  );
}
