// Building a world from a scenario: generate the map from mapSeed, then place the
// population and the outbreak with the run RNG from runSeed.

import type { Config } from '../config';
import { createContext, type Context } from './context';
import { add, transfer } from './counters';
import { bandForHour } from './derived';
import { footprintArea, functionalProfile, generateMap } from './mapgen/generate';
import { createRng, nextFloat, nextInt } from './rng';
import { spawnSim, spawnZombie } from './spawn';
import { emptyCounters, type Building, type Scenario, type World } from './state';
import { occupierAppeared } from './systems/buildings';
import { scheduleRelease } from './systems/release';

const MAX_RESIDENTS = 200;
const ORIGIN_TAGS = new Set<string>(['hospital', 'office', 'school']);

/** Splits `total` across weights by largest remainder; ties go to the lower index. */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / sum) * total);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k]![1]]!++;
  return out;
}

function placeResidents(world: World, indoors: number, band: number): void {
  const { config, buildings, rng } = world;
  const weights = buildings.map((b) => {
    const t = config.tags[functionalProfile(b.tag, config)];
    return ((t.occupancyWeight * footprintArea(b.outline)) / 100) * t.bandMultiplier[band]! * (0.75 + 0.5 * nextFloat(rng));
  });
  const counts = apportion(indoors, weights);
  let overflow = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i]! > MAX_RESIDENTS) {
      overflow += counts[i]! - MAX_RESIDENTS;
      counts[i] = MAX_RESIDENTS;
    }
  }
  for (let i = 0; overflow > 0; i = (i + 1) % counts.length) {
    if (counts[i]! < MAX_RESIDENTS) {
      counts[i]!++;
      overflow--;
    }
  }
  for (const b of buildings) {
    b.residents = counts[b.id]!;
    add(world, 'unturned.indoors', b.residents);
  }
}

function placeStreetPopulation(world: World, count: number): void {
  const { config, streets, nodes, buildings, rng } = world;
  const w = config.spawn.streetSpawnWeight;
  const widths = config.map.streetWidth;
  const weights = streets.map((s) => {
    const a = nodes[s.a]!;
    const b = nodes[s.b]!;
    const kind = s.width >= widths.main ? w.main : s.width <= widths.alley ? w.alley : w.standard;
    return kind * Math.hypot(a.x - b.x, a.y - b.y);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < count; i++) {
    let r = nextFloat(rng) * total;
    let pick = 0;
    for (; pick < weights.length - 1; pick++) {
      r -= weights[pick]!;
      if (r < 0) break;
    }
    const s = streets[pick]!;
    const a = nodes[s.a]!;
    const b = nodes[s.b]!;
    const t = nextFloat(rng);
    const lateral = (nextFloat(rng) - 0.5) * (s.width - 2);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const x = a.x + (b.x - a.x) * t + (-(b.y - a.y) / len) * lateral;
    const y = a.y + (b.y - a.y) * t + ((b.x - a.x) / len) * lateral;
    const source = buildings[nextInt(rng, 0, buildings.length - 1)]!;
    spawnSim(world, { x, y, insideBuilding: null, sourceTag: source.tag, initialPanic: 0, destinationKind: 'routine' });
    add(world, 'unturned.outdoors');
  }
}

/** People within the radius of a building's entrance: residents of nearby buildings plus anyone outdoors. */
function neighbourhood(world: World, ctx: Context, b: Building): number {
  const r = world.config.spawn.originNeighbourhoodRadius;
  const e = b.entrances[0]!;
  let people = 0;
  for (const id of ctx.map.buildingsNear(e.x, e.y, r, ctx.buildingIds)) if (id !== b.id) people += world.buildings[id]!.residents;
  for (const s of world.sims) if (Math.hypot(s.x - e.x, s.y - e.y) <= r) people++;
  return people;
}

/**
 * Eligible origins are high-occupancy hospitals, offices and schools. Among them the
 * choice is weighted by how many people live around each, so the bloom has somewhere
 * to go: a school in an empty corner at 09:00 is possible, but rare.
 */
function originBuildings(world: World, ctx: Context, count: number): Building[] {
  const { config, rng } = world;
  const eligible = world.buildings.filter((b) => ORIGIN_TAGS.has(b.tag));
  const full = eligible.filter((b) => b.residents >= config.spawn.originMinResidents);
  const chosen: Building[] = [];
  const pool = full.map((b) => ({ b, w: neighbourhood(world, ctx, b) + 1 }));
  while (chosen.length < count && pool.length > 0) {
    let r = nextFloat(rng) * pool.reduce((sum, p) => sum + p.w, 0);
    let i = 0;
    for (; i < pool.length - 1; i++) {
      r -= pool[i]!.w;
      if (r < 0) break;
    }
    chosen.push(pool.splice(i, 1)[0]!.b);
  }
  // Fall back to the fullest eligible buildings.
  const byFill = eligible.filter((b) => !chosen.includes(b)).sort((a, b) => b.residents - a.residents || a.id - b.id);
  while (chosen.length < count && byFill.length > 0) chosen.push(byFill.shift()!);
  return chosen;
}

function seedOutbreak(world: World, ctx: Context): void {
  const { scenario, config, rng } = world;
  if (scenario.origin === 'street') {
    const outdoors = world.sims.filter((s) => s.insideBuilding === null);
    if (outdoors.length > 0) {
      const s = outdoors[nextInt(rng, 0, outdoors.length - 1)]!;
      s.condition = 'turned';
      s.history.endedAt = 0;
      spawnZombie(world, s.x, s.y, 'active', null, s.id);
      transfer(world, 'unturned.outdoors', 'turned.outdoors');
      return;
    }
  }
  const [lo, hi] = config.spawn.multipleOriginCount;
  const count = scenario.origin === 'multiple' ? nextInt(rng, lo!, hi!) : 1;
  for (const b of originBuildings(world, ctx, count)) {
    if (b.residents === 0) continue;
    // Patient zero is one of the residents, so the population total is unchanged.
    b.residents--;
    const cx = (ctx.map.bMinX[b.id]! + ctx.map.bMaxX[b.id]!) / 2;
    const cy = (ctx.map.bMinY[b.id]! + ctx.map.bMaxY[b.id]!) / 2;
    spawnZombie(world, cx, cy, 'occupying', b.id, null);
    b.zombiesInside++;
    transfer(world, 'unturned.indoors', 'turned.occupying');
    occupierAppeared(world, ctx, b);
  }
}

export function createWorld(scenario: Scenario, config: Config): { world: World; ctx: Context } {
  const map = generateMap(config, scenario.mapSeed, scenario.power);
  const world: World = {
    tick: 0,
    rng: createRng(scenario.runSeed),
    scenario,
    config,
    sims: [],
    zombies: [],
    buildings: map.buildings,
    streets: map.streets,
    nodes: map.nodes,
    districts: map.districts,
    river: map.river,
    stimuli: [],
    events: [],
    repathQueue: [],
    roster: [],
    counters: emptyCounters(),
    residentDeaths: 0,
    lastConversionAt: null,
    promotedAt: null,
    rescoredAt: null,
  };
  const ctx = createContext(world);
  scheduleRelease(world);

  const band = bandForHour(scenario.startHour, config);
  const outdoors = Math.round(scenario.population * config.spawn.outdoorShareByBand[band]!);
  placeResidents(world, scenario.population - outdoors, band);
  placeStreetPopulation(world, outdoors);
  seedOutbreak(world, ctx);
  world.events = ctx.events;
  ctx.events = [];
  return { world, ctx };
}
