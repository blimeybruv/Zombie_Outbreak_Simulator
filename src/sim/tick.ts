// The tick, in its fixed order. Order decides behaviour: perception is computed
// once into a read-only snapshot, every agent decides against it, and positions
// change only in movement integration.

import { sizeContext, type Context } from './context';
import { populationTotal } from './state';
import { recount } from './counters';
import type { Counters, World } from './state';
import { buildingProcesses } from './systems/buildings';
import { resolveCombat } from './systems/combat';
import { resolveEncounters } from './systems/encounters';
import { convertDue } from './systems/infection';
import { integrateMovement } from './systems/movement';
import { updatePanic } from './systems/panic';
import { computePerception, rebuildHashes } from './systems/perception';
import { simDecisions } from './systems/sims';
import { expireStimuli } from './systems/stimuli';
import { zombieDecisions } from './systems/zombies';

export interface StepOptions {
  /** Recount every leaf from entity state and assert the invariant. Harness only. */
  checkInvariant: boolean;
  /**
   * Called after each stage with its name. The simulation never reads the clock;
   * a profiler passes a probe that does.
   */
  probe?: (stage: string) => void;
}

export class InvariantError extends Error {}

function leavesEqual(a: Counters, b: Counters): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function assertInvariant(world: World): void {
  const actual = recount(world);
  if (!leavesEqual(actual, world.counters)) {
    throw new InvariantError(
      `tick ${world.tick}: counters drifted from entity state\n  counters ${JSON.stringify(world.counters)}\n  recount  ${JSON.stringify(actual)}`,
    );
  }
  const total = populationTotal(world.counters);
  if (total !== world.scenario.population) {
    throw new InvariantError(`tick ${world.tick}: population ${total} !== ${world.scenario.population}`);
  }
}

export function step(world: World, ctx: Context, options: StepOptions): void {
  const probe = options.probe ?? (() => {});
  probe('start');
  world.tick++; //                                         1  advance tick (timeOfDay is derived)
  sizeContext(ctx, world);
  rebuildHashes(world, ctx); //                            2  spatial hash
  probe('hashes');
  expireStimuli(world); //                                 3  stimuli
  computePerception(world, ctx); //                        4  read-only snapshot
  probe('perception');
  zombieDecisions(world, ctx); //                          5
  probe('zombies');
  updatePanic(world, ctx); //                              6  sim decisions: panic, then intent
  probe('panic');
  simDecisions(world, ctx);
  probe('sims');
  resolveCombat(world, ctx); //                            7
  probe('combat');
  convertDue(world, ctx); //                               8
  integrateMovement(world, ctx); //                        9
  probe('movement');
  buildingProcesses(world, ctx); //                        10
  probe('buildings');
  resolveEncounters(world, ctx); //                        11
  probe('encounters');
  if (options.checkInvariant) assertInvariant(world); //   12 (counters are reconciled incrementally)
  world.events = ctx.events; //                            13 emit events
  ctx.events = [];
  probe('end');
}
