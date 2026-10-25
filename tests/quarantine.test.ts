import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { sizeContext } from '../src/sim/context';
import { defaultScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/setup';
import { spawnSim } from '../src/sim/spawn';
import type { Building, Sim, World } from '../src/sim/state';
import { holdFor, householdCaution, refusesRunner } from '../src/sim/systems/buildings/quarantine';
import { convertDue } from '../src/sim/systems/dead/infection';
import { bite } from '../src/sim/systems/fighting/combat';
import { rebuildHashes } from '../src/sim/systems/shared/perception';

function fresh() {
  return createWorld({ ...defaultScenario, runSeed: 7 }, config);
}

function person(world: World, b: Building, inside: boolean): Sim {
  const e = b.entrances[0]!;
  const s = spawnSim(world, { x: e.x, y: e.y, insideBuilding: inside ? b.id : null, sourceTag: 'office', initialPanic: 0, destinationKind: null });
  s.archetype = 'civilian';
  s.home = null;
  s.church = null;
  s.awareAt = 0;
  if (inside) {
    s.shelter = b.id;
    b.sheltered.push(s.id);
  }
  return s;
}

/** A house that knows of the outbreak, with nobody tracked inside but `members`. */
function house(world: World): Building {
  const b = world.buildings.find((x) => x.tag === 'residential' && x.zombiesInside === 0 && x.sheltered.length === 0)!;
  b.alertedAt = 0;
  return b;
}

describe('quarantine', () => {
  it('the most cautious inside decides: holds a newcomer for its caution × maxTicks, or nobody if it trusts readily', () => {
    const { world } = fresh();
    const b = house(world);
    const bold = person(world, b, true);
    bold.caution = 0.2;
    bold.trust = 0.2;
    const careful = person(world, b, true);
    careful.caution = 0.9;
    careful.trust = 0.3;
    expect(householdCaution(world, b)).toBe(0.9);
    const stranger = person(world, b, false);
    expect(holdFor(world, stranger, b)).toBe(Math.round(config.quarantine.maxTicks * 0.9));
    careful.trust = 0.9; // the one who decides trusts readily
    expect(holdFor(world, stranger, b)).toBe(0);
  });

  it('holds nobody coming home, or in a house that does not know', () => {
    const { world } = fresh();
    const b = house(world);
    const member = person(world, b, true);
    member.caution = 0.9;
    member.trust = 0.1;
    const coming = person(world, b, false);
    coming.home = b.id;
    expect(holdFor(world, coming, b)).toBe(0);
    b.alertedAt = null;
    expect(holdFor(world, person(world, b, false), b)).toBe(0);
  });

  it('one that turns while held is put out of the door, and the shelter is spared', () => {
    const { world, ctx } = fresh();
    const b = house(world);
    person(world, b, true);
    const s = person(world, b, false);
    sizeContext(ctx, world);
    rebuildHashes(world, ctx);
    bite(world, ctx, s);
    s.insideBuilding = b.id;
    b.sheltered.push(s.id);
    s.quarantinedUntil = world.tick + 100;
    s.turnsAt = world.tick;
    convertDue(world, ctx);
    expect(b.zombiesInside).toBe(0);
    expect(b.breached).toBeNull();
    expect(b.sheltered).not.toContain(s.id);
    const z = world.zombies.find((x) => x.wasSim === s.id)!;
    expect(z.state).toBe('active');
    expect(ctx.map.buildingAt(z.x, z.y)).toBeNull();
    expect(ctx.events.some((e) => e.type === 'quarantineCaught' && e.building === b.id)).toBe(true);
  });

  it('a very cautious household turns away anyone who comes running', () => {
    const { world } = fresh();
    const b = house(world);
    const careful = person(world, b, true);
    careful.caution = 0.9;
    const runner = person(world, b, false);
    runner.gait = 'run';
    expect(refusesRunner(world, runner, b)).toBe(true);
    runner.gait = 'walk';
    expect(refusesRunner(world, runner, b)).toBe(false);
    careful.caution = 0.5;
    runner.gait = 'run';
    expect(refusesRunner(world, runner, b)).toBe(false);
  });
});
