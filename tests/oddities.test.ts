import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { ODDITY, OddityCheck, viewerLink } from '../scripts/lib/oddities';

/** A world with one person outdoors, walking, whose position the test sets by hand each tick. */
function walker() {
  const { world, ctx } = createWorld({ ...defaultScenario, origin: 'enclosed', initialZombies: 1, runSeed: 7 }, config);
  const s = world.sims.find((x) => x.condition === 'healthy' && x.insideBuilding === null && x.car === null && !x.outsider)!;
  s.gait = 'walk';
  s.pace = 1;
  s.gathering = null;
  s.stand = null;
  return { world, ctx, s };
}

describe('the oddity check', () => {
  it('finds someone walking round and round the same block', () => {
    const { world, ctx, s } = walker();
    const check = new OddityCheck();
    const cx = s.x, cy = s.y, r = 15;
    for (let t = 0; t < ODDITY.window * 2; t++) {
      world.tick++;
      const a = (t * 1.2) / r; // 1.2 m a tick round a 15 m circle
      s.x = cx + r * Math.cos(a);
      s.y = cy + r * Math.sin(a);
      check.observe(world, ctx);
    }
    const lap = check.found.find((o) => o.kind === 'lap' && o.who === `sim ${s.id}`);
    expect(lap).toBeDefined();
    expect(viewerLink(lap!, 7, 1)).toContain(`at=${lap!.x.toFixed(0)},${lap!.y.toFixed(0)}`);
  });

  it('does not take an errand there and back for a lap', () => {
    const { world, ctx, s } = walker();
    const check = new OddityCheck();
    const x0 = s.x;
    for (let t = 0; t < ODDITY.window * 2; t++) {
      world.tick++;
      const k = t % ODDITY.window;
      s.x = x0 + (k < ODDITY.window / 2 ? k : ODDITY.window - k) * 0.5; // out 150 m and back
      check.observe(world, ctx);
    }
    expect(check.found.filter((o) => o.who === `sim ${s.id}` && o.kind === 'lap')).toHaveLength(0);
  });

  it('finds someone trying to move who gets nowhere, and not someone standing still by choice', () => {
    const { world, ctx, s } = walker();
    const check = new OddityCheck();
    for (let t = 0; t < ODDITY.window + ODDITY.every; t++) {
      world.tick++;
      s.x += t % 2 === 0 ? 0.1 : -0.1;
      check.observe(world, ctx);
    }
    expect(check.found.some((o) => o.kind === 'stuck' && o.who === `sim ${s.id}`)).toBe(true);
    const still = walker();
    still.s.gait = 'still';
    const quiet = new OddityCheck();
    for (let t = 0; t < ODDITY.window + ODDITY.every; t++) {
      still.world.tick++;
      quiet.observe(still.world, still.ctx);
    }
    expect(quiet.found.some((o) => o.who === `sim ${still.s.id}`)).toBe(false);
  });
});
