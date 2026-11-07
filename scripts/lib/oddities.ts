// The oddity check: what would look wrong to someone watching, found headless. The
// invariant catches a person lost or made; this catches the rest of what the user kept
// finding by eye — people lapping a block, the dead pressed into a wall short of the
// door, a crowd grinding against the cordon, someone warned off three hundred times.
//
// Harness only: it reads the world after each tick and never writes it. Each finding
// carries a place and a tick, and a link that opens the viewer there (src/main.ts `at`).
//
//   lap         over `window` ticks, a long way walked (pathLong m) within a small
//               place, round something rather than on the spot (spreadMin m), more than
//               once round (lapRatio): not an errand there and back, nor a journey
//   stuck       wanting to move the whole window, and no further than stuckRadius m
//   jitter      the way it moves reversing again and again (reversals in a window)
//   wallPress   the dead besieging a door, pressed against a wall far from it
//   noDoor      the dead besieging a point that is not one of the building's doors
//   repeated    one person the subject of the same event far more than anyone should be
//   freezes     one person frozen with fear again and again

import { isOutdoorLiving, type Context } from '../../src/sim/context';
import type { World } from '../../src/sim/state';
import { running } from '../../src/sim/systems/people/runners';

export const ODDITY = {
  every: 10, // ticks between samples
  window: 600, // ticks a lap, stuck spell or jitter is judged over
  pathLong: 150, // m walked in the window, for a lap
  spreadMin: 8, // m: a lap goes round something, not on the spot
  lapRatio: 8, // m walked per m of spread: once round a circle is 2π; there and back, at most 4
  stuckRadius: 1.5, // m
  reversals: 12, // in one window, for jitter
  reverseMin: 0.4, // m a sample's move must be to count for jitter
  wallFar: 5, // m from its door, against a wall, for wallPress
  wallTouch: 1, // m from a building's outline
  wallTicks: 300, // ticks pressed there
  doorNear: 3, // m from an entrance, for a besieged point to count as a door
  // Most of one event type on one person within `within` ticks, before it is odd; for an
  // event at a building, on one person at the same building (turned away by one door
  // after another is a cautious street, by the same door again and again a loop; by the
  // same door three times in a day, a street it came back to).
  repeated: {
    cordonWarned: { count: 25, within: 64800 },
    strangerRefused: { count: 3, within: 900 },
    quarantineCaught: { count: 2, within: 64800 },
    // A squad's volley wounds on consecutive ticks, one soldier a tick: one occasion, not three.
    cordonWounded: { count: 3, within: 64800, apart: 60 },
  } as Record<string, { count: number; within: number; apart?: number }>,
  freezes: 20,
  quiet: 1800, // ticks before the same agent is reported again for the same kind
};

export type OddityKind = 'lap' | 'stuck' | 'jitter' | 'wallPress' | 'noDoor' | 'repeated' | 'freezes';

export interface Oddity {
  kind: OddityKind;
  /** 'sim 12', 'zombie 40', 'car 7'. */
  who: string;
  tick: number;
  x: number;
  y: number;
  detail: string;
}

interface Track {
  xs: number[];
  ys: number[];
  /** Whether it wanted to move at each sample. */
  moving: boolean[];
  /** Whether it was exempt (battering a door or a car, talking...) at each sample. */
  exempt: boolean[];
  /** Whether it was running supplies (runners.ts) at each sample: to and fro between two doors is its job, not a lap. */
  errand: boolean[];
}

export class OddityCheck {
  readonly found: Oddity[] = [];
  /** Every finding, before `quiet` folds repeats away, by kind. */
  readonly raw: Record<OddityKind, number> = { lap: 0, stuck: 0, jitter: 0, wallPress: 0, noDoor: 0, repeated: 0, freezes: 0 };
  private tracks = new Map<string, Track>();
  private last = new Map<string, number>();
  private pressed = new Map<number, number>();
  private events = new Map<string, number[]>();
  private frozen = new Map<number, number>();
  private wasFrozen = new Set<number>();
  private readonly size = ODDITY.window / ODDITY.every;

  /** After each tick (the events are that tick's). */
  observe(world: World, ctx: Context): void {
    for (const e of world.events) {
      const limit = ODDITY.repeated[e.type];
      if (limit === undefined || !('sim' in e) || e.sim === null) continue;
      const at = 'building' in e ? e.building : null;
      const k = `${e.type}:${e.sim}:${at}`;
      const ticks = (this.events.get(k) ?? []).filter((t) => world.tick - t < limit.within);
      // Within `apart` of the last counted: the same occasion.
      if (limit.apart !== undefined && ticks.length > 0 && world.tick - ticks[ticks.length - 1]! < limit.apart) continue;
      ticks.push(world.tick);
      this.events.set(k, ticks);
      const s = world.sims[e.sim]!;
      const span = limit.within >= world.config.time.runLength ? '' : ` in ${world.tick - ticks[0]!} ticks`;
      if (ticks.length === limit.count) this.report(world, 'repeated', `sim ${e.sim}`, s.x, s.y, `${e.type} ${ticks.length} times${span}${at === null ? '' : ` at building ${at}`}`);
    }
    if (world.tick % ODDITY.every !== 0) return;
    const zc = world.config.zombie;
    for (const s of world.sims) {
      const key = `sim ${s.id}`;
      if (!isOutdoorLiving(s)) {
        this.tracks.delete(key);
        continue;
      }
      const freezing = s.stand === 'freeze';
      if (freezing && !this.wasFrozen.has(s.id)) {
        const n = (this.frozen.get(s.id) ?? 0) + 1;
        this.frozen.set(s.id, n);
        if (n === ODDITY.freezes) this.report(world, 'freezes', key, s.x, s.y, `frozen ${n} times`);
      }
      if (freezing) this.wasFrozen.add(s.id);
      else this.wasFrozen.delete(s.id);
      // Standing about by choice is not stuck: talking, queued, at ease at a post.
      const exempt = s.gathering !== null || s.queuedSince !== null || s.stand !== null || (s.outsider && s.post !== null);
      this.sample(world, key, s.x, s.y, s.gait !== 'still' && s.pace > 0.2, exempt, running(s));
    }
    for (const z of world.zombies) {
      const key = `zombie ${z.id}`;
      if (z.state === 'destroyed' || z.state === 'occupying' || z.state === 'dormant' || z.state === 'feeding') {
        this.tracks.delete(key);
        this.pressed.delete(z.id);
        continue;
      }
      let exempt = false;
      if (z.besieging !== null && z.heardPoint !== null) {
        const b = world.buildings[z.besieging]!;
        const d = Math.hypot(z.heardPoint.x - z.x, z.heardPoint.y - z.y);
        exempt = d <= zc.arriveRadius + ODDITY.doorNear; // battering: back and forth is the point
        if (!b.entrances.some((e) => Math.hypot(e.x - z.heardPoint!.x, e.y - z.heardPoint!.y) <= ODDITY.doorNear)) {
          this.report(world, 'noDoor', key, z.x, z.y, `besieging building ${b.id} at a point ${Math.min(...b.entrances.map((e) => Math.hypot(e.x - z.heardPoint!.x, e.y - z.heardPoint!.y))).toFixed(1)} m from its nearest door`);
        }
        const against = d > ODDITY.wallFar && ctx.map.buildingsNear(z.x, z.y, ODDITY.wallTouch, ctx.buildingIds).length > 0;
        if (against) {
          const since = this.pressed.get(z.id) ?? world.tick;
          this.pressed.set(z.id, since);
          if (world.tick - since >= ODDITY.wallTicks) this.report(world, 'wallPress', key, z.x, z.y, `besieging building ${b.id}, against a wall ${d.toFixed(0)} m from its door for ${world.tick - since} ticks`);
        } else this.pressed.delete(z.id);
      } else this.pressed.delete(z.id);
      // At a car with people in it: battering it (zombies.ts).
      if (!exempt) {
        for (const c of ctx.cars.driving()) {
          if (c.occupants.length > 0 && Math.hypot(c.x - z.x, c.y - z.y) <= world.config.cars.length / 2 + world.config.combat.contactRange + 1) {
            exempt = true;
            break;
          }
        }
      }
      this.sample(world, key, z.x, z.y, (ctx.zombieSpeed[z.id] ?? 0) > 0, exempt);
    }
    for (const c of world.cars) {
      const key = `car ${c.id}`;
      if (c.state !== 'driving') {
        this.tracks.delete(key);
        continue;
      }
      this.sample(world, key, c.x, c.y, false, false);
    }
  }

  private sample(world: World, key: string, x: number, y: number, moving: boolean, exempt: boolean, errand = false): void {
    let t = this.tracks.get(key);
    if (t === undefined) {
      t = { xs: [], ys: [], moving: [], exempt: [], errand: [] };
      this.tracks.set(key, t);
    }
    t.xs.push(x);
    t.ys.push(y);
    t.moving.push(moving);
    t.exempt.push(exempt);
    t.errand.push(errand);
    if (t.xs.length > this.size) {
      t.xs.shift();
      t.ys.shift();
      t.moving.shift();
      t.exempt.shift();
      t.errand.shift();
    }
    if (t.xs.length < this.size || t.exempt.some(Boolean)) return;
    const n = t.xs.length;
    let path = 0;
    let reversals = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      cx += t.xs[i]! / n;
      cy += t.ys[i]! / n;
      if (i === 0) continue;
      const dx = t.xs[i]! - t.xs[i - 1]!, dy = t.ys[i]! - t.ys[i - 1]!;
      const step = Math.hypot(dx, dy);
      path += step;
      if (i >= 2) {
        const px = t.xs[i - 1]! - t.xs[i - 2]!, py = t.ys[i - 1]! - t.ys[i - 2]!;
        const prev = Math.hypot(px, py);
        if (step >= ODDITY.reverseMin && prev >= ODDITY.reverseMin && dx * px + dy * py < -0.5 * step * prev) reversals++;
      }
    }
    let spread = 0;
    for (let i = 0; i < n; i++) spread = Math.max(spread, Math.hypot(t.xs[i]! - cx, t.ys[i]! - cy));
    const net = Math.hypot(t.xs[n - 1]! - t.xs[0]!, t.ys[n - 1]! - t.ys[0]!);
    if (path >= ODDITY.pathLong && spread >= ODDITY.spreadMin && path >= ODDITY.lapRatio * spread && !t.errand.some(Boolean)) {
      this.report(world, 'lap', key, x, y, `${path.toFixed(0)} m walked in ${ODDITY.window} ticks, ${net.toFixed(0)} m from where it began, within ${spread.toFixed(0)} m`);
    } else if (reversals >= ODDITY.reversals) {
      this.report(world, 'jitter', key, x, y, `${reversals} reversals in ${ODDITY.window} ticks`);
    } else if (spread <= ODDITY.stuckRadius && t.moving.every(Boolean)) {
      this.report(world, 'stuck', key, x, y, `trying to move for ${ODDITY.window} ticks, within ${spread.toFixed(1)} m`);
    }
  }

  private report(world: World, kind: OddityKind, who: string, x: number, y: number, detail: string): void {
    this.raw[kind]++;
    const k = `${kind}:${who}`;
    const last = this.last.get(k);
    if (last !== undefined && world.tick - last < ODDITY.quiet) return;
    this.last.set(k, world.tick);
    this.found.push({ kind, who, tick: world.tick, x, y, detail });
  }
}

/** A link that opens the viewer a little before the finding, on its place. */
export function viewerLink(o: Oddity, runSeed: number, mapSeed: number, base = 'http://localhost:5173/'): string {
  return `${base}?start=1&run=${runSeed}&map=${mapSeed}&advance=${Math.max(0, o.tick - ODDITY.window)}&at=${o.x.toFixed(0)},${o.y.toFixed(0)}`;
}

export const ODDITY_KINDS: OddityKind[] = ['lap', 'stuck', 'jitter', 'wallPress', 'noDoor', 'repeated', 'freezes'];

/** Findings close together in place and time (`cell` m, `ODDITY.quiet` ticks), biggest first: a ring round a block, a crowd at a wall. */
export function hotspots(found: readonly Oddity[], cell = 100): Oddity[][] {
  const spots = new Map<string, Oddity[]>();
  for (const o of found) {
    const k = `${Math.floor(o.x / cell)},${Math.floor(o.y / cell)},${Math.floor(o.tick / ODDITY.quiet)}`;
    const v = spots.get(k);
    if (v) v.push(o);
    else spots.set(k, [o]);
  }
  return [...spots.values()].sort((a, b) => b.length - a.length);
}
