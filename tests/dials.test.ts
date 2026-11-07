import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';

describe('guns at home', () => {
  it('arms that share of those not already armed, and none when the dial is down', () => {
    const armed = (share: number) => {
      const { world } = createWorld({ ...defaultScenario, population: 2000, homeFirearms: share, runSeed: 5 }, config);
      const eligible = world.sims.filter((s) => s.archetype !== 'police' && s.archetype !== 'reservist' && s.archetype !== 'reckless' && !s.outsider);
      return eligible.filter((s) => s.weapon === 'pistol' || s.weapon === 'shotgun').length / eligible.length;
    };
    expect(armed(0)).toBe(0);
    expect(armed(0.3)).toBeGreaterThan(0.25);
    expect(armed(0.3)).toBeLessThan(0.35);
  });
});

