// Tick steps 2 and 4: rebuild the spatial hashes, then compute the read-only
// perception snapshot every decision reads. Nothing here writes entity state.

import { isOutdoorLiving, type Context } from '../context';
import { daylight, timeOfDay } from '../derived';
import { chance } from '../rng';
import type { Sim, World, Zombie } from '../state';

export function onMap(z: Zombie): boolean {
  return z.state !== 'occupying' && z.state !== 'destroyed';
}

export function rebuildSimHash(world: World, ctx: Context): void {
  const live: Sim[] = world.sims.filter(isOutdoorLiving);
  ctx.simHash.rebuild(live.length, (i) => live[i]!.id, (i) => live[i]!.x, (i) => live[i]!.y);
}

export function rebuildHashes(world: World, ctx: Context): void {
  rebuildSimHash(world, ctx);
  const zs = world.zombies.filter(onMap);
  ctx.zombieHash.rebuild(zs.length, (i) => zs[i]!.id, (i) => zs[i]!.x, (i) => zs[i]!.y);
}

/** How visible a sim is to zombie sight, from gait and concealment. */
export function detectability(world: World, ctx: Context, sim: Sim): number {
  const base = world.config.movement.gait[sim.gait].detectability;
  return ctx.dark[sim.id] ? base * world.config.movement.concealment : base;
}

export function computePerception(world: World, ctx: Context): void {
  const { config, sims, zombies } = world;
  const light = daylight(timeOfDay(world.tick, world.scenario, config), config);
  ctx.daylight = light;
  const night = light < 0.5;
  const contact = config.combat.contactRange;
  const ids = ctx.ids;

  for (const sim of sims) {
    const id = sim.id;
    ctx.threat[id] = 0;
    ctx.threatX[id] = 0;
    ctx.threatY[id] = 0;
    ctx.threatFocus[id] = 1;
    ctx.fleeingSeen[id] = 0;
    ctx.crowdX[id] = 0;
    ctx.crowdY[id] = 0;
    ctx.nearestZombie[id] = -1;
    ctx.contacts[id] = 0;
    ctx.street[id] = -1;
    ctx.dark[id] = 0;
    if (!isOutdoorLiving(sim)) continue;

    const streetId = ctx.map.onStreet(sim.street, sim.x, sim.y) ? sim.street : ctx.map.nearestStreet(sim.x, sim.y, config.map.offStreetLookup);
    const street = streetId === null ? null : world.streets[streetId]!;
    ctx.street[id] = streetId ?? -1;
    const terrain = street?.terrain ?? 'standard';
    const lit = street?.lit ?? false;
    const dayR = config.perception.dayRadius[terrain];
    const nightR = lit ? config.perception.nightRadiusLit : config.perception.nightRadiusUnlit;
    const r = nightR + (dayR - nightR) * light;
    ctx.radius[id] = r;
    ctx.dark[id] = night && !lit ? 1 : 0;

    let threat = 0;
    let tx = 0;
    let ty = 0;
    let nearest = -1;
    let nearestD = Infinity;
    ctx.zombieHash.query(sim.x, sim.y, r, ids);
    for (const zid of ids) {
      const z = zombies[zid]!;
      const dx = z.x - sim.x;
      const dy = z.y - sim.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= contact) ctx.contacts[id]!++;
      if (d > contact && !ctx.map.lineOfSight(sim.x, sim.y, z.x, z.y)) continue;
      const w = (1 - d / r) * (z.state === 'dormant' ? config.perception.dormantThreatWeight : 1);
      threat += w;
      if (d > 0) {
        tx += (w * dx) / d;
        ty += (w * dy) / d;
      }
      if (d < nearestD) {
        nearestD = d;
        nearest = zid;
      }
    }
    // Second-hand danger: people running this way, from whatever is behind them.
    const pc = config.crowd;
    ctx.simHash.query(sim.x, sim.y, pc.fleeingRadius, ctx.ids2);
    let fleeing = 0;
    let cx = 0, cy = 0;
    for (const oid of ctx.ids2) {
      if (oid === id) continue;
      const o = sims[oid]!;
      if (o.gait !== 'run' && o.gait !== 'sprint') continue;
      const dx = sim.x - o.x, dy = sim.y - o.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d === 0) continue;
      const hx = Math.cos(o.heading), hy = Math.sin(o.heading);
      // The crowd's current: everyone running close by, whichever way.
      if (d < pc.crowdRadius) {
        cx += hx * (1 - d / pc.crowdRadius);
        cy += hy * (1 - d / pc.crowdRadius);
      }
      if ((hx * dx + hy * dy) / d < pc.fleeingTowardCos) continue;
      if (!ctx.map.lineOfSight(sim.x, sim.y, o.x, o.y)) continue;
      const w = pc.fleeingWeight * (1 - d / pc.fleeingRadius);
      fleeing += w;
      tx -= w * hx;
      ty -= w * hy;
    }
    ctx.fleeingSeen[id] = fleeing;
    ctx.crowdX[id] = cx;
    ctx.crowdY[id] = cy;
    threat += fleeing;
    ctx.threat[id] = threat > 1 ? 1 : threat;
    ctx.threatX[id] = tx;
    ctx.threatY[id] = ty;
    ctx.threatFocus[id] = threat > 0 ? Math.hypot(tx, ty) / threat : 1;
    ctx.nearestZombie[id] = nearest;
  }

  // Zombie sight: awake zombies only. Dormant ones wake on sound or contact.
  const sight = config.zombie.sightRadius;
  const maxDetect = sight * config.movement.gait.sprint.detectability;
  const ramp = config.zombie.sightRamp;
  for (const z of zombies) {
    ctx.zombieSees[z.id] = -1;
    if (z.state !== 'active' && z.state !== 'wandering') continue;
    let best = -1;
    let bestD = Infinity;
    let keepsTarget = false;
    ctx.simHash.query(z.x, z.y, maxDetect, ids);
    for (const sid of ids) {
      const s = sims[sid]!;
      const eff = sight * detectability(world, ctx, s);
      const d = Math.hypot(s.x - z.x, s.y - z.y);
      if (d >= eff) continue;
      const inner = eff * (1 - ramp);
      if (d > inner && !chance(world.rng, (eff - d) / (eff - inner))) continue;
      if (!ctx.map.lineOfSight(z.x, z.y, s.x, s.y)) continue;
      if (sid === z.target) keepsTarget = true;
      if (d < bestD) {
        bestD = d;
        best = sid;
      }
    }
    ctx.zombieSees[z.id] = keepsTarget ? (z.target as number) : best;
  }
}
