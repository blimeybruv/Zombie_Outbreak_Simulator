// A building holds three populations: anonymous residents (a count present at
// spawn), tracked sims who entered during the run (ids), and occupying zombies
// (a count, mirrored by zombies in state `occupying`).
//
// Derived rather than stored: integrity and starting occupancy (from tag, via
// config), contested (tracked sims inside while zombiesInside > 0), total
// fill (residents + sheltered.length + zombiesInside), and the work crew
// (tracked builders inside plus up to `residentBuilders` residents).

import type { Weapon } from './sim';
import type { BuildingId, Count, DistrictId, Polygon, SimId, StreetId, Tick, Unit01, Vec2 } from './units';

/** One thing to be found: a weapon (with its rounds, for a firearm) or a box of ammunition. */
export interface Arms {
  /** @range weapon or ammo @unit enum @readBy loot */
  item: Weapon | 'ammo';
  /** Rounds with it: a firearm's magazine, or the box. 0 for a melee weapon. @range 0–combat.ammoCap @unit rounds @readBy loot */
  ammo: Count;
}

/** Functional tags change the simulation. */
export const FUNCTIONAL_TAGS = [
  'residential', 'firearmsStore', 'policeStation', 'hardwareStore', 'workshop',
  'warehouse', 'supermarket', 'office', 'school', 'hospital', 'mall',
] as const;
export type FunctionalTag = (typeof FUNCTIONAL_TAGS)[number];

/** Flavour tags behave exactly like one functional profile (see config) and hold nothing useful. */
export const FLAVOUR_TAGS = [
  'cafe', 'restaurant', 'bar', 'barber', 'laundrette', 'bank', 'church', 'cinema', 'gym',
  'garage', 'clinic', 'pharmacy', 'library', 'hotel', 'depot', 'nursery', 'dentist',
  'bookshop', 'salon', 'takeaway',
] as const;
export type FlavourTag = (typeof FLAVOUR_TAGS)[number];

export type BuildingTag = FunctionalTag | FlavourTag;

export interface Building {
  /** @range 0–buildings @unit id @readBy everything */
  id: BuildingId;
  /** @range 31 values @unit enum @readBy integrity, loot, scent, shelter choice, professions, inspector */
  tag: BuildingTag;
  /** @range district id @unit id @readBy release, ticker */
  district: DistrictId;
  /** The street it fronts. @range street id @unit id @readBy occupier spill, shelter desirability, inspector */
  street: StreetId;
  /** Usually a rectangle. @range 0–3200 each vertex @unit m @readBy line of sight, steering obstacles, render */
  outline: Polygon;
  /** Points on the outline where sims cross it. @range 1–4 points @unit m @readBy routing approach, breach rolls, exit position */
  entrances: readonly Vec2[];

  /** Anonymous residents present at spawn; only ever decreases. @range 0–200 @unit people @readBy counters, release, expulsion, breach, scent, render fill */
  residents: Count;
  /** Tracked sims currently inside, in arrival order. @range sim ids @unit — @readBy admission, roles, contest, scent, inspector, render fill */
  sheltered: SimId[];
  /** Occupying zombies; kept equal to the zombies in state `occupying` here (asserted in the harness). @range 0–200 @unit zombies @readBy contest, spill, counters, render fill */
  zombiesInside: Count;
  /** When the current occupation began; null when unoccupied. @range tick | null @unit tick @readBy ticker, inspector */
  occupiedAt: Tick | null;

  /** Stock available to builders. @range 0–150 @unit supplies @readBy builders, scavenger choice, inspector */
  supplies: Count;
  /** @range 0–1 @unit scalar @readBy breach probability, exit cost, migration damping, desirability */
  fortification: Unit01;
  /** When it ran out of supplies with people in it (shelter.ts); null while it has some, or nobody to eat them. @range tick | null @unit tick @readBy shelter (moving on), inspector */
  outOfSuppliesAt: Tick | null;
  /** A zombie has entered; resets once fortification begins after it is retaken. @range true/false @unit — @readBy shelter re-evaluation, inspector, ticker */
  breached: boolean;
  /** Interior light, visible from outside at night. @range true/false @unit — @readBy render */
  lit: boolean;

  // Shelter economy

  /**
   * When the people inside learned of the outbreak: a zombie seen from the door,
   * gunfire close by, or a frightened arrival. Null while they are unaware, and reset
   * when the building empties: the knowledge belonged to the people. Only an alerted
   * building fortifies or sends anyone out.
   * @range tick | null @unit tick @readBy fortification work, resident scavengers
   */
  alertedAt: Tick | null;
  /**
   * The sim currently out fetching supplies for this building. Checked lazily: it
   * counts only while that sim is alive, outdoors-bound for it and still a scavenger.
   * @range sim id | null @unit id @readBy role evaluation, resident scavengers
   */
  scavengerOut: SimId | null;
  /**
   * When the people who live here began holding it: alerted, enough holders
   * (residents, and tracked sims who have made it home), fortification under way.
   * Null when not a garrison. Cleared when it falls, or when its holders have gone.
   * @range tick | null @unit tick @readBy shelter events (established, fell), cascade watch, end stats, render
   */
  garrisonedAt: Tick | null;
  /**
   * When anyone last came in or went out. A building is barricaded once it knows of the
   * outbreak, someone is inside, and nobody has opened the door for `barricadeTicks`
   * (derived, common.ts stageOf). Null if nobody has yet.
   * @range tick | null @unit tick @readBy fortification stage, render
   */
  doorOpenedAt: Tick | null;
  /**
   * A 911 call from here: someone got inside having just fled a zombie. Null when
   * there is none, when it has been answered, or when it lapses unanswered.
   * @range tick | null @unit tick @readBy police dispatch
   */
  callAt: Tick | null;
  /** When officers were sent to the call; null until then. @range tick | null @unit tick @readBy police dispatch, render (alert ring) */
  dispatchedAt: Tick | null;
  /**
   * An ambulance call from here: someone inside, bitten and believing itself only
   * hurt, phoned for help. Null when there is none, when it was taken, or when it did
   * not get through.
   * @range tick | null @unit tick @readBy EMT dispatch
   */
  ambulanceAt: Tick | null;
  /** Who the call is for. @range sim id | null @unit id @readBy EMTs (retrieval) */
  ambulancePatient: SimId | null;
  /**
   * An armoury's weapons left for reservists to draw (reservists.weaponStock at the
   * start, spent one per reservist armed). Null for every other building.
   * @range 0–reservists.weaponStock | null @unit weapons @readBy depot (arming), snapshot (inspector)
   */
  weaponStock: Count | null;
  /**
   * What is still here to be found (systems/fighting/arms.ts): drawn at setup from the tag's loot
   * table, buildings.lootStock items; each taken is gone; a weapon given up for a better
   * one, or carried by someone who dies or turns here, is left here.
   * @range 0–dozens items @unit — @readBy loot, arms (drops)
   */
  stock: Arms[];
  /**
   * When the crowd outside a garrison crossed cascade density; null below it.
   * @range tick | null @unit tick @readBy cascade event, siege
   */
  cascadeAt: Tick | null;

  /** Residents queued to leave as calm sims on routines (phase release). @range 0–residents @unit people @readBy building processes */
  pendingRelease: Count;
  /** Residents queued to leave knowing, for somewhere far off: their district is evacuating (release.ts). @range 0–residents @unit people @readBy building processes */
  pendingEvacuate: Count;
  /** Residents queued to leave as panicked sims (expulsion, breach). @range 0–residents @unit people @readBy building processes */
  pendingExpel: Count;
  /** Residents queued to convert after a breach. @range 0–residents @unit people @readBy building processes */
  pendingTurn: Count;
  /** Residents queued to die after a breach. @range 0–residents @unit people @readBy building processes */
  pendingDie: Count;
  /** Residents killed here in a breach who will get up again, by tick (systems/dead/rising.ts), soonest first. @range 0–residents entries @unit tick @readBy rising */
  risings: Tick[];
  /** When the rescue company's sweep reached it and sent its people back to the exit (rescue.ts); null if it never did. @range tick | null @unit tick @readBy rescue */
  sweptAt: Tick | null;
  /** Occupiers queued to re-instantiate onto the street, drained under a per-tick cap. @range 0–zombiesInside @unit zombies @readBy building processes */
  pendingSpill: Count;
}
