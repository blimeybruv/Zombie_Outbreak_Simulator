// Arms: what there is to be found, and where it goes. A building holds a few things at
// the start (Building.stock, drawn from its tag's loot table) — a house has one knife
// block, not an endless one — and what is taken is gone from it. Nothing is destroyed
// either: a weapon given up for a better one is left where it was given up, and one
// carried by someone who dies or turns stays where they fell — in the building's stock
// indoors, on the ground outdoors (World.drops), where someone passing who is better
// off with it picks it up. The city's arms move about; they do not only run down.
//
//   stock    setup: buildings.lootStock items a building, by the table's weights
//   loot     on entry, at lootChance, one thing from the stock (shelter.ts calls it)
//   drop     on dying or turning, and on swapping for something better
//   pickup   building processes: the nearest outdoors within pickupRadius it improves

import type { Context } from '../../context';
import { functionalProfile } from '../../mapgen/generate';
import { chance, cloneRng, nextFloat, nextInt, type RngState } from '../../lib/rng';
import type { Arms, Building, Sim, Weapon, World } from '../../state';
import { isFirearm } from '../../state';
import { capacity, isLiving } from '../shared/common';

type Table = Partial<Record<Weapon | 'ammo' | 'materials', number>>;

function tableOf(world: World, b: Building): Table {
  const { config } = world;
  if (!(b.tag in config.tags)) return {};
  return config.tags[functionalProfile(b.tag, config)].loot as Table;
}

/** One item drawn from a loot table by its weights (materials aside), with rounds for a firearm or a box. */
function draw(world: World, rng: RngState, table: Table): Arms | null {
  const { config } = world;
  const keys = (Object.keys(table) as (keyof Table)[]).filter((k) => k !== 'materials');
  if (keys.length === 0) return null;
  let total = 0;
  for (const k of keys) total += table[k]!;
  let r = nextFloat(rng) * total;
  let item = keys[keys.length - 1]! as Weapon | 'ammo';
  for (const k of keys) {
    r -= table[k]!;
    if (r < 0) {
      item = k as Weapon | 'ammo';
      break;
    }
  }
  const rounds = item === 'ammo' || isFirearm(item) ? nextInt(rng, config.buildings.lootAmmo[0]!, config.buildings.lootAmmo[1]!) : 0;
  return { item, ammo: rounds };
}

/** Every building's stock at the start, drawn from a copy of the run's stream so that nothing else at setup moves. Called once at setup. */
export function stockBuildings(world: World): void {
  const per = world.config.buildings.lootStock;
  const rng = cloneRng(world.rng);
  for (const b of world.buildings) {
    const n = per[b.tag] ?? 0;
    if (n === 0) continue;
    const table = tableOf(world, b);
    for (let i = 0; i < n; i++) {
      const a = draw(world, rng, table);
      if (a !== null) b.stock.push(a);
    }
  }
}

/**
 * Would carrying this make the sim more capable than it is? Police and reservists never
 * give up a firearm for anything else: run dry, an officer took a dropped club over its
 * empty pistol, no longer counted as run dry, and never went back to rearm.
 */
function better(world: World, sim: Sim, weapon: Weapon, ammo: number): boolean {
  if ((sim.archetype === 'police' || sim.archetype === 'reservist') && isFirearm(sim.weapon) && !isFirearm(weapon)) return false;
  return capacity(world, { ...sim, weapon, ammo }) > capacity(world, sim);
}

/**
 * On entering a building: at lootChance, one thing from what it still holds. Ammunition
 * for the firearm carried is taken; a weapon is taken if it is the one carried (its
 * rounds) or better, the old one left in its place. Anything else stays.
 */
export function loot(world: World, ctx: Context, sim: Sim, b: Building): void {
  const { config, rng, tick } = world;
  if (b.stock.length === 0 || !chance(rng, config.buildings.lootChance)) return;
  const i = nextInt(rng, 0, b.stock.length - 1);
  const a = b.stock[i]!;
  const cap = config.combat.ammoCap;
  if (a.item === 'ammo') {
    if (!isFirearm(sim.weapon)) return;
    sim.ammo = Math.min(cap, sim.ammo + a.ammo);
    b.stock.splice(i, 1);
    return;
  }
  if (a.item === sim.weapon) {
    if (!isFirearm(a.item)) return;
    sim.ammo = Math.min(cap, sim.ammo + a.ammo);
    b.stock.splice(i, 1);
    return;
  }
  if (!better(world, sim, a.item, a.ammo)) return;
  b.stock.splice(i, 1);
  if (sim.weapon !== null) b.stock.push({ item: sim.weapon, ammo: sim.ammo });
  sim.weapon = a.item;
  sim.ammo = a.ammo;
  ctx.events.push({ type: 'weaponFound', tick, sim: sim.id, building: b.id, weapon: a.item });
}

/** Out of rounds for the firearm it carries (or nearly: less than one attack's worth). */
export function outOfAmmo(world: World, sim: Sim): boolean {
  return isFirearm(sim.weapon) && sim.ammo < world.config.combat.ranged[sim.weapon].ammoPerAttack;
}

/**
 * An officer back at a police station takes a firearm if it has none, and what rounds the
 * station still holds for it: boxes of ammunition, and the rounds in any weapon like its
 * own, up to combat.ammoCap. Finite, like everything since arms became finite: a
 * station emptied stays empty.
 */
export function restock(world: World, sim: Sim, b: Building): void {
  // Without a firearm (it came in with something else), the first the station holds,
  // whatever it carried left in its place.
  if (!isFirearm(sim.weapon)) {
    const i = b.stock.findIndex((a) => isFirearm(a.item));
    if (i < 0) return;
    const gun = b.stock.splice(i, 1)[0]!;
    if (sim.weapon !== null) b.stock.push({ item: sim.weapon, ammo: sim.ammo });
    sim.weapon = gun.item as Weapon;
    sim.ammo = gun.ammo;
  }
  const cap = world.config.combat.ammoCap;
  for (let i = 0; i < b.stock.length && sim.ammo < cap; i++) {
    const a = b.stock[i]!;
    if (a.item !== 'ammo' && a.item !== sim.weapon) continue;
    sim.ammo = Math.min(cap, sim.ammo + a.ammo);
    b.stock.splice(i, 1);
    i--;
  }
}

/** A sim that dies or turns leaves what it carried where it fell: indoors in the building's stock, outdoors on the ground. */
export function dropWeapon(world: World, sim: Sim): void {
  if (sim.weapon === null) return;
  if (sim.insideBuilding !== null) world.buildings[sim.insideBuilding]!.stock.push({ item: sim.weapon, ammo: sim.ammo });
  else world.drops.push({ x: sim.x, y: sim.y, weapon: sim.weapon, ammo: sim.ammo });
  sim.weapon = null;
  sim.ammo = 0;
}

/**
 * Weapons on the ground, oldest first: each is taken by the nearest living sim outdoors
 * within pickupRadius that it would make more capable (lower id on a tie), which leaves
 * what it carried in its place. Building processes.
 */
export function pickUpDrops(world: World, ctx: Context): void {
  const r = world.config.buildings.pickupRadius;
  for (let i = 0; i < world.drops.length; i++) {
    const d = world.drops[i]!;
    ctx.simHash.query(d.x, d.y, r, ctx.ids2);
    let taker: Sim | null = null;
    let best = Infinity;
    for (const id of ctx.ids2) {
      const s = world.sims[id]!;
      if (!isLiving(s) || s.insideBuilding !== null || s.car !== null || s.outsider || s.crew !== null) continue;
      const dist = Math.hypot(s.x - d.x, s.y - d.y);
      if (dist > r || !better(world, s, d.weapon, d.ammo)) continue;
      if (dist < best || (dist === best && taker !== null && s.id < taker.id)) {
        taker = s;
        best = dist;
      }
    }
    if (taker === null) continue;
    const left = taker.weapon;
    const leftAmmo = taker.ammo;
    taker.weapon = d.weapon;
    taker.ammo = d.ammo;
    if (left === null) {
      world.drops.splice(i, 1);
      i--;
    } else world.drops[i] = { x: d.x, y: d.y, weapon: left, ammo: leftAmmo };
  }
}
