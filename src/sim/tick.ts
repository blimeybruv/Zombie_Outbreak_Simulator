// The tick, in its fixed order. Order decides behaviour: perception is computed
// once into a read-only snapshot, every agent decides against it, and positions
// change only in movement integration.

import { sizeContext, type Context } from './context';
import { populationTotal } from './state';
import { recount } from './counters';
import type { Counters, World } from './state';
import { buildingProcesses } from './systems/buildings/buildings';
import { resolveCombat } from './systems/fighting/combat';
import { resolveEncounters } from './systems/people/encounters';
import { convertDue } from './systems/dead/infection';
import { riseDue } from './systems/dead/rising';
import { integrateMovement } from './systems/shared/movement';
import { updatePanic } from './systems/people/panic';
import { computePerception, rebuildHashes } from './systems/shared/perception';
import { updatePromotion } from './systems/story/promotion';
import { simDecisions } from './systems/people/sims';
import { expireStimuli } from './systems/shared/stimuli';
import { zombieDecisions } from './systems/dead/zombies';

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
  // The city's people, and the soldiers who came in from outside to hold the cordon.
  const total = populationTotal(world.counters);
  if (total !== world.scenario.population + world.outsiders) {
    throw new InvariantError(`tick ${world.tick}: population ${total} !== ${world.scenario.population} + ${world.outsiders} outsiders`);
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
  riseDue(world, ctx); //                                     the dead the dead killed, getting up
  integrateMovement(world, ctx); //                        9
  probe('movement');
  buildingProcesses(world, ctx, probe); //                 10
  probe('buildings');
  resolveEncounters(world, ctx); //                        11
  probe('encounters');
  if (options.checkInvariant) assertInvariant(world); //   12 (counters are reconciled incrementally)
  updatePromotion(world); //                                  promotion reads the reconciled counters
  probe('promotion');
  world.events = ctx.events; //                            13 emit events
  ctx.events = [];
  probe('end');
}
