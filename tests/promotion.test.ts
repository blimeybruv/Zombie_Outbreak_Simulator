import { describe, expect, it } from 'vitest';
import { config as baseConfig, type Config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { SCORED, rankByUnusualness, scoreLiving } from '../src/sim/systems/promotion';
import { step } from '../src/sim/tick';

// Early fallbacks so both stages fire within a short run.
const config: Config = structuredClone(baseConfig);
config.promotion.provisional.fallbackTick = 400;
config.promotion.final.fallbackTick = 900;

function runTo(ticks: number, snapshots: number[] = []) {
  const { world, ctx } = createWorld({ ...defaultScenario, runSeed: 4 }, config);
  const rosters: { tick: number; roster: number[]; names: (string | null)[] }[] = [];
  while (world.tick < ticks) {
    step(world, ctx, { checkInvariant: true });
    if (snapshots.includes(world.tick)) {
      rosters.push({ tick: world.tick, roster: [...world.roster], names: world.roster.map((id) => world.sims[id]!.name) });
    }
  }
  return { world, rosters };
}

describe('promotion', () => {
  const { world, rosters } = runTo(1000, [399, 400, 899, 900, 1000]);
  // (The shared run above happens at collection time, outside any test timeout.)
  const at = (t: number) => rosters.find((r) => r.tick === t)!;

  it('names nobody before the provisional stage', () => {
    expect(at(399).roster).toEqual([]);
    expect(world.sims.some((s) => s.name !== null && !world.roster.includes(s.id))).toBe(false);
  });

  it('names the most unusual dozen at the provisional stage', () => {
    expect(at(400).roster).toHaveLength(config.promotion.count);
    expect(world.promotedAt).toBe(400);
  });

  it('only adds at the re-score: nobody is un-named and earlier names never change', () => {
    const before = at(899);
    const after = at(900);
    expect(after.roster.slice(0, before.roster.length)).toEqual(before.roster);
    expect(after.names.slice(0, before.names.length)).toEqual(before.names);
    expect(after.roster.length).toBeGreaterThanOrEqual(before.roster.length);
    expect(after.roster.length).toBeLessThanOrEqual(2 * config.promotion.count);
    expect(world.rescoredAt).toBe(900);
  });

  it('does nothing after both stages', () => {
    expect(at(1000).roster).toEqual(at(900).roster);
  });

  it('gives every promoted survivor a unique name', () => {
    const names = world.roster.map((id) => world.sims[id]!.name);
    expect(names.every((n) => n !== null && n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('ranks the living only, and not the already bitten unless configured to', () => {
    const ranked = rankByUnusualness(world);
    expect(ranked.every((s) => s.condition === 'healthy')).toBe(true);
    expect(ranked.length).toBe(world.sims.filter((s) => s.condition === 'healthy').length);
  });

  it('caps each counter and leaves unscored ones out', () => {
    const scored = scoreLiving(world);
    const streets = SCORED.indexOf('streetsVisited');
    for (const e of scored.slice(0, 50)) {
      const expected = e.z.reduce((sum, z, i) => (i === streets ? sum : sum + Math.min(config.promotion.zCap, Math.abs(z))), 0);
      expect(e.score).toBeCloseTo(expected, 9);
    }
  });

  it('is deterministic', () => {
    expect(runTo(1000).world.roster).toEqual(world.roster);
  }, 60_000);
});
