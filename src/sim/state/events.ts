// Events emitted in tick step 13 for the ticker, audio, corpse layer and end-of-run
// statistics. Write-once, read-only downstream: emitting an event never changes
// simulation state. `world.events` holds only the current tick's events; the
// ticker keeps its own history for salience rarity.

import type { BuildingId, CarId, Count, DistrictId, Metres, SimId, Tick, Unit01, ZombieId } from './units';
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
  /** Shot: by cordon soldiers, getting round their barrier; mistaken: by the rescue company, taken for one of the dead; returned: a cordon soldier shot by someone getting round its barrier; crash: in a car that hit a building or another car. @range 6 values @unit enum @readBy ticker copy, salience */
  cause: 'fedOn' | 'breach' | 'shot' | 'mistaken' | 'returned' | 'crash';
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
  type: 'buildingBreached' | 'turnedInside' | 'quarantineCaught' | 'shelterEstablished' | 'shelterFell' | 'suppliesRanOut' | 'occupationContested' | 'buildingRetaken' | 'cascadeCrossed' | 'strangerRefused' | 'ambulanceDispatched' | 'patientAdmitted';
  /** @range building id @unit id @readBy ticker, building inspector history */
  building: BuildingId;
  /** The sim contesting, for occupationContested; the stranger, for strangerRefused; the patient, for patientAdmitted; who turned or rose, for turnedInside (null for a resident); the newcomer, for quarantineCaught; otherwise null. @range sim id | null @unit id @readBy ticker */
  sim: SimId | null;
}

export interface SuppliesDeliveredEvent extends EventBase {
  /** @range literal @unit — @readBy event consumers */
  type: 'suppliesDelivered';
  /** @range sim id @unit id @readBy ticker */
  sim: SimId;
  /** @range building id @unit id @readBy ticker, building inspector history */
  building: BuildingId;
  /** @range 1–8 @unit supplies @readBy ticker copy */
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

export interface OutOfAmmoEvent extends EventBase, Located {
  /** A squad member run dry leaves its squad to rearm where it set out from. @range literal @unit — @readBy event consumers */
  type: 'outOfAmmo';
  /** @range sim id @unit id @readBy ticker */
  sim: SimId;
}

export interface CordonBreachedEvent extends EventBase, Located {
  /** Nobody is left to hold a cordon's barrier: people on foot pass it. @range literal @unit — @readBy event consumers */
  type: 'cordonBreached';
  /** Always null: the line is about the road. @range null @unit — @readBy ticker notes */
  sim: null;
}

export interface CordonFiredOnEvent extends EventBase, Located {
  /** Someone getting round a cordon's barrier opened fire on its soldiers (said once a sim). @range literal @unit — @readBy event consumers */
  type: 'cordonFiredOn';
  /** @range sim id @unit id @readBy ticker */
  sim: SimId;
  /** It fired first, rather than back. @range true/false @unit — @readBy ticker copy */
  first: boolean;
}

export interface CarHitEvent extends EventBase, Located {
  /** A car struck one of the dead (its driver in flight): where, and which way it was thrown. @range literal @unit — @readBy event consumers */
  type: 'carHit';
  /** The way it flew, a unit vector. @range unit vector @unit — @readBy render (the body thrown) */
  dx: number;
  /** @range unit vector @unit — @readBy render */
  dy: number;
  /** How far it was thrown. @range 0–cars.knockBack[1] @unit m @readBy render */
  distance: Metres;
  /** Whether the blow destroyed it. @range true/false @unit — @readBy render */
  killed: boolean;
  /** @range literal null @unit — @readBy ticker */
  sim: null;
}

export interface CarCrashedEvent extends EventBase, Located {
  /** A car hit a building or another car hard enough to be wrecked. @range literal @unit — @readBy event consumers */
  type: 'carCrashed';
  /** @range car id @unit id @readBy ticker */
  car: CarId;
  /** How many inside died of it. @range 0–cars.capacity @unit count @readBy ticker copy */
  dead: Count;
  /** @range literal null @unit — @readBy ticker */
  sim: null;
}

export interface VehicleTakenEvent extends EventBase, Located {
  /** Someone drove off in a service vehicle whose crew are all gone. @range literal @unit — @readBy event consumers */
  type: 'vehicleTaken';
  /** @range car id @unit id @readBy ticker */
  car: CarId;
  /** @range 4 values @unit enum @readBy ticker copy */
  kind: 'van' | 'cruiser' | 'ambulance' | 'hmmwv';
  /** Making for a way out of the city, rather than somewhere in it. @range true/false @unit — @readBy ticker copy */
  leaving: boolean;
  /** The driver. @range sim id @unit id @readBy ticker */
  sim: SimId;
}

export interface CarAlarmEvent extends EventBase, Located {
  /** A car's alarm went off: taken, or the dead at it with people inside. @range literal @unit — @readBy event consumers */
  type: 'carAlarm';
  /** @range car id @unit id @readBy ticker */
  car: CarId;
  /** Always null: the line is about the street. @range null @unit — @readBy ticker notes */
  sim: null;
}

export interface DoorWhumpEvent extends EventBase, Located {
  /**
   * A besieging zombie bodies a door: the heave of its ram, before the door gives.
   * Heard, not read. Not a stimulus, so the dead do not hear it and the run is unchanged.
   * @range literal @unit — @readBy audio
   */
  type: 'doorWhump';
  /** The building whose door it is. @range building id @unit id @readBy audio */
  building: BuildingId;
  /** Always null: there is no ticker line. @range null @unit — @readBy ticker notes */
  sim: null;
}

export interface CarHornEvent extends EventBase, Located {
  /** A driving car, blocked and barely moving, sounds its horn. Heard, not read. @range literal @unit — @readBy audio */
  type: 'carHorn';
  /** @range car id @unit id @readBy audio */
  car: CarId;
  /** How long it has been blocked, over cars.horn.full, clamped. @range 0–1 @unit scalar @readBy audio (beeps or blast, level) */
  severity: Unit01;
  /** How far the horn carries, for the same distance falloff as a noise. @range cars.horn.radius @unit m @readBy audio */
  radius: Metres;
  /** Always null: there is no ticker line. @range null @unit — @readBy ticker notes */
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

export interface RescueEvent extends EventBase, Located {
  /**
   * rescueSweep: the rescue company comes in at its exit. rescueBroadcast: the radio
   * tells everyone still hidden to make for it. truckLeft: a truck takes `count` out.
   * @range 3 values @unit enum @readBy event consumers
   */
  type: 'rescueSweep' | 'rescueBroadcast' | 'truckLeft';
  /** People taken out (truckLeft); 0 otherwise. @range 0–rescue.truckCapacity @unit people @readBy ticker copy */
  count: Count;
  /** Always null: the line is about the rescue. @range null @unit — @readBy ticker notes */
  sim: null;
}

export interface BodyRoseEvent extends EventBase, Located {
  /** Someone the dead killed gets up again (systems/dead/rising.ts). Null for an anonymous resident, inside. @range literal @unit — @readBy event consumers */
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

export interface CordonWarnedEvent extends EventBase, Located {
  /** Cordon soldiers fired a warning shot at someone come within cordon.warnRadius of their barrier. @range literal @unit — @readBy event consumers */
  type: 'cordonWarned';
  /** @range sim id @unit id @readBy ticker */
  sim: SimId;
}

export interface CordonWoundedEvent extends EventBase, Located {
  /** Cordon soldiers' aimed fire struck someone within cordon.fireRadius without killing it: it turns back. @range literal @unit — @readBy event consumers */
  type: 'cordonWounded';
  /** @range sim id @unit id @readBy ticker */
  sim: SimId;
}

export interface CheckpointEvent extends EventBase, Located {
  /** checkpointSet: traffic police have set a checkpoint across a road out. checkpointFallen: none of them is left at it. @range literal @unit — @readBy event consumers */
  type: 'checkpointSet' | 'checkpointFallen';
  /** The unit's leader when set; null when fallen. @range sim id | null @unit id @readBy ticker */
  sim: SimId | null;
  /** Who set it: traffic police, or a reservist squad (setting it again, if it had fallen); null when fallen. @range 2 values | null @unit enum @readBy ticker copy */
  by: 'police' | 'reservists' | null;
}

export interface CordonClosedEvent extends EventBase, Located {
  /** Soldiers from outside close an exit: a barrier across the highway, for good. @range literal @unit — @readBy event consumers */
  type: 'cordonClosed';
  /** Always null: the line is about the road. @range null @unit — @readBy ticker notes */
  sim: null;
}

export type SimEvent =
  | RescueEvent
  | BodyRoseEvent
  | ReservistsCalledUpEvent
  | CordonClosedEvent
  | CheckpointEvent
  | CordonEvadedEvent
  | CordonWarnedEvent
  | CordonWoundedEvent
  | SimLeftEvent
  | PoliceRadioEvent
  | SwatDeployedEvent
  | DistrictEvacuatingEvent
  | SquadEvent
  | CarAbandonedEvent
  | CarAlarmEvent
  | DoorWhumpEvent
  | CarHornEvent
  | VehicleTakenEvent
  | CarHitEvent
  | CarCrashedEvent
  | CordonFiredOnEvent
  | CordonBreachedEvent
  | OutOfAmmoEvent
  | PoliceDispatchedEvent
  | SimIsolatingEvent
  | SimDiedEvent
  | SimTurnedEvent
  | ZombieDestroyedEvent
  | BuildingEvent
  | SuppliesDeliveredEvent
  | WeaponFoundEvent
  | DistrictChangedEvent;
