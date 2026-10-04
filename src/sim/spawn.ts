// Creating sims and zombies. People only ever come from here: setup creates the
// starting population; buildings turn residents into sims (release, expulsion)
// and sims or residents into zombies.

import type { Config } from '../config';
import { functionalProfile } from './mapgen/generate';
import { chance, nextFloat, nextInt, type RngState } from './rng';
import {
  ARCHETYPES,
  type Archetype,
  type BuildingId,
  type BuildingTag,
  type DestinationKind,
  type Profession,
  type Sim,
  type SimId,
  type Weapon,
  type World,
  type Zombie,
  type ZombieId,
  type ZombieState,
} from './state';

function weighted<K extends string>(rng: RngState, weights: Record<K, number>, keys: readonly K[]): K {
  let total = 0;
  for (const k of keys) total += weights[k];
  let r = nextFloat(rng) * total;
  for (const k of keys) {
    r -= weights[k];
    if (r < 0) return k;
  }
  return keys[keys.length - 1]!;
}

function professionFor(rng: RngState, tag: BuildingTag, config: Config): Profession {
  const list = config.tagProfessions[functionalProfile(tag, config)] as Profession[];
  return list[nextInt(rng, 0, list.length - 1)]!;
}

/** The scenario mix, with the profession's archetype weighted up: labels bias, they do not override. */
function archetypeFor(rng: RngState, profession: Profession, world: World): Archetype {
  const { config } = world;
  const leaning = config.professionArchetype[profession];
  const weights = { ...world.scenario.archetypeMix };
  weights[leaning as Archetype] *= config.professionBias;
  return weighted(rng, weights, ARCHETYPES);
}

function kitFor(rng: RngState, archetype: Archetype, config: Config): { weapon: Weapon | null; ammo: number } {
  const kit = config.startingKit;
  if (archetype === 'police') return { weapon: 'pistol', ammo: kit.policeAmmo };
  if (archetype === 'reckless' && chance(rng, kit.recklessFirearmShare)) return { weapon: 'shotgun', ammo: kit.recklessAmmo };
  if (chance(rng, kit.meleeShare[archetype])) {
    return { weapon: weighted(rng, kit.meleeWeights, ['knife', 'club', 'sledgehammer'] as const), ammo: 0 };
  }
  return { weapon: null, ammo: 0 };
}

export interface SpawnSim {
  x: number;
  y: number;
  insideBuilding: BuildingId | null;
  /** Tag the person's profession is drawn from (where they started). */
  sourceTag: BuildingTag;
  initialPanic: number;
  destinationKind: DestinationKind | null;
}

export function spawnSim(world: World, spec: SpawnSim): Sim {
  const { rng, config, tick } = world;
  const profession = professionFor(rng, spec.sourceTag, config);
  const archetype = archetypeFor(rng, profession, world);
  const { weapon, ammo } = kitFor(rng, archetype, config);
  const id = world.sims.length as SimId;
  const sim: Sim = {
    id,
    archetype,
    profession,
    age: nextInt(rng, config.spawn.ageRange[0]!, config.spawn.ageRange[1]!),
    caution: nextFloat(rng),
    condition: 'healthy',
    name: null,
    x: spec.x,
    y: spec.y,
    heading: nextFloat(rng) * Math.PI * 2,
    slide: 0,
    gait: 'walk',
    stamina: 1,
    insideBuilding: spec.insideBuilding,
    street: null,
    exitingUntil: null,
    panic: spec.initialPanic,
    streetMemory: new Map(),
    buildingMemory: new Map(),
    knownInfected: new Set(),
    lastMergeAt: tick - config.encounters.cooldown,
    destination: null,
    destinationKind: spec.destinationKind,
    destinationBuilding: null,
    route: [],
    routeIndex: 0,
    nextRepathAt: tick,
    idleUntil: null,
    avoidUntil: null,
    refusedBy: null,
    weapon,
    ammo,
    materials: 0,
    nextAttackAt: tick,
    turnsAt: null,
    shelter: null,
    role: null,
    roleSince: tick,
    sortieUntil: null,
    lastMigratedAt: null,
    history: {
      spawnedAt: tick,
      endedAt: null,
      lastCompanyAt: tick,
      conversionsWitnessed: 0,
      buildingsEntered: 0,
      streetsVisited: 0,
      nearMisses: 0,
      kills: 0,
      materialsDelivered: 0,
    },
  };
  world.sims.push(sim);
  return sim;
}

export function spawnZombie(
  world: World,
  x: number,
  y: number,
  state: ZombieState,
  insideBuilding: BuildingId | null,
  wasSim: SimId | null,
): Zombie {
  const { tick, config, rng } = world;
  const z: Zombie = {
    id: world.zombies.length as ZombieId,
    state,
    stateUntil: null,
    x,
    y,
    heading: nextFloat(rng) * Math.PI * 2,
    slide: 0,
    insideBuilding,
    target: null,
    targetSeenAt: null,
    heardPoint: null,
    heardAt: tick,
    nextAttackAt: tick + config.combat.zombieAttack.cooldown,
    wasSim,
  };
  world.zombies.push(z);
  return z;
}
