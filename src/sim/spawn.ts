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
  /** The building the person came out of, if any: home, if it is residential. */
  from?: BuildingId;
  initialPanic: number;
  destinationKind: DestinationKind | null;
  /** Already knows about the outbreak (driven out by it, or sent out to work in it). */
  aware?: boolean;
}

const residentialCache = new WeakMap<readonly unknown[], BuildingId[]>();
const churchCache = new WeakMap<readonly unknown[], BuildingId[]>();

/** Residential buildings, in id order; computed once per map. */
function residential(world: World): BuildingId[] {
  let ids = residentialCache.get(world.buildings);
  if (!ids) {
    ids = world.buildings.filter((b) => functionalProfile(b.tag, world.config) === 'residential').map((b) => b.id);
    residentialCache.set(world.buildings, ids);
  }
  return ids;
}

/** The church nearest a point (lower id on a tie), or null on a map without one. */
function nearestChurch(world: World, x: number, y: number): BuildingId | null {
  let ids = churchCache.get(world.buildings);
  if (!ids) {
    ids = world.buildings.filter((b) => b.tag === 'church').map((b) => b.id);
    churchCache.set(world.buildings, ids);
  }
  let best: BuildingId | null = null;
  let bestD = Infinity;
  for (const id of ids) {
    const e = world.buildings[id]!.entrances[0]!;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/**
 * Where someone lives: the residential building they came out of, else one of a
 * few sampled, nearer ones likelier. People mostly live within a walk of where they
 * spend the day, though not always.
 */
export function pickHome(world: World, x: number, y: number, from: BuildingId | null): BuildingId | null {
  const { config, rng, buildings } = world;
  if (from !== null && functionalProfile(buildings[from]!.tag, config) === 'residential') return from;
  const ids = residential(world);
  if (ids.length === 0) return null;
  const ac = config.awareness;
  let total = 0;
  const picks: { id: BuildingId; w: number }[] = [];
  for (let i = 0; i < ac.homeSample; i++) {
    const id = ids[nextInt(rng, 0, ids.length - 1)]!;
    const e = buildings[id]!.entrances[0]!;
    const w = 1 / (1 + Math.hypot(e.x - x, e.y - y) / ac.homeDistanceScale);
    picks.push({ id, w });
    total += w;
  }
  let r = nextFloat(rng) * total;
  for (const p of picks) {
    r -= p.w;
    if (r < 0) return p.id;
  }
  return picks[picks.length - 1]!.id;
}

export function spawnSim(world: World, spec: SpawnSim): Sim {
  const { rng, config, tick } = world;
  const profession = professionFor(rng, spec.sourceTag, config);
  const archetype = archetypeFor(rng, profession, world);
  const { weapon, ammo } = kitFor(rng, archetype, config);
  const id = world.sims.length as SimId;
  const home = profession === 'homeless' ? null : pickHome(world, spec.x, spec.y, spec.from ?? null);
  const anchor = home === null ? spec : world.buildings[home]!.entrances[0]!;
  const church = chance(rng, config.faithful.share) ? nearestChurch(world, anchor.x, anchor.y) : null;
  const sim: Sim = {
    id,
    archetype,
    profession,
    age: nextInt(rng, config.spawn.ageRange[0]!, config.spawn.ageRange[1]!),
    caution: nextFloat(rng),
    condition: 'healthy',
    name: null,
    namedAt: null,
    x: spec.x,
    y: spec.y,
    heading: nextFloat(rng) * Math.PI * 2,
    slide: 0,
    gait: 'walk',
    stamina: 1,
    insideBuilding: spec.insideBuilding,
    street: null,
    exitingUntil: null,
    awareAt: spec.aware ? tick : null,
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
    sightedAt: null,
    avoidUntil: null,
    stand: null,
    standUntil: null,
    refusedBy: null,
    weapon,
    ammo,
    materials: 0,
    nextAttackAt: tick,
    turnsAt: null,
    infectedChoice: null,
    home,
    church,
    station: null,
    answering: null,
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
  if (church !== null) {
    const b = world.buildings[church]!;
    sim.buildingMemory.set(church, { believedOccupants: b.residents, materials: b.materials, fortification: b.fortification, observedAt: tick, visited: false });
  }
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
    besieging: null,
    besiegeUntil: null,
    nextAttackAt: tick + config.combat.zombieAttack.cooldown,
    wasSim,
  };
  world.zombies.push(z);
  return z;
}
