import { describe, expect, it } from 'vitest';
import { config as baseConfig, type Config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { spawnSim } from '../src/sim/spawn';
import type { Sim, World } from '../src/sim/state';
import { issueStayHome, orderStands, stayingIn, tellPeopleIn } from '../src/sim/systems/services/orders';
import { simDecisions } from '../src/sim/systems/people/sims';
import { computePerception, rebuildHashes } from '../src/sim/systems/shared/perception';

const on: Config = { ...baseConfig, features: { ...baseConfig.features, stayHome: true, policeOrders: true } };

function fresh(cfg: Config = on) {
  return createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, cfg);
}

/** A calm civilian in a house, on an errand stop. */
function indoors(world: World): Sim {
  const b = world.buildings.find((x) => x.tag === 'residential' && x.zombiesInside === 0)!;
  const e = b.entrances[0]!;
  const s = spawnSim(world, { x: e.x, y: e.y, insideBuilding: b.id, sourceTag: 'office', initialPanic: 0, destinationKind: 'routine' });
  s.archetype = 'civilian';
  s.enclosure = 0.5;
  s.destinationBuilding = b.id;
  s.idleUntil = world.tick - 1; // its stop is over
  return s;
}

describe('stay at home', () => {
  it('goes out once stayHome.calls calls have come in, as a telling believed by trust, compliance rolled once', () => {
    const { world, ctx } = fresh();
    for (const s of world.sims) s.awareAt = null;
    const trusting = world.sims.find((s) => !s.outsider)!;
    const sceptic = world.sims.find((s) => !s.outsider && s !== trusting)!;
    trusting.trust = 1;
    trusting.unease = 0;
    sceptic.trust = 0;
    sceptic.unease = 0;
    world.callsTaken = on.stayHome.calls - 1;
    issueStayHome(world, ctx);
    expect(world.stayHomeAt).toBeNull();
    world.callsTaken = on.stayHome.calls;
    issueStayHome(world, ctx);
    expect(world.stayHomeAt).toBe(world.tick);
    expect(ctx.events.some((e) => e.type === 'stayHomeOrdered')).toBe(true);
    expect(world.sims.filter((s) => !s.outsider).every((s) => s.obeysOrder !== null)).toBe(true);
    expect(trusting.awareAt).not.toBeNull(); // the trusting believe it at once
    expect(sceptic.awareAt).toBeNull(); // a sceptic needs it corroborated
    expect(sceptic.unease).toBeGreaterThan(0);
  });

  it('does not go out with the feature off', () => {
    const { world, ctx } = fresh({ ...baseConfig, features: { ...baseConfig.features, stayHome: false } });
    world.callsTaken = 10_000;
    issueStayHome(world, ctx);
    expect(world.stayHomeAt).toBeNull();
  });

  it('keeps in only the obedient who believe, never police or those who shun shelter, and stands until the broadcast', () => {
    const { world } = fresh();
    const s = indoors(world);
    world.stayHomeAt = world.tick;
    s.awareAt = world.tick;
    s.obeysOrder = true;
    expect(stayingIn(world, s)).toBe(true);
    s.obeysOrder = false;
    expect(stayingIn(world, s)).toBe(false);
    s.obeysOrder = true;
    s.awareAt = null;
    expect(stayingIn(world, s)).toBe(false); // does not believe in the outbreak
    s.awareAt = world.tick;
    s.enclosure = 0.95;
    expect(stayingIn(world, s)).toBe(false); // shuns shelter: the trait, not defiance
    s.enclosure = 0.5;
    s.archetype = 'police';
    expect(stayingIn(world, s)).toBe(false);
    s.archetype = 'civilian';
    world.tick = on.rescue.at + on.rescue.broadcast;
    expect(orderStands(world)).toBe(false); // superseded by the rescue's broadcast
  });

  it('an obedient believer stays where the order found it at the end of an errand stop', () => {
    const run = (obeys: boolean) => {
      const { world, ctx } = fresh();
      const s = indoors(world);
      world.stayHomeAt = world.tick;
      s.awareAt = world.tick;
      s.obeysOrder = obeys;
      sizeContext(ctx, world);
      rebuildHashes(world, ctx);
      computePerception(world, ctx);
      simDecisions(world, ctx);
      return s;
    };
    const kept = run(true);
    expect(kept.exitingUntil).toBeNull();
    expect(kept.shelter).toBe(kept.insideBuilding);
    expect(kept.destinationKind).toBe('shelter');
  });

  it('an officer on patrol goes to someone on the street and tells them to go in', () => {
    const { world, ctx } = fresh();
    world.stayHomeAt = world.tick;
    const street = world.streets.find((st) => st.terrain === 'standard')!;
    const a = world.nodes[street.a]!;
    const officer = spawnSim(world, { x: a.x, y: a.y, insideBuilding: null, sourceTag: 'policeStation', initialPanic: 0, destinationKind: 'routine' });
    officer.archetype = 'police';
    officer.awareAt = 0;
    const walker = spawnSim(world, { x: a.x + 2, y: a.y, insideBuilding: null, sourceTag: 'office', initialPanic: 0, destinationKind: 'routine' });
    walker.archetype = 'civilian';
    walker.awareAt = null;
    walker.trust = 0;
    walker.unease = 0;
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    tellPeopleIn(world, ctx, officer);
    expect(walker.orderedInAt).toBe(world.tick);
    expect(walker.toldBy.has(officer.id)).toBe(true); // a telling from the officer: the order heard twice
  });
});
