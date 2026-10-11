import { describe, expect, it } from 'vitest';
import { noteStreet, settleDanger, trim } from '../src/sim/memory';
import type { StreetBelief, StreetId } from '../src/sim/state';

const memory = { quietLook: 0.5, streetCap: 150 };
const street = 3 as StreetId;

describe('street danger is not written symmetrically', () => {
  it('rises at once', () => {
    expect(settleDanger(0.1, 0.9, 0.5)).toBe(0.9);
  });

  it('falls only part of the way on a quiet look, and repeated looks clear it', () => {
    const table = new Map<StreetId, StreetBelief>([[street, { danger: 1, observedAt: 0, visited: false }]]);
    noteStreet(table, street, 0, 100, memory, true);
    expect(table.get(street)!.danger).toBe(0.5);
    expect(table.get(street)!.observedAt).toBe(100);
    for (let t = 0; t < 8; t++) noteStreet(table, street, 0, 200 + t, memory, true);
    expect(table.get(street)!.danger).toBeLessThan(0.01);
  });

  it('keeps visited once set', () => {
    const table = new Map<StreetId, StreetBelief>([[street, { danger: 0, observedAt: 0, visited: true }]]);
    noteStreet(table, street, 1, 5, memory);
    expect(table.get(street)!.visited).toBe(true);
  });
});

describe('trim', () => {
  it('waits for twice the cap, then keeps the newest, ties to the lower key, newest first', () => {
    const table = new Map<number, { observedAt: number }>();
    for (const [k, t] of [[9, 5], [2, 7], [4, 5], [1, -3]] as const) table.set(k, { observedAt: t });
    trim(table, 2);
    expect(table.size).toBe(4);
    table.set(7, { observedAt: 7 });
    trim(table, 2);
    expect([...table.keys()]).toEqual([2, 7]);
    table.set(3, { observedAt: 5 });
    table.set(8, { observedAt: 5 });
    table.set(0, { observedAt: -3 });
    trim(table, 1);
    expect([...table.keys()]).toEqual([2]);
  });
});
