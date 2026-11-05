import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import type { SimEvent } from '../src/sim/state';
import { Director } from '../src/ui/director';
import { SIM_LIVING, ZOMBIE_AWAKE, type EventNote, type FrameSnapshot } from '../src/worker/protocol';

/** A frame with one person and one of the dead, each placed (or hidden with null). */
function frame(tick: number, person: [number, number] | null, dead: [number, number] | null): FrameSnapshot {
  return {
    tick,
    simKind: Uint8Array.of(person ? SIM_LIVING : 0),
    simXY: Float32Array.of(person?.[0] ?? 0, person?.[1] ?? 0),
    simFlags: Uint8Array.of(0),
    zombieKind: Uint8Array.of(dead ? ZOMBIE_AWAKE : 0),
    zombieXY: Float32Array.of(dead?.[0] ?? 0, dead?.[1] ?? 0),
  } as unknown as FrameSnapshot;
}

function note(x: number, y: number, sim: number | null): EventNote {
  return { sim, name: null, namedFor: null, armed: false, building: 1, place: 'here', district: 'there', x, y } as EventNote;
}

/** An event the ticker weighs at least director.minWeight. */
const breach = { type: 'buildingBreached', tick: 0, building: 1, sim: null } as unknown as SimEvent;

describe('the director', () => {
  const dc = config.director;

  it('does nothing until it is turned on', () => {
    const d = new Director();
    d.offer([breach], [note(100, 100, null)], 0);
    expect(d.update(frame(1, [100, 100], [102, 100]))).toBeNull();
  });

  it('goes to what happened, stays while the dead and the living are both there, and moves on a little after it is over', () => {
    const d = new Director();
    d.enable(true);
    d.offer([breach], [note(100, 100, null)], 0);
    expect(d.update(frame(1, [100, 100], [104, 100]))).not.toBeNull();
    expect(d.focus()).toBe('buildingBreached');
    // Danger past the least it stays: still there.
    for (let t = 2; t <= dc.minTicks + 50; t++) d.update(frame(t, [100, 100], [104, 100]));
    expect(d.focus()).toBe('buildingBreached');
    // Over (the dead gone): it lingers `after` ticks, then looks elsewhere.
    const end = dc.minTicks + 50;
    d.offer([breach], [note(900, 900, null)], end);
    for (let t = end + 1; t < end + dc.after; t++) d.update(frame(t, [100, 100], null));
    expect(d.scene?.ax).toBe(100);
    d.update(frame(end + dc.after + 1, [100, 100], null));
    expect(d.scene?.ax).toBe(900);
  });

  it('follows its person, and moves on soon after losing them', () => {
    const d = new Director();
    d.enable(true);
    d.offer([breach], [note(100, 100, 0)], 0);
    d.update(frame(1, [100, 100], [104, 100]));
    const to = d.update(frame(2, [130, 100], [134, 100]));
    expect(to?.x).toBe(130); // with them
    let t = dc.minTicks;
    d.offer([breach], [note(900, 900, null)], t);
    // Gone indoors (or dead): the scene ends a third of `after` later, danger or not.
    for (; t < dc.minTicks + dc.after / 3; t++) d.update(frame(t, null, [134, 100]));
    d.update(frame(t + 1, null, [134, 100]));
    expect(d.scene?.ax).toBe(900);
  });
});
