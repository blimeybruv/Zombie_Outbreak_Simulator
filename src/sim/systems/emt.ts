// EMTs: a vector dressed as a rescue. A bitten sim that believes itself only hurt calls
// an ambulance; a crew comes, fetches it, and drives it to a hospital — one of the
// fullest buildings on the map — where it turns, inside, with everyone around it.
// Nobody involved does anything wrong.
//
//   call      someone indoors, bitten, who has seen nobody bitten and nobody turn (so
//             thinks it is an injury), phones once (`Building.ambulanceAt`). Its own
//             infection is the one it may read; nobody else reads it
//   dispatch  on the 911 cadence, a call gets through at emt.answer, halving every
//             answerHalfLife ticks — early calls are answered and seed the hospitals,
//             late ones do not connect; the nearest idle crew takes it
//   the job   the crew goes out to the ambulance, in together, and drives there; walks
//             in; takes the patient (if still there); out, in again, and home; the
//             patient is admitted. EMTs never screen: they come for an injury
//   in transit a patient who turns in the ambulance bites the crew (cars.ts turnedInCar)

import type { Context } from '../context';
import { chance } from '../rng';
import { spawnSim } from '../spawn';
import type { Building, Car, Sim, World } from '../state';
import { boardSquad, parkVan } from './cars';
import { exitTicks, isLiving, setDestination } from './common';

/** One crew and an ambulance at each hospital, from its residents. Called once at setup, after the parked cars. */
export function placeEmts(world: World, ctx: Context): void {
  const { config, buildings } = world;
  if (!config.features.emt || !config.features.cars) return;
  for (const b of buildings) {
    if (b.tag !== 'hospital' || b.residents < config.emt.crew) continue;
    const car = parkVan(world, ctx, b, 'ambulance');
    if (car === null) continue;
    const e = b.entrances[0]!;
    for (let i = 0; i < config.emt.crew; i++) {
      // A resident becomes tracked: indoors either way, so the counters do not move.
      b.residents--;
      const sim = spawnSim(world, { x: e.x, y: e.y, insideBuilding: b.id, sourceTag: b.tag, from: b.id, initialPanic: 0, destinationKind: null });
      sim.archetype = 'civilian';
      sim.crew = car.id;
      sim.shelter = b.id;
      sim.destinationKind = 'shelter';
      sim.gait = 'still';
      b.sheltered.push(sim.id);
    }
  }
}

/** Has it seen what a bite does? Then it knows what this is, and does not call for an ambulance. */
function believesHurt(sim: Sim): boolean {
  return sim.history.conversionsWitnessed === 0 && sim.knownInfected.size === 0 && sim.infectedChoice !== 'isolate';
}

/** A bitten sim indoors that thinks it is only hurt phones for an ambulance, once. */
export function callAmbulance(world: World, sim: Sim): void {
  if (!world.config.features.emt || sim.condition !== 'infected' || sim.insideBuilding === null) return;
  if (sim.ambulanceCalledAt !== null || sim.carriedBy !== null || sim.crew !== null || !believesHurt(sim)) return;
  const b = world.buildings[sim.insideBuilding]!;
  if (b.ambulanceAt !== null || b.tag === 'hospital') return;
  sim.ambulanceCalledAt = world.tick;
  // Early calls are answered; late ones do not get through.
  const ec = world.config.emt;
  if (!chance(world.rng, ec.answer * 0.5 ** (world.tick / ec.answerHalfLife))) return;
  b.ambulanceAt = world.tick;
  b.ambulancePatient = sim.id;
}

function crewOf(world: World, car: Car): Sim[] {
  return world.sims.filter((s) => s.crew === car.id && isLiving(s));
}

function idle(world: World, car: Car): boolean {
  if (car.job !== null || car.state !== 'parked' || car.home === null) return false;
  const home = world.buildings[car.home]!;
  if (Math.hypot(car.x - home.entrances[0]!.x, car.y - home.entrances[0]!.y) > world.config.emt.arriveNear) return false;
  const crew = crewOf(world, car);
  return crew.length === world.config.emt.crew && crew.every((s) => s.insideBuilding === home.id && s.exitingUntil === null);
}

/** Calls get through, or not, and go to the nearest idle crew; old ones lapse. Building processes, on the 911 cadence. */
export function dispatchAmbulances(world: World, ctx: Context): void {
  const { config, tick, buildings, cars } = world;
  const ec = config.emt;
  if (!config.features.emt || tick % config.dispatch.interval !== 0) return;
  for (const b of buildings) {
    if (b.ambulanceAt === null || cars.some((c) => c.job === b.id)) continue;
    if (tick - b.ambulanceAt > config.dispatch.timeout) {
      b.ambulanceAt = null;
      b.ambulancePatient = null;
      continue;
    }
    const door = b.entrances[0]!;
    let best: Car | null = null;
    let bestD = Infinity;
    for (const c of cars) {
      if (c.kind !== 'ambulance' || !idle(world, c)) continue;
      const d = Math.hypot(c.x - door.x, c.y - door.y);
      if (d <= ec.radius && d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best === null) continue;
    best.job = b.id;
    best.patient = null;
    const home = buildings[best.home!]!;
    for (const s of crewOf(world, best)) {
      s.role = null;
      s.exitingUntil = tick + exitTicks(world, home);
    }
    ctx.events.push({ type: 'ambulanceDispatched', tick, building: b.id, sim: null });
  }
}

/**
 * An EMT on a job, outdoors: with the ambulance parked by the job's door, in through
 * it; otherwise to the ambulance, and in together (with the patient, once they have
 * one) once all are within emt.gather. Turned away at the call's door (occupied), the
 * job is given up: home. True while on a job.
 */
export function decideEmt(world: World, ctx: Context, sim: Sim): boolean {
  if (sim.crew === null) return false;
  const { config, buildings, cars, sims } = world;
  const car = cars[sim.crew]!;
  if (car.job === null) return false;
  if (sim.insideBuilding !== null) {
    if (sim.insideBuilding === car.home && car.job === car.home) finishJob(world, ctx, car);
    else if (sim.insideBuilding !== car.job && sim.exitingUntil === null) sim.exitingUntil = world.tick + exitTicks(world, buildings[sim.insideBuilding]!);
    return true;
  }
  if (sim.refusedBy === car.job && car.job !== car.home) {
    sim.refusedBy = null;
    car.job = car.home;
  }
  if (car.job === null) return false;
  const job = buildings[car.job]!;
  const door = job.entrances[0]!;
  if (car.state === 'parked' && Math.hypot(car.x - door.x, car.y - door.y) <= config.emt.arriveNear) {
    if (sim.destinationBuilding !== job.id) setDestination(sim, job, 'respond');
    sim.gait = 'walk';
    return true;
  }
  if (car.state !== 'parked') return true; // gone without them (broken into, jammed): it waits on nothing
  const aboard = [...crewOf(world, car), ...(car.patient === null ? [] : [sims[car.patient]!])].filter((s) => isLiving(s));
  const ready = aboard.every((s) => s.insideBuilding === null && s.car === null && Math.hypot(s.x - car.x, s.y - car.y) <= config.emt.gather);
  if (ready && aboard[0] === sim && boardSquad(world, ctx, car, aboard, { x: door.x, y: door.y, building: job })) return true;
  sim.destination = { x: car.x, y: car.y };
  sim.destinationBuilding = null;
  sim.destinationKind = 'respond';
  sim.gait = 'run';
  return true;
}

/** A patient in a crew's care goes where its driver goes: out when it goes out, in where it goes in, beside it in between. */
export function decidePatient(world: World, sim: Sim): boolean {
  if (sim.carriedBy === null) return false;
  const driver = world.sims[sim.carriedBy]!;
  if (!isLiving(driver) || driver.crew === null) {
    sim.carriedBy = null;
    return false;
  }
  if (sim.insideBuilding !== null) {
    if (driver.insideBuilding !== sim.insideBuilding && sim.exitingUntil === null) sim.exitingUntil = world.tick + exitTicks(world, world.buildings[sim.insideBuilding]!);
    return true;
  }
  if (driver.insideBuilding !== null) {
    const b = world.buildings[driver.insideBuilding]!;
    if (sim.destinationBuilding !== b.id) setDestination(sim, b, 'shelter');
  } else {
    sim.destination = { x: driver.x, y: driver.y };
    sim.destinationBuilding = null;
    sim.destinationKind = 'respond';
  }
  sim.gait = 'walk';
  return true;
}

/**
 * An EMT walks in. At the call: the patient, if still there, comes with them (nobody
 * looks for a bite; they came for an injury), the call is closed, and the job turns
 * for home. At home with the job done: the patient is admitted, the crew is free.
 */
export function emtEnter(world: World, ctx: Context, sim: Sim, b: Building): void {
  const car = world.cars[sim.crew!]!;
  if (car.job !== b.id) return;
  if (b.id !== car.home) {
    const p = b.ambulancePatient === null ? null : world.sims[b.ambulancePatient]!;
    b.ambulanceAt = null;
    b.ambulancePatient = null;
    if (p !== null && isLiving(p) && p.insideBuilding === b.id) {
      p.carriedBy = crewOf(world, car)[0]?.id ?? sim.id;
      car.patient = p.id;
      p.exitingUntil = world.tick + exitTicks(world, b);
    }
    car.job = car.home;
    for (const s of crewOf(world, car)) if (s.insideBuilding === b.id) s.exitingUntil = world.tick + exitTicks(world, b);
    return;
  }
  finishJob(world, ctx, car);
}

/** Home: the job is done once the crew and the patient (if it is still with them) are in; the patient is admitted. */
function finishJob(world: World, ctx: Context, car: Car): void {
  const b = world.buildings[car.home!]!;
  const p = car.patient === null ? null : world.sims[car.patient]!;
  const waiting = p !== null && isLiving(p) && p.carriedBy !== null && p.insideBuilding !== b.id;
  if (waiting || !crewOf(world, car).every((s) => s.insideBuilding === b.id)) return;
  if (p !== null) {
    p.carriedBy = null;
    if (isLiving(p) && p.insideBuilding === b.id) {
      p.shelter = b.id;
      p.destinationKind = 'shelter';
      ctx.events.push({ type: 'patientAdmitted', tick: world.tick, building: b.id, sim: p.id });
    }
  }
  car.job = null;
  car.patient = null;
}
