import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { spawnSim } from '../src/sim/spawn';
import type { Building, Sim, World } from '../src/sim/state';
import { evaluateRole } from '../src/sim/systems/buildings/shelter';
import { bite } from '../src/sim/systems/fighting/combat';
import { buildSpeed, buildWaste, groupPeak, turnFactor } from '../src/sim/systems/people/traits';
import { panicRise, seasoned } from '../src/sim/systems/people/panic';
import { computePerception, rebuildHashes } from '../src/sim/systems/shared/perception';

function fresh() {
  return createWorld({ ...defaultScenario, runSeed: 7 }, config);
}

/** Someone aware and calm sheltering in `b`. */
function inside(world: World, b: Building, enclosure: number): Sim {
  const e = b.entrances[0]!;
  const s = spawnSim(world, { x: e.x, y: e.y, insideBuilding: b.id, sourceTag: 'office', initialPanic: 0, destinationKind: null });
  s.archetype = 'civilian';
  s.enclosure = enclosure;
  s.awareAt = 0;
  s.shelter = b.id;
  b.sheltered.push(s.id);
  return s;
}

describe('the four traits', () => {
  it('are mostly near the middle with a few at the ends, each its own', () => {
    const { world } = fresh();
    for (const k of ['company', 'enclosure', 'resilience', 'handiness'] as const) {
      const v = world.sims.map((s) => s[k]);
      const middle = v.filter((x) => x >= 0.4 && x <= 0.6).length / v.length;
      const top = v.filter((x) => x > 0.9).length / v.length;
      expect(middle).toBeGreaterThan(0.5);
      expect(middle).toBeLessThan(0.66);
      expect(top).toBeGreaterThan(0.02);
      expect(top).toBeLessThan(0.06);
    }
    // Independent of one another.
    expect(world.sims.slice(0, 50).some((s) => Math.abs(s.company - s.enclosure) > 0.01)).toBe(true);
  });

  it('scale company, the turn and building as asked: small for the close-knit, longer for the resilient, quicker and sparing for a builder', () => {
    const { world } = fresh();
    const s = world.sims[0]!;
    s.company = 0;
    const few = groupPeak(world, s);
    s.company = 1;
    expect(groupPeak(world, s)).toBeGreaterThan(few);
    s.resilience = 0.5;
    expect(turnFactor(world, s)).toBeCloseTo(1, 9);
    s.resilience = 1;
    expect(turnFactor(world, s)).toBe(config.traits.resilience.turnFactor[1]);
    s.handiness = 1;
    expect(buildSpeed(world, s)).toBeGreaterThan(1);
    expect(buildWaste(world, s)).toBeLessThan(1);
    s.handiness = 0;
    expect(buildSpeed(world, s)).toBeLessThan(1);
    expect(buildWaste(world, s)).toBeGreaterThan(1);
  });

  it('nerve steadies once it has gone grace times: growing used to the dead', () => {
    const { world } = fresh();
    const s = world.sims.find((x) => x.archetype === 'civilian')!;
    s.nerve = 0.4;
    const h = config.nerve.habituation;
    for (let n = 0; n <= h.grace; n++) {
      s.nerveBroken = n;
      expect(seasoned(s, config)).toBe(0.4); // the first times, at full effect
    }
    s.nerveBroken = h.grace + 1;
    expect(seasoned(s, config)).toBeCloseTo(0.4 + 0.6 * h.fade, 9);
    s.nerveBroken = h.grace + 20;
    expect(seasoned(s, config)).toBeGreaterThan(0.99);
    expect(seasoned(s, config)).toBeLessThanOrEqual(1);
  });

  it('the resilient take longer to turn once bitten', () => {
    const turns = (resilience: number) => {
      const { world, ctx } = fresh();
      const s = world.sims.find((x) => x.condition === 'healthy' && x.insideBuilding === null)!;
      s.resilience = resilience;
      sizeContext(ctx, world);
      rebuildHashes(world, ctx);
      bite(world, ctx, s);
      return s.turnsAt! - world.tick;
    };
    expect(turns(1)).toBeGreaterThan(turns(0)); // the same draw, scaled
  });

  it('a diehard claustrophobe who learns of the outbreak indoors goes out; an ordinary one stays', () => {
    const { world, ctx } = fresh();
    const b = world.buildings.find((x) => x.tag === 'residential' && x.zombiesInside === 0)!;
    const ordinary = inside(world, b, 0.5);
    const diehard = inside(world, b, 0.95);
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    computePerception(world, ctx);
    evaluateRole(world, ctx, ordinary);
    evaluateRole(world, ctx, diehard);
    expect(ordinary.exitingUntil).toBeNull();
    expect(diehard.exitingUntil).not.toBeNull();
    expect(diehard.shelter).toBeNull();
  });

  it('the agoraphobic do not go out for supplies', () => {
    const go = (enclosure: number) => {
      const { world, ctx } = fresh();
      const b = world.buildings.find((x) => x.tag === 'residential' && x.zombiesInside === 0 && x.residents > 0)!;
      const shop = world.buildings.find((x) => x.tag === 'supermarket')!;
      b.alertedAt = 0;
      b.supplies = 0;
      const s = inside(world, b, enclosure);
      s.buildingMemory.set(shop.id, { believedOccupants: 0, supplies: shop.supplies, fortification: 0, observedAt: 0, visited: false });
      sizeContext(ctx, world);
      rebuildHashes(world, ctx);
      computePerception(world, ctx);
      evaluateRole(world, ctx, s);
      return s.role;
    };
    expect(go(0.5)).toBe('scavenger');
    expect(go(0)).not.toBe('scavenger');
  });
});

describe('compliance and nerve (the trait review)', () => {
  it('compliance is drawn for everyone, evenly, apart from trust', () => {
    const { world } = fresh();
    const v = world.sims.map((s) => s.compliance);
    expect(v.every((x) => x >= 0 && x <= 1)).toBe(true);
    const low = v.filter((x) => x < 1 / 3).length / v.length;
    expect(low).toBeGreaterThan(0.28);
    expect(low).toBeLessThan(0.39);
    const n = world.sims.length;
    const mt = world.sims.reduce((a, s) => a + s.trust, 0) / n, mc = v.reduce((a, b) => a + b, 0) / n;
    const cov = world.sims.reduce((a, s) => a + (s.trust - mt) * (s.compliance - mc), 0) / n;
    expect(Math.abs(cov)).toBeLessThan(0.01); // independent of trust
  });

  it('the brittle take fright faster than the steady, the trained held up to their floor', () => {
    const s = { nerve: 0, archetype: 'civilian' } as Sim;
    const steady = { nerve: 1, archetype: 'civilian' } as Sim;
    const cop = { nerve: 0, archetype: 'police' } as Sim;
    expect(panicRise(s, config)).toBeCloseTo(config.nerve.panicRise[0], 10);
    expect(panicRise(steady, config)).toBeCloseTo(config.nerve.panicRise[1], 10);
    expect(panicRise(cop, config)).toBeLessThan(panicRise(s, config));
    // The mean over an even spread of nerve is unchanged: the city's panic is redistributed, not raised.
    const [lo, hi] = config.nerve.panicRise;
    expect((lo + hi) / 2).toBeCloseTo(1, 10);
  });
});

