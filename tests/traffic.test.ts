import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { barrierAt } from '../src/sim/systems/outside/cordon';
import { headForExit } from '../src/sim/systems/outside/exits';
import { rebuildHashes } from '../src/sim/systems/shared/perception';
import { squadTarget } from '../src/sim/systems/services/squads';
import { parkingSpot, updateTraffic } from '../src/sim/systems/services/traffic';
import { assertInvariant } from '../src/sim/tick';
import { spawnSim } from '../src/sim/spawn';
import type { Sim } from '../src/sim/state';

function fresh() {
  const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
  return { world, ctx };
}

describe('traffic police', () => {
  it('place a checkpoint on each exit’s road, inside the barrier, and a unit at a station for each, without moving the counters', () => {
    const { world } = fresh();
    expect(world.checkpoints).toHaveLength(world.exits.length);
    for (const [k, c] of world.checkpoints.entries()) {
      const e = world.exits[c.exit!]!;
      const b = barrierAt(world, e);
      expect((c.x - b.x) * e.dx + (c.y - b.y) * e.dy).toBeLessThan(0); // on the city side
      const unit = world.sims.filter((s) => s.checkpoint === k);
      expect(unit).toHaveLength(config.traffic.officers);
      expect(unit.every((s) => s.archetype === 'police' && s.station !== null && s.insideBuilding === s.station && s.squadLeader === unit[0]!.id)).toBe(true);
    }
    assertInvariant(world);
  });

  it('wait until the first barrier closes, then make for their checkpoint', () => {
    const { world, ctx } = fresh();
    const leader = world.sims.find((s) => s.checkpoint === 0 && s.squadLeader === s.id)!;
    updateTraffic(world, ctx);
    expect(world.checkpointsAt).toBeNull();
    expect(squadTarget(world, ctx, leader)).toBeNull();
    world.exits[0]!.closedAt = world.tick;
    updateTraffic(world, ctx);
    expect(world.checkpointsAt).toBe(world.tick);
    const t = squadTarget(world, ctx, leader)!;
    const p = parkingSpot(world, world.checkpoints[0]!, false);
    expect([t.x, t.y]).toEqual([p.x, p.y]);
    // Parked behind the sawhorses, on the exit's side, clear of them: the line faces the city.
    const c = world.checkpoints[0]!;
    expect((p.x - c.x) * c.dx + (p.y - c.y) * c.dy).toBeGreaterThan(config.cars.length / 2);
  });

  it('set, turn back anyone on foot making for their exit; with none of the unit left there, fall for good', () => {
    const { world, ctx } = fresh();
    world.exits[0]!.closedAt = world.tick;
    updateTraffic(world, ctx);
    const c = world.checkpoints[0]!;
    const unit = world.sims.filter((s) => s.checkpoint === 0);
    for (const s of unit) {
      world.buildings[s.insideBuilding!]!.sheltered = world.buildings[s.insideBuilding!]!.sheltered.filter((id) => id !== s.id);
      s.insideBuilding = null;
      s.x = c.x;
      s.y = c.y;
    }
    unit[0]!.post = { x: c.x, y: c.y };
    const walker = world.sims.find((s) => s.condition === 'healthy' && s.insideBuilding === null && s.archetype !== 'police')!;
    walker.x = c.x - c.dx * 5;
    walker.y = c.y - c.dy * 5;
    world.rescueExit = 0;
    headForExit(world, walker);
    world.rescueExit = null;
    expect(walker.destinationKind).toBe('leave');
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    updateTraffic(world, ctx);
    expect(c.setAt).toBe(world.tick);
    world.tick += config.traffic.every - (world.tick % config.traffic.every); // its turn to check
    updateTraffic(world, ctx);
    expect(walker.knownClosed & 1).toBe(1);
    const e = world.exits[0]!;
    expect(walker.destinationKind !== 'leave' || walker.destination!.x !== e.x || walker.destination!.y !== e.y).toBe(true);
    for (const s of unit) {
      s.x += 500;
      s.y += 0;
    }
    world.tick++;
    updateTraffic(world, ctx);
    expect(c.fallenAt).toBe(world.tick);
    expect(unit.every((s) => s.checkpoint === null)).toBe(true);
  });

  it('reservist squads each claim a checkpoint no other reservist squad has, once ordered, and drive out in their armoury’s HMMWV', () => {
    const { world, ctx } = fresh();
    const armoury = world.buildings.find((b) => b.weaponStock !== null)!;
    expect(world.cars.filter((c) => c.kind === 'hmmwv' && c.home === armoury.id)).toHaveLength(config.reservists.hmmwvs);
    // Two squads of reservists, formed at the armoury.
    const e = armoury.entrances[0]!;
    const squads: Sim[][] = [];
    for (let q = 0; q < 2; q++) {
      const g: Sim[] = [];
      for (let i = 0; i < config.squads.size; i++) {
        const m = spawnSim(world, { x: e.x, y: e.y, insideBuilding: armoury.id, sourceTag: 'office', initialPanic: 0, destinationKind: null });
        m.archetype = 'reservist';
        m.muster = 'deployed';
        m.depot = armoury.id;
        m.weapon = 'rifle';
        m.ammo = 20;
        armoury.sheltered.push(m.id);
        g.push(m);
      }
      for (const [i, m] of g.entries()) {
        m.squadLeader = g[0]!.id;
        m.squadSlot = i;
      }
      squads.push(g);
    }
    expect(squadTarget(world, ctx, squads[0]![0]!)).toBeNull(); // nothing ordered yet: it waits
    world.checkpointsAt = world.tick;
    for (const c of world.checkpoints) c.orderedAt = world.tick;
    const a = squadTarget(world, ctx, squads[0]![0]!)!;
    const b = squadTarget(world, ctx, squads[1]![0]!)!;
    const ka = squads[0]![0]!.checkpoint!, kb = squads[1]![0]!.checkpoint!;
    expect(ka).not.toBeNull();
    expect(kb).not.toBe(ka);
    expect(squads[0]!.every((m) => m.checkpoint === ka)).toBe(true);
    const pa = parkingSpot(world, world.checkpoints[ka]!, true), pb = parkingSpot(world, world.checkpoints[kb]!, true);
    expect([a.x, a.y]).toEqual([pa.x, pa.y]);
    expect([b.x, b.y]).toEqual([pb.x, pb.y]);
    // Beside where the police cruiser parks, not on it.
    const pc = parkingSpot(world, world.checkpoints[ka]!, false);
    expect(Math.hypot(pa.x - pc.x, pa.y - pc.y)).toBeGreaterThanOrEqual(config.traffic.parkAside - 1e-9);
  });

  it('a fallen checkpoint is set again by reservists reaching it', () => {
    const { world, ctx } = fresh();
    world.checkpointsAt = world.tick;
    for (const c of world.checkpoints) c.orderedAt = world.tick;
    const c = world.checkpoints[0]!;
    c.setAt = 0;
    c.fallenAt = 0;
    for (const s of world.sims) if (s.checkpoint === 0) s.checkpoint = null;
    const r = world.sims.find((s) => s.condition === 'healthy' && s.insideBuilding === null)!;
    r.archetype = 'reservist';
    r.checkpoint = 0;
    r.squadLeader = r.id;
    r.post = { x: c.x, y: c.y };
    r.x = c.x;
    r.y = c.y;
    world.tick++;
    updateTraffic(world, ctx);
    expect(c.fallenAt).toBeNull();
    expect(c.setAt).toBe(world.tick);
    expect(ctx.events.some((e) => e.type === 'checkpointSet' && e.by === 'reservists')).toBe(true);
  });

  it('when the first district evacuates, set checkpoints where its roads leave it, manned by first responders, that let its evacuees through and turn others back', () => {
    const { world, ctx } = fresh();
    const d = world.districts[0]!;
    const before = world.checkpoints.length;
    const centre = world.buildings.find((b) => b.district === d.id)!.entrances[0]!;
    ctx.events.push({ type: 'districtEvacuating', tick: world.tick, district: d.id, first: true, sim: null, x: centre.x, y: centre.y });
    updateTraffic(world, ctx);
    const added = world.checkpoints.slice(before);
    expect(added.length).toBeGreaterThan(0);
    expect(added.length).toBeLessThanOrEqual(config.traffic.evacCheckpoints);
    for (const c of added) {
      expect(c.exit).toBeNull();
      expect(c.district).toBe(d.id);
      expect(c.orderedAt).toBe(world.tick);
    }
    const k = before;
    const unit = world.sims.filter((s) => s.checkpoint === k);
    expect(unit.length).toBe(config.traffic.officers);
    expect(unit.every((s) => s.archetype === 'police' && s.station !== null && s.squadLeader === unit[0]!.id)).toBe(true);
    // Set, with two people making for a way out beside it: the district's evacuee goes on, the other is turned back.
    const c = world.checkpoints[k]!;
    c.setAt = world.tick;
    for (const s of unit) {
      world.buildings[s.insideBuilding!]!.sheltered = world.buildings[s.insideBuilding!]!.sheltered.filter((id) => id !== s.id);
      s.insideBuilding = null;
      s.x = c.x;
      s.y = c.y;
    }
    const [evacuee, other] = world.sims.filter((s) => s.condition === 'healthy' && s.insideBuilding === null && s.archetype !== 'police' && s.checkpoint === null);
    for (const s of [evacuee!, other!]) {
      s.x = c.x - c.dx * 3;
      s.y = c.y - c.dy * 3;
      headForExit(world, s);
    }
    evacuee!.evacuatedFrom = d.id;
    const exitOf = (s: Sim) => world.exits.findIndex((e) => Math.hypot(e.x - s.destination!.x, e.y - s.destination!.y) <= 1);
    const was = exitOf(other!);
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    world.tick += config.traffic.every - ((world.tick + k) % config.traffic.every);
    updateTraffic(world, ctx);
    expect(evacuee!.destinationKind).toBe('leave');
    expect(evacuee!.knownClosed).toBe(0);
    expect(other!.knownClosed & (1 << was)).not.toBe(0);
  });
});
