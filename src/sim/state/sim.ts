// A living person. Zombies are a separate entity (zombie.ts), not a Sim with a flag.
//
// Every field carries @range, @unit and @readBy; tests/state-gate.test.ts enforces it.
// Quantities derived from other state are deliberately absent:
//   speed           — gait, stamina, age and drag (Movement)
//   perceptionRadius — the street the sim stands on and time of day (Perception)
//   perceivedThreat — recomputed each tick into the perception snapshot
//   ticksSurvived   — (history.endedAt ?? tick) - history.spawnedAt
//   ticksAlone      — tick - history.lastCompanyAt
//   promoted        — name !== null

import type { BuildingId, CarId, Count, Metres, Radians, SimId, StreetId, Tick, Unit01, Vec2 } from './units';

export const ARCHETYPES = ['civilian', 'police', 'prepper', 'loner', 'reckless', 'reservist'] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/** Display labels. Assigned at spawn from the starting building's tag; bias the archetype. */
export const PROFESSIONS = [
  // civilian profile
  'officeWorker', 'retailAssistant', 'teacher', 'deliveryDriver', 'student', 'chef',
  'cleaner', 'bartender', 'mechanic', 'courier', 'receptionist', 'barista',
  'parent', 'librarian', 'accountant', 'nurse', 'nightShiftWorker', 'caretaker',
  // police profile
  'patrolOfficer', 'detective', 'securityGuard', 'paramedic', 'firefighter',
  // prepper profile
  'retiree', 'firearmInstructor', 'reseller', 'trailGuide', 'hamRadioOperator', 'homesteader', 'locksmith',
  // loner profile
  'nightCleaner', 'longHaulDriver', 'groundskeeper', 'homeless', 'tourist',
  // reckless profile
  'offDutySoldier', 'hunter', 'bouncer', 'amateurSurvivalist', 'drunk',
] as const;
export type Profession = (typeof PROFESSIONS)[number];

/**
 * Whether the person is alive and whether they carry the infection. Location is
 * separate (`insideBuilding`). `turned` keeps the record after conversion so ids,
 * history and the ticker's "who this used to be" survive.
 *
 * Nothing may read another sim's condition to learn whether it is infected —
 * that knowledge travels only through `knownInfected`.
 */
export const CONDITIONS = ['healthy', 'infected', 'dead', 'turned', 'evacuated'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const GAITS = ['still', 'sneak', 'walk', 'run', 'sprint'] as const;
export type Gait = (typeof GAITS)[number];

export const DESTINATION_KINDS = ['routine', 'shelter', 'scavenge', 'regroup', 'respond', 'isolate', 'car', 'muster', 'leave'] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

/**
 * A reservist's place in the call-up. reserve: only for the moment of the muster, between
 * stepping out and being called up (squads.ts muster). mobilised: on the way to its depot. waiting: armed at the depot, for a squad.
 * deployed: in a squad. stoodDown: its squad dissolved, or the depot had no weapon
 * left — an ordinary sim again, keeping whatever it carries.
 */
export const MUSTERS = ['reserve', 'mobilised', 'waiting', 'deployed', 'stoodDown'] as const;
export type Muster = (typeof MUSTERS)[number];

/**
 * What a bitten sim does with what it knows: carry on as if nothing happened, into a
 * shelter if that is where it was going (the admission nobody saw), or go off alone
 * to an empty building and turn there.
 */
export const INFECTED_CHOICES = ['conceal', 'isolate'] as const;
export type InfectedChoice = (typeof INFECTED_CHOICES)[number];

export const STANDS = ['fight', 'freeze'] as const;
export type Stand = (typeof STANDS)[number];

export const ROLES = ['builder', 'scavenger', 'dispatcher'] as const;
export type Role = (typeof ROLES)[number];

export const WEAPONS = ['pistol', 'smg', 'shotgun', 'rifle', 'knife', 'club', 'sledgehammer'] as const;
export type Weapon = (typeof WEAPONS)[number];
/** The weapons that shoot (combat.ranged). The rifle is found only in an armoury. */
export const FIREARMS = ['pistol', 'smg', 'shotgun', 'rifle'] as const;
export type Firearm = (typeof FIREARMS)[number];
export const isFirearm = (w: Weapon | string | null): w is Firearm => (FIREARMS as readonly string[]).includes(w ?? '');

/** One remembered observation of a street. Merged by recency on encounter. */
export interface StreetBelief {
  /**
   * `perceivedThreat` at the moment of observation. Never decays; confidence is
   * derived from age instead.
   * @range 0–1 @unit scalar @readBy pathfinding cost, shelter desirability
   */
  danger: Unit01;
  /** @range 0–50,400 @unit tick @readBy confidence, encounter merge (newer wins) */
  observedAt: Tick;
  /**
   * Set only by this sim's own observation, never copied by a merge, so the
   * distinct-streets history counter counts places actually visited.
   * @range true/false @unit — @readBy history (streetsVisited)
   */
  visited: boolean;
}

/** One remembered observation of a building. Merged by recency on encounter. */
export interface BuildingBelief {
  /**
   * Visible fill, which looks identical for residents and occupying zombies.
   * @range 0–400 @unit people @readBy shelter desirability (groupTerm)
   */
  believedOccupants: Count;
  /** @range 0–60 @unit materials @readBy shelter desirability, scavenger target choice */
  materials: Count;
  /** @range 0–1 @unit scalar @readBy shelter desirability */
  fortification: Unit01;
  /** @range 0–50,400 @unit tick @readBy confidence, encounter merge (newer wins) */
  observedAt: Tick;
  /**
   * Set only when this sim itself entered the building; never copied by a merge.
   * @range true/false @unit — @readBy history (buildingsEntered)
   */
  visited: boolean;
}

/** Accrues from spawn on every sim. Read by promotion scoring and end-of-run statistics. */
export interface SimHistory {
  /** @range 0–50,400 @unit tick @readBy ticksSurvived, promotion, end stats */
  spawnedAt: Tick;
  /** Tick the sim died or turned; null while alive. @range 0–50,400 | null @unit tick @readBy ticksSurvived, end stats */
  endedAt: Tick | null;
  /** Last tick another sim was within encounter range. @range 0–50,400 @unit tick @readBy ticksAlone, promotion */
  lastCompanyAt: Tick;
  /** @range 0–2,000 @unit conversions @readBy promotion, panic, backstory */
  conversionsWitnessed: Count;
  /** Distinct buildings entered. @range 0–buildings @unit buildings @readBy promotion, backstory */
  buildingsEntered: Count;
  /** Distinct streets visited. @range 0–streets @unit streets @readBy promotion, backstory */
  streetsVisited: Count;
  /** In zombie contact range and survived it. @range 0–50,400 @unit events @readBy promotion, backstory */
  nearMisses: Count;
  /** @range 0–2,000 @unit zombies @readBy promotion, end stats (highest kills) */
  kills: Count;
  /** Total carried into a shelter. @range 0–∞ @unit materials @readBy promotion, end stats */
  materialsDelivered: Count;
}

export interface Sim {
  // Identity

  /** Array index into `world.sims`; also the deterministic tiebreak. @range 0–population @unit id @readBy everything */
  id: SimId;
  /** @range 5 values @unit enum @readBy all behaviour (thresholds and weights), render */
  archetype: Archetype;
  /** @range ~34 labels @unit enum @readBy inspector, ticker, backstory */
  profession: Profession;
  /** @range 16–85 @unit years @readBy movement (ageFactor), shelter preference, inspector */
  age: number;
  /**
   * Per-sim, orthogonal to archetype.
   * @range 0–1 @unit scalar @readBy migration (requiredDelta), promotion, end stats (caution band)
   */
  caution: Unit01;
  /**
   * How readily this sim goes along with others: a uniform draw, nudged a little by
   * profession (`spawn.professionSociality`), independent of archetype. The archetype
   * scales it into a chance (encounters.ts join), so loners never join whatever it is.
   * @range 0–1 @unit scalar @readBy joining, talking, breaking (company), inspector, end stats (sociality band)
   */
  sociality: Unit01;
  /**
   * How readily it believes what it is told: a uniform draw, independent of archetype.
   * Judged by the listener alone: a sceptic takes hearsay as older than it is, needs
   * more tellings to believe in the outbreak, and often dismisses who is said to be bitten.
   * @range 0–1 @unit scalar @readBy encounters (hearsay), inspector, end stats (trust band)
   */
  trust: Unit01;
  /**
   * Composure under terror: a uniform draw, independent of archetype (those trained to
   * it are held up to config.nerve.floor). Its nerve breaks when panic passes it
   * (panic.ts breaks): cornered, it freezes in shock whatever it carries; with the way
   * blocked, it will not stand to fight; exhausted, with danger in sight, it gives up.
   * @range 0–1 @unit scalar @readBy panic (breaks), inspector, end stats (nerve band)
   */
  nerve: Unit01;
  /** @range 4 values @unit enum @readBy counters, every system that skips the dead, render */
  condition: Condition;
  /** Assigned at promotion; null until then. @range wordlist | null @unit — @readBy roster, ticker, labels */
  name: string | null;
  /** When the name was given; null until then. @range tick | null @unit tick @readBy ticker (whether a death drops playback to 1×), roster */
  namedAt: Tick | null;

  // Physical

  /** Frozen at the entrance used while indoors; where the sim reappears. @range 0–3200 @unit m @readBy spatial hash, movement, perception, render */
  x: Metres;
  /** @range 0–3200 @unit m @readBy spatial hash, movement, perception, render */
  y: Metres;
  /** Facing; decisions set it, movement integrates along it. @range 0–2π @unit rad @readBy movement, perception (the cone it sees in), combat (what it can aim at), render (trails) */
  heading: Radians;
  /**
   * Which way the sim is sliding along an obstacle: -1 or 1, or 0 when its way is
   * clear. Kept until the direct path opens, so it follows a wall instead of
   * flipping sides every tick.
   * @range -1, 0, 1 @unit side @readBy movement
   */
  slide: -1 | 0 | 1;
  /** @range 5 values @unit enum @readBy movement (speed), stamina, detectability, noise */
  gait: Gait;
  /** @range 0–1 @unit scalar @readBy movement (effectiveSpeed), gait selection */
  stamina: Unit01;
  /** Null when outdoors. @range building id | null @unit id @readBy spatial hash, ticking, counters, combat */
  insideBuilding: BuildingId | null;
  /**
   * Street the sim stood on at its last observation; null off-street or indoors.
   * Kept while the sim stays within half the street's width of its centreline.
   * @range street id | null @unit id @readBy perception (radius, lighting), memory writes on entering a street
   */
  street: StreetId | null;
  /** Tick an in-progress exit completes (fortification * 40 ticks); null when not leaving. @range tick | null @unit tick @readBy building processes */
  exitingUntil: Tick | null;

  // Perception and belief

  /**
   * When this sim learned there is an outbreak: by seeing a zombie, a bite or a
   * conversion, hearing gunfire or a shout, being told by someone who knew, or being
   * indoors when the house was alerted. Null while unaware: an unaware sim keeps to
   * its routine; an aware one drops it for an objective (home, shelter, respond).
   * @range tick | null @unit tick @readBy sim decisions (objective), encounter merge (word of mouth), inspector
   */
  awareAt: Tick | null;
  /** @range 0–1 @unit scalar @readBy panic gating only: routing mode, memory use, expulsion */
  panic: Unit01;
  /** Beliefs about streets, keyed by street id. Bounded by streets seen. @range ~20 entries @unit — @readBy pathfinding, shelter desirability, encounter merge */
  streetMemory: Map<StreetId, StreetBelief>;
  /** Beliefs about buildings, keyed by building id. Bounded by buildings seen. @range ~20–30 entries @unit — @readBy shelter selection, migration, scavenging, encounter merge */
  buildingMemory: Map<BuildingId, BuildingBelief>;
  /**
   * Sims this sim believes are infected: written on personally seeing a bite,
   * merged by union on encounter.
   * @range 0–population ids @unit — @readBy shelter admission, encounter merge
   */
  knownInfected: Set<SimId>;
  /**
   * The car it is in; null on foot or indoors. Inside, it counts as outdoors and moves
   * with the car, out of reach of everything that acts on people on foot.
   * @range car id | null @unit id @readBy every outdoor system (excludes it), car processes, counters, render
   */
  car: CarId | null;
  /** The parked car it is walking to, to drive away in (it has claimed it). @range car id | null @unit id @readBy car processes (boarding), sim decisions */
  boarding: CarId | null;
  /** Rate-limits proximity merges. @range tick @unit tick @readBy encounters */
  lastMergeAt: Tick;
  /** Who has told this sim, still unaware, that there is an outbreak (each counts once); emptied once it believes. @range a few sim ids @unit — @readBy encounters */
  toldBy: Set<SimId>;
  /**
   * Belief short of knowing, while unaware: raised by tellings, by being swept along
   * by a running crowd and by distant gunfire; fades. At `unease.believeAt` it becomes
   * awareness. Meanwhile it cuts errands short, draws them toward home, and holds panic up.
   * @range 0–1 @unit scalar @readBy encounters (belief), panic (floor, fading), routine (idle, next stop), inspector
   */
  unease: Unit01;
  /**
   * The conversation this sim has stopped for, named by the sim that started it (its
   * own id if it did); null when not talking. Only talking trades what sims know.
   * @range sim id | null @unit id @readBy encounters (pooling, joining), decisions (holding still), render
   */
  gathering: SimId | null;
  /** When it leaves the conversation: sooner the less sociable. @range tick | null @unit tick @readBy encounters */
  talkUntil: Tick | null;

  // Movement intent

  /** Null when fleeing or idle. @range 0–3200 each axis | null @unit m @readBy steering, pathfinding */
  destination: Vec2 | null;
  /** @range 4 values | null @unit enum @readBy gait selection, role logic, arrival handling */
  destinationKind: DestinationKind | null;
  /** Building being walked to (routine stop, shelter, scavenge target); null for a bare point. @range building id | null @unit id @readBy arrival handling, entrance choice */
  destinationBuilding: BuildingId | null;
  /** Street ids; empty when steering rather than routing. @range street ids @unit — @readBy steering, repath relevance check */
  route: StreetId[];
  /** @range 0–route.length @unit index @readBy steering */
  routeIndex: number;
  /** Earliest tick a repath may run (cooldown). @range tick @unit tick @readBy repath gating */
  nextRepathAt: Tick;
  /** Routine idle at a stop ends here; null when not idling. @range tick | null @unit tick @readBy routine behaviour */
  idleUntil: Tick | null;
  /**
   * Last tick a zombie was in sight. A sighting after more than avoidHold ticks
   * without one is fresh: the sim notes the street and shouts a warning.
   * @range tick | null @unit tick @readBy sim decisions
   */
  sightedAt: Tick | null;
  /**
   * Backing off from a way blocked by danger, with no other door to take: the sim
   * keeps away until this tick, then resumes its re-planned route. The hold is what
   * stops it flipping between backing off and its route every tick. Null otherwise.
   * @range tick | null @unit tick @readBy sim decisions
   */
  avoidUntil: Tick | null;
  /**
   * Cornered, or with the way blocked by more than it can run round, a sim holds its
   * ground for a few ticks: 'fight' faces the nearest zombie and uses what it carries
   * (at range too, whatever its archetype, and even in a panic); 'freeze' keeps still
   * and hopes not to be seen. Null otherwise.
   * @range fight | freeze | null @unit enum @readBy sim decisions, combat, snapshot (render, inspector)
   */
  stand: Stand | null;
  /** When the stand is reconsidered. @range tick | null @unit tick @readBy sim decisions */
  standUntil: Tick | null;
  /** The last building that turned this sim away (occupied, or someone inside knew it was bitten); never chosen again as a door or shelter. @range building id | null @unit id @readBy door and shelter choice */
  refusedBy: BuildingId | null;

  // Carried

  /** Null when unarmed. @range 6 values | null @unit enum @readBy combat, engagement capacity, inspector */
  weapon: Weapon | null;
  /** Zero makes a firearm dead weight. @range 0–30 @unit rounds @readBy combat, engagement capacity */
  ammo: Count;
  /** Capped so one trip cannot resupply a shelter. @range 0–8 @unit materials @readBy delivery, role logic */
  materials: Count;
  /** Earliest tick the next attack may be made (weapon cooldown). @range tick @unit tick @readBy combat */
  nextAttackAt: Tick;

  // Infection

  /** Conversion tick, set on a bite to tick + infection.turnDelay (300–1,200); null when not infected. @range tick | null @unit tick @readBy conversion */
  turnsAt: Tick | null;
  /** Killed by the dead, it gets up again at this tick (systems/rising.ts, rising.chance); null if it stays down, or is not dead. @range tick | null @unit tick @readBy rising */
  risesAt: Tick | null;
  /**
   * Made once, by the sim itself, at its first decision after the bite. Its own
   * infection is the one it may read.
   * @range conceal | isolate | null @unit enum @readBy sim decisions, snapshot (inspector)
   */
  infectedChoice: InfectedChoice | null;
  /**
   * Bites taken. Each after the first halves the time left to turning
   * (infection.rebiteFactor): someone who got away from a crowd is further gone.
   * @range 0–20 @unit bites @readBy combat (rebite), snapshot (inspector)
   */
  bites: Count;

  // Shelter

  /**
   * Where this sim lives: a residential building, its own if it came out of one, else
   * one near where it was first seen. Null for the homeless. Not a shelter until it
   * gets there (`shelter` is set on arrival).
   * @range building id | null @unit id @readBy objective choice, inspector
   */
  home: BuildingId | null;
  /**
   * The faithful: the church this sim belongs to, known from the start (the nearest to
   * home). While it knows a church that has not turned it away it shelters only in
   * churches; failing that, anywhere. Null for everyone else.
   * @range building id | null @unit id @readBy shelter choice, objective choice, inspector
   */
  church: BuildingId | null;
  /**
   * A first responder's police station: officers garrisoned there at the start, sent
   * out to 911 calls (dispatch.ts). Null for everyone else, patrol officers included.
   * @range building id | null @unit id @readBy police dispatch, inspector
   */
  station: BuildingId | null;
  /** The call a first responder is on its way to, or what a squad leader has claimed; null otherwise. @range building id | null @unit id @readBy sim decisions (respond arrival), police dispatch, squads */
  answering: BuildingId | null;

  // Reservists and squads (squads.ts)

  /** A reservist's place in the call-up; null for everyone else. @range 5 values | null @unit enum @readBy sim decisions, squads, panic (mode), snapshot (render, inspector) */
  muster: Muster | null;
  /** A reservist's depot: the armoury nearest home, known from the start; null for everyone else, or with no armoury on the map. @range building id | null @unit id @readBy sim decisions (depot run), squads, building entry */
  depot: BuildingId | null;
  /** The squad this sim is in, named by its leader's id (its own, for the leader); null outside a squad. @range sim id | null @unit id @readBy squads, sim decisions, combat (fires at range), building entry, snapshot (render) */
  squadLeader: SimId | null;
  /** Its place in the squad: 0 the leader, then 1, 2… in id order. @range 0–squads.size-1 @unit slot @readBy squads (formation) */
  squadSlot: Count;
  /** A follower out of reach of its slot since this tick; null while near it. @range tick | null @unit tick @readBy squads (unreachable slots) */
  offSlotSince: Tick | null;
  /** A follower that could not reach its slot heads straight for the leader until this tick; null otherwise. @range tick | null @unit tick @readBy squads */
  directUntil: Tick | null;
  /** A squad leader's recent path, oldest first, a point each squads.fileSpacing metres: where the file walks. Empty for everyone else. @range 0–squads.size+1 points @unit m @readBy squads (file formation) */
  trail: Vec2[];
  /** A squad leader's formation is the diamond (engaged) until this tick; null in file. @range tick | null @unit tick @readBy squads, snapshot (render) */
  diamondUntil: Tick | null;
  /** When a squad leader claimed what it is answering; null with nothing claimed. @range tick | null @unit tick @readBy squads (staleness) */
  answeringSince: Tick | null;
  /** When this officer last radioed for SWAT; null if never. @range tick | null @unit tick @readBy sim decisions (radio cooldown) */
  radioedAt: Tick | null;
  /** A soldier from outside, come to hold the cordon or to sweep for the rescue (cordon.ts, rescue.ts): not one of the city's people, trained, and never in a panic. @range true/false @unit — @readBy panic (immune), combat, rescue, snapshot (inspector), end stats */
  outsider: boolean;
  /** Where a cordon squad's leader stands, by its barrier; null for everyone else. @range 0–3200 each axis | null @unit m @readBy sim decisions (squad leader), cordon */
  post: Vec2 | null;
  /** Waiting at a closed exit since this tick, believing it will be let through; null otherwise. @range tick | null @unit tick @readBy leaving (patience) */
  queuedSince: Tick | null;
  /** Exits this sim has found closed, as bits (1 << exit index). @range 0–7 @unit bits @readBy leaving (choice of exit) */
  knownClosed: number;
  /** Getting round a closed exit's barrier along the kerb, on this side of the road (1 or -1, across it from the exit's outward direction); null otherwise. @range 1 | -1 | null @unit side @readBy leaving (crossing), combat (cordon fire) */
  crossing: 1 | -1 | null;
  /** A cordon soldier whose unit fires on those getting round its barrier (drawn once per unit, cordon.fireShare); false for everyone else, and never shown. @range true/false @unit — @readBy combat (cordon fire) */
  firesOnCrossers: boolean;
  /** The last tick a cordon soldier fired on this sim, getting round its barrier; null if never. @range tick | null @unit tick @readBy combat (returning fire) */
  firedOnAt: Tick | null;
  /** This sim has fired on cordon soldiers (said once, in the ticker). @range true/false @unit — @readBy combat (the first shot's event) */
  firedOnCordon: boolean;
  /** An Army Ranger of the rescue (rescue.ts): elite light infantry, deployed fast; sends back whoever identifies itself, and may shoot whoever does not. @range true/false @unit — @readBy combat (the unidentified), rescue, inspector */
  sweep: boolean;
  /** When it set out for the rescue's exit after the broadcast; null if it never did. What became of those who answered is the end screen's darkest line (rescue.ts rescueTally). @range tick | null @unit tick @readBy rescue (the tally), end stats */
  answeredAt: Tick | null;
  /** An EMT's ambulance; null for everyone else. @range car id | null @unit id @readBy EMTs, alighting */
  crew: CarId | null;
  /** A patient in an ambulance crew's care: its driver's id; null otherwise. @range sim id | null @unit id @readBy EMTs, alighting */
  carriedBy: SimId | null;
  /** When this sim, bitten and believing itself only hurt, called an ambulance; null if never. One call each. @range tick | null @unit tick @readBy EMTs (calls) */
  ambulanceCalledAt: Tick | null;
  /** Building this sim has committed to; re-evaluated only on breach, fall, decay or migration. @range building id | null @unit id @readBy shelter return, roles, migration */
  shelter: BuildingId | null;
  /** @range 3 values | null @unit enum @readBy building processes, role re-evaluation */
  role: Role | null;
  /** @range tick @unit tick @readBy role re-evaluation (prevents thrashing) */
  roleSince: Tick;
  /**
   * A dispatcher's time on the street: it holds near the door engaging what it can
   * see until this tick, then goes back in. Null when not on a sortie.
   * @range tick | null @unit tick @readBy sim decisions
   */
  sortieUntil: Tick | null;
  /** When it last moved shelter or changed objective; null if never. @range tick | null @unit tick @readBy migration cooldown, objective cooldown */
  lastMigratedAt: Tick | null;
  /** News about where it is heading (its street or the building) has come in since it last weighed its objective. @range true/false @unit — @readBy objective re-evaluation */
  reconsider: boolean;

  /** Inline for now; a parallel id-indexed structure is a later option if profiling asks. @range see SimHistory @unit — @readBy promotion, end stats */
  history: SimHistory;
}
