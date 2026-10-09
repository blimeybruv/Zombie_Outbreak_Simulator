import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/sim/state';
import { line } from '../src/ui/copy';
import { dropsTo1x, Salience } from '../src/ui/salience';
import type { EventNote } from '../src/worker/protocol';

const note = (over: Partial<EventNote> = {}): EventNote => ({
  sim: 1,
  name: null,
  namedFor: null,
  armed: false,
  building: null,
  place: 'Elm Street',
  district: 'Ironside',
  x: 0,
  y: 0,
  ...over,
});
const breach = (tick: number, building: number): SimEvent => ({ type: 'buildingBreached', tick, building: building as never, sim: null });
const turned = (tick: number): SimEvent => ({ type: 'simTurned', tick, sim: 1 as never, zombie: 1 as never, x: 0, y: 0 });

describe('salience', () => {
  it('a promoted survivor turning always makes the ticker, at any speed', () => {
    const s = new Salience();
    expect(s.pass(turned(10), note({ name: 'Ada Kemp' }), 8, false)).toBe('promotedLoss');
  });

  it('an anonymous conversion never does', () => {
    expect(new Salience().pass(turned(10), note(), 1, true)).toBeNull();
  });

  it('rarity: the first breach in a while is news, the tenth in ten minutes is not', () => {
    const s = new Salience();
    expect(s.pass(breach(1, 1), note({ building: 1 }), 1, false)).toBe('buildingBreached');
    for (let i = 2; i <= 9; i++) s.pass(breach(i, i), note({ building: i }), 1, false);
    expect(s.pass(breach(10, 10), note({ building: 10 }), 1, false)).toBeNull();
    // ... and becomes news again once the window has passed.
    expect(s.pass(breach(700, 11), note({ building: 11 }), 1, false)).toBe('buildingBreached');
  });

  it('the bar rises with speed', () => {
    // 40 × 1 × 1 × 1 = 40 clears 1× (bar 10) and 2× (20), not 8× (80).
    expect(new Salience().pass(breach(1, 1), note({ building: 1 }), 2, false)).toBe('buildingBreached');
    expect(new Salience().pass(breach(1, 1), note({ building: 1 }), 8, false)).toBeNull();
  });

  it('a repeat at the same building within the window is not news', () => {
    const s = new Salience();
    expect(s.pass(breach(1, 5), note({ building: 5 }), 1, true)).toBe('buildingBreached');
    expect(s.pass(breach(2000, 6), note({ building: 6 }), 1, true)).toBe('buildingBreached');
    expect(s.pass(breach(2010, 6), note({ building: 6 }), 1, true)).toBeNull();
  });
});

describe('dropping to 1×', () => {
  it('only for a named survivor the viewer has had time to follow, or a cascade', () => {
    expect(dropsTo1x('promotedLoss', note({ name: 'Ada Kemp', namedFor: 60 }))).toBe(false);
    expect(dropsTo1x('promotedLoss', note({ name: 'Ada Kemp', namedFor: 5000 }))).toBe(true);
    expect(dropsTo1x('cascadeCrossed', note())).toBe(true);
    expect(dropsTo1x('buildingBreached', note())).toBe(false);
  });
});

describe('ticker copy', () => {
  it('names promoted survivors and nobody else', () => {
    expect(line(turned(1), note({ name: 'Ada Kemp' }))).toBe('Ada Kemp turned on Elm Street.');
    expect(line(turned(1), note())).toBe('A survivor turned on Elm Street.');
    expect(line({ type: 'buildingRetaken', tick: 1, building: 3 as never, sim: 1 as never }, note({ armed: true, place: 'the gun shop on Elm Street' }))).toBe(
      'An armed survivor cleared the dead out of the gun shop on Elm Street.',
    );
  });
});
