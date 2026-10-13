// Events emitted in tick step 13 for the ticker, audio, corpse layer and end-of-run
// statistics. Write-once, read-only downstream: emitting an event never changes
// simulation state. `world.events` holds only the current tick's events; the
// ticker keeps its own history for salience rarity.

import type { BuildingId, CarId, Count, DistrictId, Metres, SimId, Tick, ZombieId } from './units';
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
  /** Shot: by cordon soldiers, getting round their barrier. @range 3 values @unit enum @readBy ticker copy, salience */
  cause: 'fedOn' | 'breach' | 'shot';
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
  type: 'buildingBreached' | 'shelterEstablished' | 'shelterFell' | 'occupationContested' | 'buildingRetaken' | 'cascadeCrossed' | 'strangerRefused' | 'ambulanceDispatched' | 'patientAdmitted';
  /** @range building id @unit id @readBy ticker, building inspector history */
  building: BuildingId;
  /** The sim contesting, for occupationContested; the stranger, for strangerRefused; the patient, for patientAdmitted; otherwise null. @range sim id | null @unit id @readBy ticker */
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

export interface PoliceDispatchedEvent extends EventBase {
  /** First responders sent from a station to a 911 call. @range literal @unit — @readBy event consumers */
  type: 'policeDispatched';
  /** Where the call came from. @range building id @unit id @readBy ticker */
  building: BuildingId;
  /** @range building id @unit id @readBy ticker copy */
  station: BuildingId;
  /** @range 1–4 @unit officers @readBy ticker copy */
  officers: Count;
  /** Always null: the line is about the call. @range null @unit — @readBy ticker notes */
  sim: null;
}

export interface CarAbandonedEvent extends EventBase, Located {
  /** A car stopped behind something too long, left where it stands for good. @range literal @unit — @readBy event consumers */
  type: 'carAbandoned';
  /** @range car id @unit id @readBy ticker */
  car: CarId;
  /** Always null: the line is about the road. @range null @unit — @readBy ticker notes */
  sim: null;
}

export interface SquadEvent extends EventBase, Located {
  /**
   * squadFormed: reservists armed at a depot deploy. squadEngaged: from file to
   * diamond, facing the dead. squadDissolved: too few left, they stand down.
   * @range 3 values @unit enum @readBy event consumers
   */
  type: 'squadFormed' | 'squadEngaged' | 'squadDissolved';
  /** Its leader (the last of it, when dissolved). @range sim id @unit id @readBy ticker */
  sim: SimId;
  /** Its members, at the time. @range 1–squads.size @unit people @readBy ticker copy */
  members: Count;
}

export interface ReservistsCalledUpEvent extends EventBase, Located {
  /** The reserve is activated (squads.ts callUp): from now on, what a reservist sees calls it up. Located at the first armoury. @range literal @unit — @readBy event consumers */
  type: 'reservistsCalledUp';
  /** Always null: the line is about the order. @range null @unit — @readBy ticker notes */
  sim: null;
}

export interface DistrictEvacuatingEvent extends EventBase, Located {
  /** A district that has come to know empties onto the roads: where its evacuees set out from, on average. @range literal @unit — @readBy event consumers */
  type: 'districtEvacuating';
  /** @range district id @unit id @readBy ticker */
  district: DistrictId;
  /** The first district to go: the one the world outside reacts to (cordon.ts). @range true/false @unit — @readBy ticker copy, salience */
  first: boolean;
  /** Always null: the line is about the district. @range null @unit — @readBy ticker notes */
  sim: null;
}

export interface SwatDeployedEvent extends EventBase, Located {
  /** A SWAT squad sets out for an officer's radio call: where the officer was. @range literal @unit — @readBy event consumers */
  type: 'swatDeployed';
  /** @range building id @unit id @readBy ticker copy */
  station: BuildingId;
  /** Its leader. @range sim id @unit id @readBy ticker */
  sim: SimId;
  /** What the officer counted: what SWAT believes it is going to. @range 1–hundreds @unit zombies @readBy ticker copy */
  count: Count;
}

export interface PoliceRadioEvent extends EventBase, Located {
  /** An officer on a call, outmatched, radios for SWAT. @range literal @unit — @readBy event consumers */
  type: 'policeRadio';
  /** @range sim id @unit id @readBy ticker */
  sim: SimId;
  /** @range 1–hundreds @unit zombies @readBy ticker copy */
  count: Count;
}

export interface SimLeftEvent extends EventBase, Located {
  /** A sim got off the map by an exit, on foot or driven: evacuated. @range literal @unit — @readBy event consumers */
  type: 'simLeft';
  /** @range sim id @unit id @readBy ticker */
  sim: SimId;
}

export interface BodyRoseEvent extends EventBase, Located {
  /** Someone the dead killed gets up again (systems/rising.ts). Null for an anonymous resident, inside. @range literal @unit — @readBy event consumers */
  type: 'bodyRose';
  /** @range sim id | null @unit id @readBy ticker */
  sim: SimId | null;
}

export interface CordonEvadedEvent extends EventBase, Located {
  /** A sim got round a closed exit's barrier, along the kerb, and out (a simLeft follows). @range literal @unit — @readBy event consumers */
  type: 'cordonEvaded';
  /** @range sim id @unit id @readBy ticker */
  sim: SimId;
}

export interface CordonClosedEvent extends EventBase, Located {
  /** Soldiers from outside close an exit: a barrier across the highway, for good. @range literal @unit — @readBy event consumers */
  type: 'cordonClosed';
  /** Always null: the line is about the road. @range null @unit — @readBy ticker notes */
  sim: null;
}

export type SimEvent =
  | BodyRoseEvent
  | ReservistsCalledUpEvent
  | CordonClosedEvent
  | CordonEvadedEvent
  | SimLeftEvent
  | PoliceRadioEvent
  | SwatDeployedEvent
  | DistrictEvacuatingEvent
  | SquadEvent
  | CarAbandonedEvent
  | PoliceDispatchedEvent
  | SimIsolatingEvent
  | SimDiedEvent
  | SimTurnedEvent
  | ZombieDestroyedEvent
  | BuildingEvent
  | MaterialsDeliveredEvent
  | WeaponFoundEvent
  | DistrictChangedEvent;
