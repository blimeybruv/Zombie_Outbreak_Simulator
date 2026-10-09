// Tick step 7: combat. Sims act in id order, then zombies in id order; a zombie
// destroyed earlier in the tick does not act later. Every attack is one roll that
// kills, misses, or infects. No health on either side.

import { isOutdoorLiving, type Context } from '../context';
import { isLiving } from './common';
import { transfer, simLeaf } from '../counters';
import { chance, nextInt } from '../rng';
import type { Sim, World, Zombie } from '../state';
import { modeOf } from './panic';
import { emitStimulus } from './stimuli';

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
  if (victim.condition !== 'healthy') return;
  const { config, tick, sims } = world;
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
  ctx.simHash.query(victim.x, victim.y, config.perception.dayRadius.open, ctx.ids2);
  for (const wid of ctx.ids2) {
    if (wid === victim.id) continue;
    const w = sims[wid]!;
    if (!isOutdoorLiving(w)) continue;
    if (Math.hypot(w.x - victim.x, w.y - victim.y) > ctx.radius[wid]!) continue;
    if (!ctx.map.lineOfSight(w.x, w.y, victim.x, victim.y)) continue;
    w.knownInfected.add(victim.id);
    w.awareAt ??= tick;
  }
}

export function killSim(world: World, ctx: Context, victim: Sim, cause: 'fedOn' | 'breach'): void {
  const from = simLeaf(victim);
  if (from === null || victim.condition === 'dead') return;
  victim.condition = 'dead';
  victim.turnsAt = null;
  victim.history.endedAt = world.tick;
  transfer(world, from, 'unturned.dead');
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
    if (modeOf(sim, config) === 'flight' && sim.stand !== 'fight') continue;

    const w = sim.weapon;
    const ranged = w === 'pistol' || w === 'smg' || w === 'shotgun' ? cc.ranged[w] : null;
    const usable = ranged !== null && sim.ammo >= ranged.ammoPerAttack;
    const engages = config.archetypes[sim.archetype].engageThreshold > 0 || sim.stand === 'fight';
    // Engagers, and anyone standing to fight, pick targets at range on a staggered
    // cycle; everyone else defends in contact.
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
      if (d > cc.contactRange && !ctx.map.lineOfSight(sim.x, sim.y, z.x, z.y)) continue;
      target = z;
      targetD = d;
    }
    if (target === null) continue;

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
        if (chance(world.rng, ranged.baseKill * (1 - (cc.rangedFalloff * d) / ranged.range))) {
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
  if (w !== 'pistol' && w !== 'smg' && w !== 'shotgun') return;
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
  if (chance(world.rng, ranged.baseKill * (1 - (cc.rangedFalloff * targetD) / ranged.range))) {
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

    const awayX = victim.x - z.x;
    const awayY = victim.y - z.y;
    const fleeing =
      (victim.gait === 'run' || victim.gait === 'sprint') && Math.cos(victim.heading) * awayX + Math.sin(victim.heading) * awayY > 0;
    if (!chance(world.rng, za.baseInfection * (fleeing ? za.movingFactor : 1))) {
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
