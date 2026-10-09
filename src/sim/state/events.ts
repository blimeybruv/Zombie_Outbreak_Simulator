// Events emitted in tick step 13 for the ticker, audio, corpse layer and end-of-run
// statistics. Write-once, read-only downstream: emitting an event never changes
// simulation state. `world.events` holds only the current tick's events; the
// ticker keeps its own history for salience rarity.

import type { BuildingId, Count, DistrictId, Metres, SimId, Tick, ZombieId } from './units';
import type { Weapon } from './sim';

interface EventBase {
  /** @range tick @unit tick @readBy ticker, end stats */
  tick: Tick;
}

interface Located {
  /** @range 0–3200 @unit m @readBy corpse layer, audio panning, ticker click-to-centre */
  x: Metres;
  /** @range 0–3200 @unit m @readBy corpse layer, audio panning, ticker click-to-centre */
  y: Metres;
}

export interface SimDiedEvent extends EventBase, Located {
  /** @range literal @unit — @readBy event consumers */
  type: 'simDied';
  /** Null for an anonymous resident who died in a breach. @range sim id | null @unit id @readBy ticker */
  sim: SimId | null;
  /** @range 2 values @unit enum @readBy ticker copy */
  cause: 'fedOn' | 'breach';
}

export interface SimTurnedEvent extends EventBase, Located {
  /** @range literal @unit — @readBy event consumers */
  type: 'simTurned';
  /** Null for an anonymous resident who turned in a breach. @range sim id | null @unit id @readBy ticker, salience */
  sim: SimId | null;
  /** @range zombie id @unit id @readBy render (conversion pulse) */
  zombie: ZombieId;
}

export interface ZombieDestroyedEvent extends EventBase, Located {
  /** @range literal @unit — @readBy event consumers */
  type: 'zombieDestroyed';
  /** @range zombie id @unit id @readBy ticker */
  zombie: ZombieId;
  /** @range sim id @unit id @readBy ticker, salience (involvement) */
  by: SimId;
}

export interface BuildingEvent extends EventBase {
  /** @range literal @unit — @readBy event consumers */
  type: 'buildingBreached' | 'shelterEstablished' | 'shelterFell' | 'occupationContested' | 'buildingRetaken' | 'cascadeCrossed';
  /** @range building id @unit id @readBy ticker, building inspector history */
  building: BuildingId;
  /** The sim contesting, for occupationContested; otherwise null. @range sim id | null @unit id @readBy ticker */
  sim: SimId | null;
}

export interface MaterialsDeliveredEvent extends EventBase {
  /** @range literal @unit — @readBy event consumers */
  type: 'materialsDelivered';
  /** @range sim id @unit id @readBy ticker */
  sim: SimId;
  /** @range building id @unit id @readBy ticker, building inspector history */
  building: BuildingId;
  /** @range 1–8 @unit materials @readBy ticker copy */
  amount: Count;
}

export interface WeaponFoundEvent extends EventBase {
  /** @range literal @unit — @readBy event consumers */
  type: 'weaponFound';
  /** @range sim id @unit id @readBy ticker */
  sim: SimId;
  /** @range building id @unit id @readBy ticker */
  building: BuildingId;
  /** @range 6 values @unit enum @readBy ticker copy */
  weapon: Weapon;
}

export interface DistrictChangedEvent extends EventBase {
  /** Emitted for promoted survivors only. @range literal @unit — @readBy event consumers */
  type: 'districtChanged';
  /** @range sim id @unit id @readBy ticker */
  sim: SimId;
  /** @range district id @unit id @readBy ticker copy */
  from: DistrictId;
  /** @range district id @unit id @readBy ticker copy */
  to: DistrictId;
}

export interface SimIsolatingEvent extends EventBase {
  /** A bitten sim goes off alone to turn where it can hurt nobody. @range literal @unit — @readBy event consumers */
  type: 'simIsolating';
  /** @range sim id @unit id @readBy ticker */
  sim: SimId;
  /** The empty building it is making for. @range building id @unit id @readBy ticker */
  building: BuildingId;
}

export type SimEvent =
  | SimIsolatingEvent
  | SimDiedEvent
  | SimTurnedEvent
  | ZombieDestroyedEvent
  | BuildingEvent
  | MaterialsDeliveredEvent
  | WeaponFoundEvent
  | DistrictChangedEvent;
