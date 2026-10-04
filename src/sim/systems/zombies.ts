// Tick step 5: zombie decisions. Writes state and intent (heading, speed), never position.
//
// Channels in precedence: sight (a target lock, from the perception snapshot),
// then sound (a place, never a person), then scent (only biases spontaneous waking).
// A zombie tracking a target ignores sound. Tracking ends after 40 ticks unseen,
// beyond twice effective range, or when the target goes indoors; the last seen
// point then becomes a sound-style destination.

import { isOutdoorLiving, type Context } from '../context';
import { chance, nextFloat, nextInt } from '../rng';
import type { World, Zombie } from '../state';
import { detectability } from './perception';
import { intensityAt } from './stimuli';

interface Heard {
  intensity: number;
  x: number;
  y: number;
}

function loudestAt(world: World, ctx: Context, z: Zombie): Heard {
  const heard: Heard = { intensity: 0, x: 0, y: 0 };
  for (const s of world.stimuli) {
    const i = intensityAt(s, z.x, z.y);
    if (i > heard.intensity) {
      heard.intensity = i;
      heard.x = s.x;
      heard.y = s.y;
    }
  }
  // Footsteps: running and sprinting sims within their gait's noise radius.
  const { gait, gaitNoiseIntensity } = world.config.movement;
  ctx.simHash.query(z.x, z.y, gait.sprint.noise, ctx.ids2);
  for (const sid of ctx.ids2) {
    const s = world.sims[sid]!;
    const r = gait[s.gait].noise;
    if (r <= 0) continue;
    const d = Math.hypot(s.x - z.x, s.y - z.y);
    const i = d >= r ? 0 : gaitNoiseIntensity * (1 - d / r);
    if (i > heard.intensity) {
      heard.intensity = i;
      heard.x = s.x;
      heard.y = s.y;
    }
  }
  return heard;
}

interface Scent {
  /** 0 outside every source, 1 at a source. */
  strength: number;
  /** The entrance of the strongest source, which idle zombies drift toward. */
  x: number;
  y: number;
}

/** Strongest building scent at the zombie: concentrations of the living, never individuals. */
function scentAt(world: World, ctx: Context, z: Zombie): Scent {
  const sc = world.config.scent;
  const scent: Scent = { strength: 0, x: 0, y: 0 };
  for (const bid of ctx.map.buildingsNear(z.x, z.y, sc.buildingRadiusCap, ctx.buildingIds)) {
    const b = world.buildings[bid]!;
    const living = b.residents + b.sheltered.length;
    if (living < sc.buildingMinLiving) continue;
    const radius = Math.min(sc.buildingRadiusCap, sc.buildingRadiusBase + sc.buildingRadiusPerOccupant * living);
    for (const e of b.entrances) {
      const d = Math.hypot(e.x - z.x, e.y - z.y);
      const strength = d < radius ? 1 - d / radius : 0;
      if (strength > scent.strength) {
        scent.strength = strength;
        scent.x = e.x;
        scent.y = e.y;
      }
    }
  }
  return scent;
}

function stalemateStep(world: World): void {
  const { scenario, config, tick } = world;
  if (!scenario.stalemateController) return;
  const quietSince = world.lastConversionAt ?? 0;
  if (tick - quietSince < config.stalemate.window || tick % config.stalemate.stepInterval !== 0) return;
  for (const z of world.zombies) {
    if (z.state === 'dormant' && chance(world.rng, config.stalemate.wakeFraction)) {
      z.state = 'wandering';
      z.stateUntil = tick + nextInt(world.rng, config.zombie.wanderTicks[0]!, config.zombie.wanderTicks[1]!);
    }
  }
}

export function zombieDecisions(world: World, ctx: Context): void {
  const { config, tick, sims } = world;
  const zc = config.zombie;
  const speed = zc.speed[world.scenario.zombieGait];
  stalemateStep(world);

  for (const z of world.zombies) {
    ctx.zombieSpeed[z.id] = 0;
    if (z.state === 'destroyed' || z.state === 'occupying') continue;

    if (z.state === 'feeding') {
      if (z.stateUntil !== null && tick >= z.stateUntil) {
        z.state = 'active';
        z.stateUntil = null;
        z.heardAt = tick;
      }
      continue;
    }

    const heard = loudestAt(world, ctx, z);

    if (z.state === 'dormant') {
      ctx.simHash.query(z.x, z.y, config.combat.contactRange, ctx.ids2);
      if (heard.intensity >= zc.wakeThreshold || ctx.ids2.length > 0) {
        z.state = 'active';
        z.heardAt = tick;
        if (heard.intensity > 0) z.heardPoint = { x: heard.x, y: heard.y };
      } else if (chance(world.rng, zc.wanderRate * (1 + (config.scent.maxWakeMultiplier - 1) * scentAt(world, ctx, z).strength))) {
        z.state = 'wandering';
        z.stateUntil = tick + nextInt(world.rng, zc.wanderTicks[0]!, zc.wanderTicks[1]!);
        z.heading = nextFloat(world.rng) * Math.PI * 2;
      } else {
        continue;
      }
    }

    // Sight.
    const seen = ctx.zombieSees[z.id]!;
    if (seen >= 0) {
      const s = sims[seen]!;
      if (z.state === 'wandering') {
        z.state = 'active';
        z.stateUntil = null;
      }
      z.target = s.id;
      z.targetSeenAt = tick;
      z.heardPoint = { x: s.x, y: s.y };
      z.heardAt = tick;
    } else if (z.target !== null) {
      const s = sims[z.target]!;
      const eff = zc.sightRadius * detectability(world, ctx, s);
      const lost =
        !isOutdoorLiving(s) ||
        tick - (z.targetSeenAt ?? tick) > zc.trackingLossTicks ||
        Math.hypot(s.x - z.x, s.y - z.y) > zc.trackingLossRangeFactor * eff;
      if (lost) z.target = null; // heardPoint keeps the last seen position
    }

    // Sound: a place to go, ignored while tracking.
    if (z.target === null && heard.intensity > 0) {
      if (z.state === 'wandering' && heard.intensity >= zc.wakeThreshold) {
        z.state = 'active';
        z.stateUntil = null;
      }
      if (z.state === 'active') {
        z.heardPoint = { x: heard.x, y: heard.y };
        z.heardAt = tick;
      }
    }

    // Goal direction and pace.
    let gx = 0;
    let gy = 0;
    let pace = 1;
    if (z.heardPoint !== null) {
      const dx = z.heardPoint.x - z.x;
      const dy = z.heardPoint.y - z.y;
      const d = Math.hypot(dx, dy);
      if (d <= zc.arriveRadius && z.target === null) {
        z.heardPoint = null;
      } else if (d > 0) {
        gx = dx / d;
        gy = dy / d;
      }
    }
    if (z.heardPoint === null) {
      if (z.state === 'wandering') {
        if (z.stateUntil !== null && tick >= z.stateUntil) {
          z.state = 'dormant';
          z.stateUntil = null;
          continue;
        }
        pace = zc.wanderSpeedFactor;
      } else {
        if (tick - (z.heardAt ?? tick) > zc.dormantAfter) {
          z.state = 'dormant';
          continue;
        }
        pace = zc.idleSpeedFactor;
      }
      z.heading += (nextFloat(world.rng) - 0.5) * 0.6;
      gx = Math.cos(z.heading);
      gy = Math.sin(z.heading);
      // Drift weakly up the scent gradient, toward the living.
      const scent = scentAt(world, ctx, z);
      if (scent.strength > 0) {
        const dx = scent.x - z.x;
        const dy = scent.y - z.y;
        const d = Math.hypot(dx, dy) || 1;
        gx += (config.scent.idleDrift * dx) / d;
        gy += (config.scent.idleDrift * dy) / d;
      }
    }

    // Flocking with nearby awake zombies: weak cohesion and alignment, repulsion when crowded.
    if (z.state === 'active') {
      ctx.zombieHash.query(z.x, z.y, zc.flockRadius, ctx.ids2);
      let cx = 0, cy = 0, ax = 0, ay = 0, n = 0, crowd = 0, rx = 0, ry = 0;
      for (const oid of ctx.ids2) {
        if (oid === z.id) continue;
        const o = world.zombies[oid]!;
        if (o.state !== 'active') continue;
        const dx = o.x - z.x;
        const dy = o.y - z.y;
        const d = Math.hypot(dx, dy);
        cx += dx;
        cy += dy;
        ax += Math.cos(o.heading);
        ay += Math.sin(o.heading);
        n++;
        if (d < zc.splinterRadius) {
          crowd++;
          if (d > 0) {
            rx -= dx / d;
            ry -= dy / d;
          }
        }
      }
      if (n > 0) {
        const cl = Math.hypot(cx, cy) || 1;
        const al = Math.hypot(ax, ay) || 1;
        gx += (zc.cohesion * cx) / cl + (zc.alignment * ax) / al;
        gy += (zc.cohesion * cy) / cl + (zc.alignment * ay) / al;
      }
      if (crowd >= zc.splinterCount) {
        const rl = Math.hypot(rx, ry) || 1;
        gx += (zc.repulsion * rx) / rl;
        gy += (zc.repulsion * ry) / rl;
      }
    }

    if (gx !== 0 || gy !== 0) z.heading = Math.atan2(gy, gx);
    ctx.zombieSpeed[z.id] = speed * pace;
  }
}
