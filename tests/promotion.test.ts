import { describe, expect, it } from 'vitest';
import { config as baseConfig, type Config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { SCORED, rankByUnusualness, scoreLiving, updatePromotion } from '../src/sim/systems/promotion';
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

  const livingNamed = (w: typeof world, ids: number[]) =>
    ids.filter((id) => w.sims[id]!.condition === 'healthy' || w.sims[id]!.condition === 'infected').length;

  it('the re-score only adds, and tops the living cast back up to count', () => {
    const before = at(899);
    const after = at(900);
    expect(after.roster.slice(0, before.roster.length)).toEqual(before.roster);
    expect(after.names.slice(0, before.names.length)).toEqual(before.names);
    expect(world.rescoredAt).toBe(900);
    expect(livingNamed(world, after.roster)).toBeGreaterThanOrEqual(config.promotion.count);
  });

  it('records when each was named', () => {
    for (const id of at(400).roster) expect(world.sims[id]!.namedAt).toBe(400);
    for (const id of world.roster) expect(world.sims[id]!.namedAt).not.toBeNull();
  });

  it('keeps topping up as the named die, on its cadence, never un-naming anyone', () => {
    const { world: w } = runTo(1000);
    const roster = [...w.roster];
    // Two of the living named die (ground truth only; this test does not step the run).
    const lost = roster.filter((id) => w.sims[id]!.condition === 'healthy').slice(0, 2);
    for (const id of lost) w.sims[id]!.condition = 'dead';
    const living = livingNamed(w, roster);
    w.tick = w.rescoredAt! + config.promotion.final.topUpEvery - 1;
    updatePromotion(w);
    expect(w.roster).toEqual(roster); // off-cadence: nothing
    w.tick++;
    updatePromotion(w);
    expect(w.roster.slice(0, roster.length)).toEqual(roster);
    expect(livingNamed(w, w.roster)).toBe(Math.max(living, config.promotion.count));
    for (const id of lost) expect(w.sims[id]!.name).not.toBeNull();
  }, 60_000);

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
