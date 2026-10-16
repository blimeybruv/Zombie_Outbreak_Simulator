// Tick step 7: combat. Sims act in id order, then zombies in id order; a zombie
// destroyed earlier in the tick does not act later. Every attack is one roll that
// kills, misses, or infects. No health on either side.

import { isOutdoorLiving, type Context } from '../context';
import { noteStreet } from '../memory';
import { isLiving } from './common';
import { transfer, simLeaf } from '../counters';
import { chance, nextInt } from '../rng';
import type { Sim, World, Zombie } from '../state';
import { isFirearm } from '../state';
import { dropWeapon } from './arms';
import { markRising } from './rising';
import { identifies } from './rescue';
import { cornered } from './sims';
import { modeOf } from './panic';
import { recognisedWithin, viewFactor } from './perception';
import { emitStimulus } from './stimuli';
import { pastBarrier } from './cordon';
import { nearestExit } from './exits';

/** Kills a zombie: it stays in the array, destroyed. */
export function destroyZombie(world: World, z: Zombie, by: Sim): void {
  const from = z.state === 'occupying' ? 'turned.occupying' : 'turned.outdoors';
  z.state = 'destroyed';
  z.stateUntil = null;
  z.target = null;
  transfer(world, from, 'turned.destroyed');
  by.history.kills++;
}

/** A bite: infects a healthy sim and lets everyone who saw it know. */
export function bite(world: World, ctx: Context, victim: Sim): void {
  const { config, tick, sims } = world;
  if (victim.condition === 'infected') {
    // Bitten again: further gone. The time left to turning shrinks with each bite.
    victim.bites++;
    if (victim.turnsAt !== null) victim.turnsAt = tick + Math.ceil((victim.turnsAt - tick) * config.infection.rebiteFactor);
    return;
  }
  if (victim.condition !== 'healthy') return;
  victim.bites = 1;
  const from = simLeaf(victim)!;
  victim.condition = 'infected';
  victim.awareAt ??= tick;
  victim.turnsAt = tick + nextInt(world.rng, config.infection.turnDelay[0]!, config.infection.turnDelay[1]!);
  transfer(world, from, 'turned.symptomatic');

  if (victim.insideBuilding !== null) {
    for (const id of world.buildings[victim.insideBuilding]!.sheltered) {
      if (id === victim.id) continue;
      sims[id]!.knownInfected.add(victim.id);
      sims[id]!.awareAt ??= tick;
    }
    return;
  }
  // Out in the open: the street it happened on is dangerous, to the bitten and to
  // whoever saw it.
  const street = ctx.map.nearestStreet(victim.x, victim.y, config.map.offStreetLookup);
  if (street !== null) noteStreet(world, victim, street, config.memory.witnessedDanger);
  ctx.simHash.query(victim.x, victim.y, config.perception.dayRadius.open, ctx.ids2);
  for (const wid of ctx.ids2) {
    if (wid === victim.id) continue;
    const w = sims[wid]!;
    if (!isOutdoorLiving(w)) continue;
    if (Math.hypot(w.x - victim.x, w.y - victim.y) > ctx.radius[wid]!) continue;
    if (!ctx.map.lineOfSight(w.x, w.y, victim.x, victim.y)) continue;
    w.knownInfected.add(victim.id);
    w.awareAt ??= tick;
    if (street !== null) noteStreet(world, w, street, config.memory.witnessedDanger);
  }
}

/**
 * How well a target can be made out to be shot at: fully in daylight or under a
 * streetlight; in the dark, down to combat.darkHit, through each twilight. On the
 * ranged roll only — perception already has its own day and night radii, and melee is
 * at arm's length.
 */
function seen(world: World, ctx: Context, x: number, y: number): number {
  const sid = ctx.map.nearestStreet(x, y, world.config.map.offStreetLookup);
  const lit = sid !== null && world.streets[sid]!.lit;
  const vis = lit ? 1 : ctx.daylight;
  const floor = world.config.combat.darkHit;
  return floor + (1 - floor) * vis;
}

export function killSim(world: World, ctx: Context, victim: Sim, cause: 'fedOn' | 'breach' | 'shot' | 'mistaken' | 'returned' | 'crash'): void {
  const from = simLeaf(victim);
  if (from === null || victim.condition === 'dead') return;
  dropWeapon(world, victim); // left where it fell
  victim.condition = 'dead';
  victim.turnsAt = null;
  victim.history.endedAt = world.tick;
  transfer(world, from, 'unturned.dead');
  if (cause === 'fedOn') markRising(world, victim); // only the dead's own kills get up
  ctx.events.push({ type: 'simDied', tick: world.tick, sim: victim.id, cause, x: victim.x, y: victim.y });
}

function sims(world: World, ctx: Context): void {
  const { config, tick, zombies } = world;
  const cc = config.combat;
  const ids = ctx.ids;
  for (const sim of world.sims) {
    if (sim.insideBuilding !== null) {
      if (tick >= sim.nextAttackAt) fromInside(world, ctx, sim);
      continue;
    }
    if (!isOutdoorLiving(sim) || tick < sim.nextAttackAt) continue;
    // A frozen sim does nothing that might be noticed; a panicked one fights only when cornered.
    if (sim.stand === 'freeze') continue;
    if (modeOf(sim, config) === 'flight' && sim.stand !== 'fight' && sim.crossing === null) continue; // getting round a barrier under fire, it still shoots

    const w = sim.weapon;
    const ranged = isFirearm(w) ? cc.ranged[w] : null;
    const usable = ranged !== null && sim.ammo >= ranged.ammoPerAttack;
    const engages = config.archetypes[sim.archetype].engageThreshold > 0 || sim.stand === 'fight' || sim.squadLeader !== null;
    // Engagers, anyone standing to fight, and every member of a squad (reservists keep
    // a civilian's engageThreshold, but a squad is armed to fight at range) pick targets
    // at range on a staggered cycle; everyone else defends in contact.
    const atRange = usable && engages && sim.id % cc.armedTargetStagger === tick % cc.armedTargetStagger;
    const reach = atRange ? ranged.range : cc.contactRange;

    ctx.zombieHash.query(sim.x, sim.y, reach, ids);
    let target: Zombie | null = null;
    let targetD = Infinity;
    for (const zid of ids) {
      const z = zombies[zid]!;
      if (z.state === 'destroyed' || z.state === 'occupying') continue;
      const d = Math.hypot(z.x - sim.x, z.y - sim.y);
      if (d >= targetD) continue;
      if (d > cc.contactRange && d > recognisedWithin(config, ctx.radius[sim.id]!, z) * viewFactor(config, sim, z.x - sim.x, z.y - sim.y, d)) continue; // not seen for what it is, or not seen at all
      if (d > cc.contactRange && !ctx.map.lineOfSight(sim.x, sim.y, z.x, z.y)) continue;
      target = z;
      targetD = d;
    }
    if (target === null) {
      if (usable && sim.id % cc.armedTargetStagger === tick % cc.armedTargetStagger) {
        if (sim.firesOnCrossers) cordonFire(world, ctx, sim, ranged);
        else if (sim.sweep) sweepFire(world, ctx, sim, ranged);
        else if (sim.crossing !== null && !sim.outsider) crosserFire(world, ctx, sim, ranged);
      }
      continue;
    }

    if (usable) {
      const hits: Zombie[] = [target];
      if (ranged.targets > 1) {
        const aim = Math.atan2(target.y - sim.y, target.x - sim.x);
        const half = ((ranged.arc / 2) * Math.PI) / 180;
        for (const zid of ids) {
          if (hits.length >= ranged.targets) break;
          const z = zombies[zid]!;
          if (z === target || z.state === 'destroyed' || z.state === 'occupying') continue;
          let off = Math.abs(Math.atan2(z.y - sim.y, z.x - sim.x) - aim);
          if (off > Math.PI) off = 2 * Math.PI - off;
          if (off <= half && Math.hypot(z.x - sim.x, z.y - sim.y) <= ranged.range) hits.push(z);
        }
      }
      for (const z of hits) {
        const d = Math.hypot(z.x - sim.x, z.y - sim.y);
        if (chance(world.rng, ranged.baseKill * (1 - (cc.rangedFalloff * d) / ranged.range) * seen(world, ctx, z.x, z.y))) {
          destroyZombie(world, z, sim);
          ctx.events.push({ type: 'zombieDestroyed', tick, zombie: z.id, by: sim.id, x: z.x, y: z.y });
        }
      }
      sim.ammo -= ranged.ammoPerAttack;
      sim.nextAttackAt = tick + ranged.cooldown;
      emitStimulus(world, sim.x, sim.y, w!, ranged.noise, false);
      continue;
    }

    if (targetD > cc.contactRange) continue;
    const melee = w === 'knife' || w === 'club' || w === 'sledgehammer' ? cc.melee[w] : cc.melee.unarmed;
    sim.nextAttackAt = tick + melee.cooldown;
    if (w !== null && melee.noise > 0) emitStimulus(world, sim.x, sim.y, w, melee.noise, false);
    if (chance(world.rng, melee.baseKill)) {
      destroyZombie(world, target, sim);
      ctx.events.push({ type: 'zombieDestroyed', tick, zombie: target.id, by: sim.id, x: target.x, y: target.y });
    } else if (chance(world.rng, melee.infectionOnMiss)) {
      bite(world, ctx, sim);
    }
  }
}

/**
 * A cordon soldier whose unit fires on those getting round its barrier, with no dead
 * in reach: at the nearest come within fireLine of the barrier — trying to pass it,
 * not just stepping out of the queue — in range and in sight; the ordinary ranged
 * roll, and the ordinary noise, which the dead come to. The one place a survivor is
 * shot at by anyone, and only here.
 */
type RangedProfile = World['config']['combat']['ranged']['rifle'];

function cordonFire(world: World, ctx: Context, sim: Sim, ranged: RangedProfile): void {
  const { config, tick } = world;
  let target: Sim | null = null;
  let targetD = Infinity;
  for (const s of world.sims) {
    if (s.crossing === null || s.destinationKind !== 'leave' || !isOutdoorLiving(s) || s.car !== null) continue;
    const e = world.exits[nearestExit(world, s.destination!.x, s.destination!.y)!]!;
    if (pastBarrier(world, e, s.x, s.y) < -config.cordon.fireLine) continue; // not yet trying to pass
    const d = Math.hypot(s.x - sim.x, s.y - sim.y);
    if (d > ranged.range || d >= targetD || !ctx.map.lineOfSight(sim.x, sim.y, s.x, s.y)) continue;
    target = s;
    targetD = d;
  }
  if (target === null) return;
  target.firedOnAt = tick;
  if (chance(world.rng, ranged.baseKill * (1 - (config.combat.rangedFalloff * targetD) / ranged.range) * seen(world, ctx, target.x, target.y))) killSim(world, ctx, target, 'shot');
  sim.ammo -= ranged.ammoPerAttack;
  sim.nextAttackAt = tick + ranged.cooldown;
  emitStimulus(world, sim.x, sim.y, sim.weapon!, ranged.noise, false);
}

/**
 * An armed sim getting round a cordon's barrier, with no dead in reach: it fires back at
 * the nearest cordon soldier in range and in sight for cordon.returnFor ticks after the
 * soldiers fired on it, or fires first if its trust is below cordon.fireFirstBelow. The
 * ordinary ranged roll and noise. The third and last exception to no survivor-on-survivor
 * combat (the user's, CLAUDE.md), as narrow as the other two: only at the barrier, only
 * while crossing.
 */
function crosserFire(world: World, ctx: Context, sim: Sim, ranged: RangedProfile): void {
  const { config, tick } = world;
  const cc = config.cordon;
  const provoked = sim.firedOnAt !== null && tick - sim.firedOnAt <= cc.returnFor;
  if (!provoked && sim.trust >= cc.fireFirstBelow) return;
  let target: Sim | null = null;
  let targetD = Infinity;
  ctx.simHash.query(sim.x, sim.y, ranged.range, ctx.ids2);
  for (const id of ctx.ids2) {
    const s = world.sims[id]!;
    if (!s.outsider || s.sweep || !isOutdoorLiving(s)) continue; // the cordon's soldiers, not the Rangers
    const d = Math.hypot(s.x - sim.x, s.y - sim.y);
    if (d > ranged.range || d >= targetD || !ctx.map.lineOfSight(sim.x, sim.y, s.x, s.y)) continue;
    target = s;
    targetD = d;
  }
  if (target === null) return;
  if (!sim.firedOnCordon) {
    sim.firedOnCordon = true;
    ctx.events.push({ type: 'cordonFiredOn', tick, sim: sim.id, first: !provoked, x: sim.x, y: sim.y });
  }
  if (chance(world.rng, ranged.baseKill * (1 - (config.combat.rangedFalloff * targetD) / ranged.range) * seen(world, ctx, target.x, target.y))) killSim(world, ctx, target, 'returned');
  sim.ammo -= ranged.ammoPerAttack;
  sim.nextAttackAt = tick + ranged.cooldown;
  emitStimulus(world, sim.x, sim.y, sim.weapon!, ranged.noise, false);
}

/**
 * A soldier of the rescue company with no dead in reach: someone in sight and range who
 * does not identify itself — frozen, sprinting in a panic, or in the dark — is taken for
 * one of them, at rescue.misidentify a look, and shot at like one. Nobody can tell the
 * living from the bitten; the soldiers do not try. The cordon's exception, at the scale
 * of the ending (the user's).
 */
function sweepFire(world: World, ctx: Context, sim: Sim, ranged: RangedProfile): void {
  const { config, tick } = world;
  let target: Sim | null = null;
  let targetD = Infinity;
  ctx.simHash.query(sim.x, sim.y, ranged.range, ctx.ids2);
  for (const id of ctx.ids2) {
    const s = world.sims[id]!;
    if (s === sim || s.outsider || !isOutdoorLiving(s) || s.car !== null) continue;
    const d = Math.hypot(s.x - sim.x, s.y - sim.y);
    if (d > ranged.range * viewFactor(config, sim, s.x - sim.x, s.y - sim.y, d) || d >= targetD) continue;
    if (identifies(world, s) && seen(world, ctx, s.x, s.y) >= 1) continue; // it calls out, and is seen to
    if (!ctx.map.lineOfSight(sim.x, sim.y, s.x, s.y)) continue;
    target = s;
    targetD = d;
  }
  if (target === null || !chance(world.rng, config.rescue.misidentify)) return;
  if (chance(world.rng, ranged.baseKill * (1 - (config.combat.rangedFalloff * targetD) / ranged.range) * seen(world, ctx, target.x, target.y))) killSim(world, ctx, target, 'mistaken');
  sim.ammo -= ranged.ammoPerAttack;
  sim.nextAttackAt = tick + ranged.cooldown;
  emitStimulus(world, sim.x, sim.y, sim.weapon!, ranged.noise, false);
}

/**
 * Defending from inside: an armed sim sheltering in a building that knows about the
 * outbreak fires on the dead near its doors — the ordinary ranged roll, measured from
 * the door, the noise muffled by the walls. Only at what is within doorDefenceRadius
 * of a door, on the armed sims' staggered cycle, and not while the dead are inside.
 * A defended building is then different from an empty barricaded one.
 */
function fromInside(world: World, ctx: Context, sim: Sim): void {
  const { config, tick, zombies, buildings } = world;
  const cc = config.combat;
  if (!isLiving(sim) || sim.id % cc.armedTargetStagger !== tick % cc.armedTargetStagger) return;
  const w = sim.weapon;
  if (!isFirearm(w)) return;
  const ranged = cc.ranged[w];
  if (sim.ammo < ranged.ammoPerAttack) return;
  const b = buildings[sim.insideBuilding!]!;
  if (b.zombiesInside > 0 || b.alertedAt === null) return;
  const reach = Math.min(ranged.range, cc.doorDefenceRadius);
  let target: Zombie | null = null;
  let targetD = Infinity;
  let door = b.entrances[0]!;
  for (const e of b.entrances) {
    ctx.zombieHash.query(e.x, e.y, reach, ctx.ids2);
    for (const zid of ctx.ids2) {
      const z = zombies[zid]!;
      if (z.state !== 'active' && z.state !== 'wandering') continue;
      const d = Math.hypot(z.x - e.x, z.y - e.y);
      if (d > recognisedWithin(config, reach, z)) continue; // from the door, not seen for what it is
      if (d < targetD || (d === targetD && target !== null && zid < target.id)) {
        target = z;
        targetD = d;
        door = e;
      }
    }
  }
  if (target === null) return;
  sim.ammo -= ranged.ammoPerAttack;
  sim.nextAttackAt = tick + ranged.cooldown;
  emitStimulus(world, door.x, door.y, w, ranged.noise, true, undefined, b.id);
  if (chance(world.rng, ranged.baseKill * (1 - (cc.rangedFalloff * targetD) / ranged.range) * seen(world, ctx, target.x, target.y))) {
    destroyZombie(world, target, sim);
    ctx.events.push({ type: 'zombieDestroyed', tick, zombie: target.id, by: sim.id, x: target.x, y: target.y });
  }
}

function zombiesAttack(world: World, ctx: Context): void {
  const { config, tick } = world;
  const za = config.combat.zombieAttack;
  const ids = ctx.ids;
  for (const z of world.zombies) {
    if (z.state !== 'active' && z.state !== 'wandering') continue;
    if (tick < z.nextAttackAt) continue;
    ctx.simHash.query(z.x, z.y, config.combat.contactRange, ids);
    let victim: Sim | null = null;
    for (const sid of ids) {
      const s = world.sims[sid]!;
      if (isOutdoorLiving(s)) {
        victim = s;
        break;
      }
    }
    if (victim === null) continue;
    z.nextAttackAt = tick + za.cooldown;
    z.intact = false; // a grab, bite or miss, is when it is seen for what it is

    const awayX = victim.x - z.x;
    const awayY = victim.y - z.y;
    const fleeing =
      (victim.gait === 'run' || victim.gait === 'sprint') && Math.cos(victim.heading) * awayX + Math.sin(victim.heading) * awayY > 0;
    // Trapped is worse than caught in the open: no way to give ground.
    const trapped = !fleeing && cornered(world, ctx, victim);
    if (!chance(world.rng, za.baseInfection * (fleeing ? za.movingFactor : trapped ? za.corneredFactor : 1))) {
      victim.history.nearMisses++;
      continue;
    }
    const table = config.combat.releasedChanceByContact;
    const inContact = Math.max(1, ctx.contacts[victim.id]!);
    if (chance(world.rng, table[Math.min(inContact, table.length) - 1]!)) {
      bite(world, ctx, victim);
    } else {
      killSim(world, ctx, victim, 'fedOn');
      z.state = 'feeding';
      z.stateUntil = tick + nextInt(world.rng, config.combat.feedingTicks[0]!, config.combat.feedingTicks[1]!);
      z.target = null;
      z.heardPoint = null;
    }
  }
}

export function resolveCombat(world: World, ctx: Context): void {
  sims(world, ctx);
  zombiesAttack(world, ctx);
}
