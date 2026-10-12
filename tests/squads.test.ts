import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { spawnSim, spawnZombie } from '../src/sim/spawn';
import type { Building, Sim, World } from '../src/sim/state';
import { bite } from '../src/sim/systems/combat';
import { computePerception, rebuildHashes } from '../src/sim/systems/perception';
import { simDecisions } from '../src/sim/systems/sims';
import { armAtDepot, mobilise, squadPass } from '../src/sim/systems/squads';

function fresh() {
  const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
  for (const z of world.zombies) if (z.state !== 'occupying') z.state = 'destroyed';
  world.calledUpAt = 0; // the reserve already activated, unless a test says otherwise
  return { world, ctx };
}

function armoury(world: World): Building {
  return world.buildings.find((b) => b.weaponStock !== null)!;
}

/** A reservist standing at a point outdoors, in reserve, its depot `depot`. */
function reservist(world: World, x: number, y: number, depot: Building): Sim {
  const s = spawnSim(world, { x, y, insideBuilding: null, sourceTag: 'office', initialPanic: 0, destinationKind: null });
  s.archetype = 'reservist';
  s.muster = 'reserve';
  s.depot = depot.id;
  s.weapon = null;
  return s;
}

/** Puts `n` reservists armed and waiting inside the armoury. */
function waitingAt(world: World, b: Building, n: number): Sim[] {
  const e = b.entrances[0]!;
  const out: Sim[] = [];
  for (let i = 0; i < n; i++) {
    const s = reservist(world, e.x, e.y, b);
    s.insideBuilding = b.id;
    b.sheltered.push(s.id);
    s.muster = 'mobilised';
    armAtDepot(world, s, b);
    out.push(s);
  }
  return out;
}

function pass(world: World, ctx: ReturnType<typeof fresh>['ctx']): void {
  sizeContext(ctx, world);
  rebuildHashes(world, ctx);
  computePerception(world, ctx);
  squadPass(world, ctx);
}

describe('reservists', () => {
  it('have armouries to go to, spread across the map, and are placed from the residents', () => {
    const { world } = fresh();
    const arms = world.buildings.filter((b) => b.weaponStock !== null);
    expect(arms).toHaveLength(config.reservists.armouries);
    for (const b of arms) expect(b.tag).toBe('depot');
    const r = world.sims.filter((s) => s.archetype === 'reservist');
    expect(r.length).toBeGreaterThan(0.8 * config.reservists.share * defaultScenario.population);
    for (const s of r) {
      expect(s.muster).toBe('reserve');
      expect(arms.map((b) => b.id)).toContain(s.depot);
    }
  });

  it('are called up by a bite they see, not by knowing of the outbreak', () => {
    const { world, ctx } = fresh();
    const b = armoury(world);
    const victim = reservist(world, 1600, 1600, b);
    victim.archetype = 'civilian';
    victim.muster = null;
    const seer = reservist(world, 1605, 1600, b);
    const elsewhere = reservist(world, 2400, 2400, b);
    elsewhere.awareAt = 0;
    pass(world, ctx);
    bite(world, ctx, victim);
    expect(seer.muster).toBe('mobilised');
    expect(elsewhere.muster).toBe('reserve');
  });

  it('are civilians whatever they see until the reserve is called up, once enough 911 calls have come in', () => {
    const { world, ctx } = fresh();
    world.calledUpAt = null;
    const b = armoury(world);
    const victim = reservist(world, 1600, 1600, b);
    victim.archetype = 'civilian';
    victim.muster = null;
    const seer = reservist(world, 1605, 1600, b);
    pass(world, ctx);
    bite(world, ctx, victim);
    expect(seer.muster).toBe('reserve');
    world.callsTaken = config.reservists.callUpCalls;
    pass(world, ctx);
    expect(world.calledUpAt).toBe(world.tick);
    const second = reservist(world, 1600, 1595, b);
    second.archetype = 'civilian';
    second.muster = null;
    pass(world, ctx);
    bite(world, ctx, second);
    expect(seer.muster).toBe('mobilised');
  });

  it('draw a rifle at the depot while any are left, then stand down', () => {
    const { world } = fresh();
    const b = armoury(world);
    b.weaponStock = 1;
    const [first, second] = waitingAt(world, b, 2);
    expect(first!.weapon).toBe('rifle');
    expect(first!.muster).toBe('waiting');
    expect(b.weaponStock).toBe(0);
    expect(second!.muster).toBe('stoodDown');
    expect(second!.weapon).toBeNull();
  });

  it('called up, make for the depot rather than shelter', () => {
    const { world, ctx } = fresh();
    const b = armoury(world);
    const s = reservist(world, 1600, 1600, b);
    s.awareAt = 0;
    mobilise(world, s);
    pass(world, ctx);
    simDecisions(world, ctx);
    expect(s.destinationKind).toBe('muster');
    expect(s.destinationBuilding).toBe(b.id);
  });
});

describe('squads', () => {
  it('form at the threshold, the lowest id leading, and wait inside', () => {
    const { world, ctx } = fresh();
    const b = armoury(world);
    const few = waitingAt(world, b, config.squads.size - 1);
    pass(world, ctx);
    expect(few.every((s) => s.squadLeader === null)).toBe(true);
    const all = [...few, ...waitingAt(world, b, 1)];
    pass(world, ctx);
    expect(all.every((s) => s.squadLeader === all[0]!.id && s.muster === 'deployed')).toBe(true);
    expect(all.map((s) => s.squadSlot)).toEqual(all.map((_, i) => i));
    expect(ctx.events.some((e) => e.type === 'squadFormed')).toBe(true);
    expect(ctx.squadCap[all[0]!.id]).toBeGreaterThan(0);
  });

  it('follow the lowest surviving id when the leader falls, and stand down below two, keeping their weapons', () => {
    const { world, ctx } = fresh();
    const b = armoury(world);
    const all = waitingAt(world, b, config.squads.size);
    pass(world, ctx);
    all[0]!.condition = 'dead';
    pass(world, ctx);
    expect(all.slice(1).every((s) => s.squadLeader === all[1]!.id)).toBe(true);
    for (const s of all.slice(2)) s.condition = 'dead';
    pass(world, ctx);
    expect(all[1]!.squadLeader).toBeNull();
    expect(all[1]!.muster).toBe('stoodDown');
    expect(all[1]!.weapon).toBe('rifle');
  });

  it('walk in file behind the leader, and form a diamond facing the danger when it is in reach', () => {
    const { world, ctx } = fresh();
    const b = armoury(world);
    const all = waitingAt(world, b, config.squads.size);
    pass(world, ctx);
    for (const s of all) {
      s.insideBuilding = null;
      s.x = 1600;
      s.y = 1600;
    }
    b.sheltered = [];
    const leader = all[0]!;
    leader.trail = [{ x: 1590, y: 1600 }, { x: 1594, y: 1600 }, { x: 1597, y: 1600 }];
    pass(world, ctx);
    expect(ctx.slotX[all[1]!.id]).toBeLessThan(1600); // behind, along its path
    expect(leader.diamondUntil).toBeNull();
    spawnZombie(world, 1615, 1600, 'active', null, null);
    pass(world, ctx);
    expect(leader.diamondUntil).not.toBeNull();
    // Slot 1 is the point of the diamond, toward the zombie.
    expect(ctx.slotX[all[1]!.id]).toBeGreaterThan(1600);
  });

  it('a follower kept from its slot makes straight for the leader, after slotPatience', () => {
    const { world, ctx } = fresh();
    const b = armoury(world);
    const all = waitingAt(world, b, 2);
    all.push(...waitingAt(world, b, config.squads.size - 2));
    pass(world, ctx);
    for (const s of all) {
      s.insideBuilding = null;
      s.x = 1600;
      s.y = 1600;
    }
    b.sheltered = [];
    const f = all[1]!;
    f.x = 1600 + config.squads.slotLost + 20;
    for (let t = 0; t <= config.squads.slotPatience; t++) {
      world.tick++;
      pass(world, ctx);
      simDecisions(world, ctx);
      f.x = 1600 + config.squads.slotLost + 20; // held where it is: an unreachable slot
    }
    expect(f.directUntil).not.toBeNull();
  });
});

describe('SWAT', () => {
  it('starts formed at a few stations, with a van at the kerb, and answers no 911 call', () => {
    const { world } = fresh();
    const swat = world.sims.filter((s) => s.station !== null && s.squadLeader !== null);
    const stations = new Set(swat.map((s) => s.station));
    expect(stations.size).toBe(config.swat.stations);
    expect(swat).toHaveLength(config.swat.stations * config.squads.size);
    for (const s of swat) {
      expect(s.archetype).toBe('police');
      expect(s.weapon).toBe(config.swat.weapon);
      expect(s.insideBuilding).toBe(s.station);
    }
    expect(world.cars.filter((c) => c.kind === 'van').every((c) => c.home !== null && stations.has(c.home))).toBe(true);
  });

  it('sets out for an officer\'s radio call, in its van when it is far', () => {
    const { world, ctx } = fresh();
    const leader = world.sims.find((s) => s.station !== null && s.squadLeader === s.id && world.cars.some((c) => c.kind === 'van' && c.home === s.station))!;
    const station = world.buildings[leader.station!]!;
    const door = station.entrances[0]!;
    const far = world.buildings.find((b) => {
      const d = Math.hypot(b.entrances[0]!.x - door.x, b.entrances[0]!.y - door.y);
      return d > config.swat.vanBeyond + 100 && d < config.swat.radius - 100;
    })!;
    const at = far.entrances[0]!;
    world.radios.push({ x: at.x, y: at.y, count: 4, at: world.tick, from: 0 as never, claimedBy: null });
    for (let t = 0; t < 400 && leader.car === null; t++) {
      world.tick++;
      pass(world, ctx);
      simDecisions(world, ctx);
      // Out of the door and on: the building and movement steps, by hand.
      for (const s of world.sims) {
        if (s.squadLeader !== leader.id) continue;
        if (s.insideBuilding !== null && s.exitingUntil !== null && world.tick >= s.exitingUntil) {
          s.insideBuilding = null;
          s.exitingUntil = null;
          s.x = door.x;
          s.y = door.y;
          station.sheltered = station.sheltered.filter((id) => id !== s.id);
        }
      }
      for (const s of world.sims) if (s.squadLeader === leader.id && s.insideBuilding === null && s.car === null) {
        const v = world.cars.find((c) => c.kind === 'van' && c.home === leader.station)!;
        s.x += (v.x - s.x) * 0.5;
        s.y += (v.y - s.y) * 0.5;
      }
    }
    expect(world.radios[0]!.claimedBy).toBe(leader.id);
    expect(leader.car).not.toBeNull();
    const van = world.cars[leader.car!]!;
    expect(van.kind).toBe('van');
    expect(van.occupants).toHaveLength(config.squads.size);
    expect(van.state).toBe('driving');
  });
});

describe('officer radio', () => {
  it('an officer on a call who sees more than its unit can handle radios for SWAT, with what it counted', () => {
    const { world, ctx } = fresh();
    const cop = world.sims.find((s) => s.archetype === 'police' && s.squadLeader === null && s.insideBuilding === null)!;
    cop.answering = world.buildings[0]!.id;
    cop.destinationKind = 'respond';
    cop.destination = { x: cop.x + 200, y: cop.y };
    cop.ammo = 2;
    for (let k = 0; k < 6; k++) spawnZombie(world, cop.x + 8 + k, cop.y + 3, 'active', null, null);
    pass(world, ctx);
    simDecisions(world, ctx);
    expect(world.radios).toHaveLength(1);
    expect(world.radios[0]!.count).toBeGreaterThanOrEqual(6);
    expect(ctx.events.some((e) => e.type === 'policeRadio')).toBe(true);
  });
});
