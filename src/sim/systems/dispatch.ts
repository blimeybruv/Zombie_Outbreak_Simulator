// 911. First responders are police garrisoned at stations from the start (as
// opposed to patrol officers, who are out on the streets with everyone else).
//
//   call      someone who gets indoors within `callWindow` ticks of seeing a zombie
//             phones it in: the building has a call (`Building.callAt`)
//   dispatch  on a cadence, each waiting call (in building id order) goes to the
//             nearest station within `radius` with first responders inside, armed and
//             free; up to `perCall` of them set out for the caller's door
//   answer    a responder on the scene clears the call and goes back to its station
//             (sims.ts, the respond branch); if every one sent falls back or falls,
//             the call closes; a call nobody is sent to lapses
//
// The call is the one piece of knowledge that travels further than shouting distance:
// a telephone. It carries only where the trouble is, not what it is.

import type { Context } from '../context';
import type { Building, BuildingId, Sim, World } from '../state';
import { capacity, exitTicks, isLiving } from './common';
import { makePolice, spawnSim } from '../spawn';
import { boardSquad, parkVan } from './cars';

/** Garrisons each station with enough residents with first responders. Called once at setup. */
export function placeFirstResponders(world: World, ctx: Context): void {
  const { config, buildings } = world;
  const dc = config.dispatch;
  for (const b of buildings) {
    if (b.tag !== 'policeStation' || b.residents < dc.minResidents) continue;
    for (let n = 0; n < dc.perStation; n++) {
      // A resident becomes tracked: indoors either way, so the counters do not move.
      b.residents--;
      const e = b.entrances[0]!;
      const sim = spawnSim(world, { x: e.x, y: e.y, insideBuilding: b.id, sourceTag: b.tag, from: b.id, initialPanic: 0, destinationKind: null });
      makePolice(world, sim);
      sim.station = b.id;
      sim.shelter = b.id;
      sim.destinationKind = 'shelter';
      sim.gait = 'still';
      sim.history.buildingsEntered = 1;
      b.sheltered.push(sim.id);
    }
    // A police car at the kerb for them (cars.ts): they drive out to calls.
    if (config.features.cars) parkVan(world, ctx, b, 'cruiser');
  }
}

/** Someone just got in from the street: if they had a zombie in sight a moment ago, they call it in. */
export function placeCall(world: World, sim: Sim, b: Building): void {
  const { tick, config } = world;
  if (b.callAt !== null || b.tag === 'policeStation' || sim.station !== null) return;
  if (sim.sightedAt === null || tick - sim.sightedAt > config.dispatch.callWindow) return;
  b.callAt = tick;
  b.dispatchedAt = null;
}

function free(world: World, s: Sim, station: BuildingId): boolean {
  return isLiving(s) && s.insideBuilding === station && s.answering === null && s.exitingUntil === null && capacity(world, s) > 0;
}

/** Lapses old calls and sends officers to waiting ones. Building processes, on a cadence. */
export function dispatchCalls(world: World, ctx: Context): void {
  const { config, tick, buildings, sims } = world;
  const dc = config.dispatch;
  if (tick % dc.interval !== 0) return;
  // SWAT squads are no first responders: they answer only something larger (squads.ts).
  const responders = sims.filter((s) => s.station !== null && s.squadLeader === null && isLiving(s));
  // One who fell back or was turned on the way has given the call up.
  for (const s of responders) if (s.answering !== null && s.destinationKind !== 'respond') s.answering = null;
  const onTheWay = new Set<BuildingId>();
  for (const s of responders) if (s.answering !== null) onTheWay.add(s.answering);
  for (const b of buildings) {
    if (b.callAt === null) continue;
    if (tick - b.callAt > dc.timeout) {
      b.callAt = null;
      b.dispatchedAt = null;
      continue;
    }
    if (b.dispatchedAt !== null) {
      // Everyone sent has fallen back or fallen: they could not get through. The call closes.
      if (!onTheWay.has(b.id)) {
        b.callAt = null;
        b.dispatchedAt = null;
      }
      continue;
    }
    const door = b.entrances[0]!;
    let station: Building | null = null;
    let stationD = Infinity;
    for (const s of responders) {
      if (!free(world, s, s.station!)) continue;
      const st = buildings[s.station!]!;
      const d = Math.hypot(st.entrances[0]!.x - door.x, st.entrances[0]!.y - door.y);
      if (d <= dc.radius && (d < stationD || (d === stationD && st.id < station!.id))) { // ties: lower id
        station = st;
        stationD = d;
      }
    }
    if (station === null) continue;
    let sent = 0;
    for (const s of responders) {
      if (sent >= dc.perCall) break;
      if (s.station !== station.id || !free(world, s, station.id)) continue;
      s.answering = b.id;
      s.awareAt ??= tick;
      s.role = null;
      s.sortieUntil = null;
      s.destination = { x: door.x, y: door.y };
      s.destinationBuilding = null;
      s.destinationKind = 'respond';
      s.route = [];
      s.routeIndex = 0;
      s.exitingUntil = tick + exitTicks(world, station);
      sent++;
    }
    b.dispatchedAt = tick;
    ctx.events.push({ type: 'policeDispatched', tick, building: b.id, station: station.id, officers: sent, sim: null });
  }
}

/**
 * First responders on their way to a call drive, when their station's police car is at
 * the kerb and the call is beyond police.carBeyond: to the car, and in together once every
 * officer sent is within police.carGather of it, the lowest id driving. One way, like a
 * SWAT van: where it stops it stays. Returns 'aboard' once in, the point to walk to
 * while gathering, or null to go on foot.
 */
export function rideToCall(world: World, ctx: Context, sim: Sim, dest: { x: number; y: number }): 'aboard' | { x: number; y: number } | null {
  const { config, cars, sims, buildings } = world;
  if (sim.station === null || sim.answering === null || sim.squadLeader !== null) return null;
  const pc = config.police;
  const door = buildings[sim.station]!.entrances[0]!;
  const car = cars.find((c) => c.kind === 'cruiser' && c.home === sim.station && c.state === 'parked' && c.occupants.length === 0 && Math.hypot(c.x - door.x, c.y - door.y) <= pc.carNear);
  if (car === undefined || Math.hypot(dest.x - car.x, dest.y - car.y) <= pc.carBeyond) return null;
  const sent = sims.filter((s) => s.answering === sim.answering && s.station === sim.station && s.squadLeader === null && isLiving(s));
  const gathered = sent.every((s) => s.insideBuilding === null && s.car === null && Math.hypot(s.x - car.x, s.y - car.y) <= pc.carGather);
  if (gathered && sent[0] === sim && boardSquad(world, ctx, car, sent, { x: dest.x, y: dest.y, building: buildings[sim.answering]! })) return 'aboard';
  return { x: car.x, y: car.y };
}
