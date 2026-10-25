// Tick step 5: zombie decisions. Writes state and intent (heading, speed), never position.
//
// Channels in precedence: sight (a target lock, from the perception snapshot),
// then sound (a place, never a person), then scent (only biases spontaneous waking).
// A zombie tracking a target ignores sound. Tracking ends after 40 ticks unseen or
// beyond twice effective range, and the last seen point then becomes a sound-style
// destination; if the target went indoors, the zombie besieges that building's door
// instead. A zombie that newly sights someone wakes the dormant and idle dead nearby
// (applied after every zombie has decided, so the order they decide in does not matter).

import { isOutdoorLiving, type Context } from '../../context';
import { chance, nextFloat, nextInt } from '../../lib/rng';
import type { Building, World, Zombie } from '../../state';
import { entranceNearest } from '../shared/common';
import { detectability } from '../shared/perception';
import { intensityAt } from '../shared/stimuli';

interface Heard {
  intensity: number;
  x: number;
  y: number;
}

const heard: Heard = { intensity: 0, x: 0, y: 0 };

/** Loudest sound at the zombie. Returns a shared record, valid until the next call. */
function loudestAt(world: World, ctx: Context, z: Zombie): Heard {
  heard.intensity = 0;
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

/**
 * Rebuilds the scent field: for each grid cell, the strongest building scent at its
 * centre and the entrance it leads to. Scent comes from concentrations of the living,
 * never individuals, and occupancy changes slowly, so the field is refreshed on an
 * interval rather than queried per zombie per tick.
 */
function refreshScent(world: World, ctx: Context): void {
  const sc = world.config.scent;
  const f = ctx.scent;
  if (f.builtAt >= 0 && world.tick - f.builtAt < sc.refreshInterval) return;
  f.builtAt = world.tick;
  f.strength.fill(0);
  const cell = sc.fieldCell;
  for (const b of world.buildings) {
    const living = b.residents + b.sheltered.length;
    if (living < sc.buildingMinLiving) continue;
    const radius = Math.min(sc.buildingRadiusCap, sc.buildingRadiusBase + sc.buildingRadiusPerOccupant * living);
    for (const e of b.entrances) {
      const c0x = Math.max(0, Math.floor((e.x - radius) / cell)), c1x = Math.min(f.cols - 1, Math.floor((e.x + radius) / cell));
      const c0y = Math.max(0, Math.floor((e.y - radius) / cell)), c1y = Math.min(f.cols - 1, Math.floor((e.y + radius) / cell));
      for (let cy = c0y; cy <= c1y; cy++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const d = Math.hypot((cx + 0.5) * cell - e.x, (cy + 0.5) * cell - e.y);
          if (d >= radius) continue;
          const i = cy * f.cols + cx;
          const strength = 1 - d / radius;
          if (strength > f.strength[i]!) {
            f.strength[i] = strength;
            f.x[i] = e.x;
            f.y[i] = e.y;
          }
        }
      }
    }
  }
}

/** The building whose door is at (x, y) — within zombie.arriveRadius of an entrance — with the living inside and none of the dead; or null. */
function doorAt(world: World, ctx: Context, x: number, y: number): Building | null {
  const r = world.config.zombie.arriveRadius;
  for (const id of ctx.map.buildingsNear(x, y, r, ctx.buildingIds)) {
    const b = world.buildings[id]!;
    if (b.zombiesInside > 0 || b.residents + b.sheltered.length === 0) continue;
    if (b.entrances.some((e) => Math.hypot(e.x - x, e.y - y) <= r)) return b;
  }
  return null;
}

/** A building with the living in it and none of the dead, whose wall this zombie is up against; null if none. */
function peopledWall(world: World, ctx: Context, z: Zombie): Building | null {
  const r = world.config.zombie.wallTouch;
  for (const id of ctx.map.buildingsNear(z.x, z.y, r, ctx.buildingIds)) {
    const b = world.buildings[id]!;
    if (b.zombiesInside === 0 && b.residents + b.sheltered.length > 0) return b;
  }
  return null;
}

/** Whether another awake zombie is nearer (x, y) than `d`. */
function crowdNearer(world: World, ctx: Context, z: Zombie, x: number, y: number, d: number): boolean {
  ctx.zombieHash.query(x, y, d, ctx.ids2);
  for (const id of ctx.ids2) {
    if (id === z.id) continue;
    const o = world.zombies[id]!;
    if ((o.state === 'active' || o.state === 'wandering') && Math.hypot(o.x - x, o.y - y) < d) return true;
  }
  return false;
}

/** Points a zombie at a place, reusing its existing point record. */
function setHeard(z: Zombie, x: number, y: number): void {
  if (z.heardPoint === null) z.heardPoint = { x, y };
  else {
    z.heardPoint.x = x;
    z.heardPoint.y = y;
  }
}

function scentAt(world: World, ctx: Context, z: Zombie): Scent {
  const f = ctx.scent;
  const cell = world.config.scent.fieldCell;
  const cx = Math.min(f.cols - 1, Math.max(0, Math.floor(z.x / cell)));
  const cy = Math.min(f.cols - 1, Math.max(0, Math.floor(z.y / cell)));
  const i = cy * f.cols + cx;
  return { strength: f.strength[i]!, x: f.x[i]!, y: f.y[i]! };
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
  refreshScent(world, ctx);
  const checkEvery = zc.dormantCheckInterval;
  const idleEvery = zc.idleCheckInterval;

  const alerts: { x: number; y: number; tx: number; ty: number }[] = [];
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

    // Dormant zombies tick cheaply: they check for waking on a staggered cycle.
    if (z.state === 'dormant' && z.id % checkEvery !== tick % checkEvery) continue;
    // Awake but idle (nothing tracked, heard or seen): keep drifting, re-decide on a staggered cycle.
    if (
      (z.state === 'active' || z.state === 'wandering') &&
      z.target === null &&
      z.heardPoint === null &&
      ctx.zombieSees[z.id] === -1 &&
      z.id % idleEvery !== tick % idleEvery
    ) {
      ctx.zombieSpeed[z.id] = speed * (z.state === 'wandering' ? zc.wanderSpeedFactor : zc.idleSpeedFactor);
      continue;
    }

    const heard = loudestAt(world, ctx, z);

    if (z.state === 'dormant') {
      ctx.simHash.query(z.x, z.y, config.combat.contactRange, ctx.ids2);
      if (heard.intensity >= zc.wakeThreshold || ctx.ids2.length > 0) {
        z.state = 'active';
        z.heardAt = tick;
        if (heard.intensity > 0) setHeard(z, heard.x, heard.y);
      } else if (
        chance(world.rng, 1 - Math.pow(1 - zc.wanderRate * (1 + (config.scent.maxWakeMultiplier - 1) * scentAt(world, ctx, z).strength), checkEvery))
      ) {
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
      if (z.target !== s.id) alerts.push({ x: z.x, y: z.y, tx: s.x, ty: s.y });
      z.target = s.id;
      z.targetSeenAt = tick;
      z.besieging = null;
      z.besiegeUntil = null;
      setHeard(z, s.x, s.y);
      z.heardAt = tick;
    } else if (z.target !== null) {
      const s = sims[z.target]!;
      const eff = zc.sightRadius * detectability(world, ctx, s);
      const lost =
        !isOutdoorLiving(s) ||
        tick - (z.targetSeenAt ?? tick) > zc.trackingLossTicks ||
        Math.hypot(s.x - z.x, s.y - z.y) > zc.trackingLossRangeFactor * eff;
      if (lost) {
        z.target = null; // heardPoint keeps the last seen position...
        if (s.insideBuilding !== null && (s.condition === 'healthy' || s.condition === 'infected')) {
          // ...unless it went indoors: then to the door it went in by, to stay.
          const b = world.buildings[s.insideBuilding]!;
          const e = entranceNearest(b, z.x, z.y);
          z.besieging = b.id;
          z.besiegeUntil = tick + zc.besiegeTicks;
          setHeard(z, e.x, e.y);
          z.heardAt = tick;
        }
      }
    }

    // A siege ends when it runs out, or when there is nobody left inside to get at.
    if (z.besieging !== null) {
      const b = world.buildings[z.besieging]!;
      if (tick >= z.besiegeUntil! || b.zombiesInside > 0 || b.residents + b.sheltered.length === 0) {
        z.besieging = null;
        z.besiegeUntil = null;
        z.heardPoint = null;
      }
    }

    // Sound: a place to go, ignored while tracking or besieging.
    if (z.target === null && z.besieging === null && heard.intensity > 0) {
      if (z.state === 'wandering' && heard.intensity >= zc.wakeThreshold) {
        z.state = 'active';
        z.stateUntil = null;
      }
      if (z.state === 'active') {
        setHeard(z, heard.x, heard.y);
        z.heardAt = tick;
      }
    }

    // Goal direction and pace.
    let atDoor = false; // battering the door it besieges: no flocking
    let gx = 0;
    let gy = 0;
    let pace = 1;
    // A sound not heard again in heardForget is given up: without it, one the dead could
    // not reach kept them circling it for the rest of the run, and never sleeping.
    if (z.heardPoint !== null && z.target === null && z.besieging === null && tick - (z.heardAt ?? tick) > zc.heardForget) z.heardPoint = null;
    if (z.heardPoint !== null) {
      const dx = z.heardPoint.x - z.x;
      const dy = z.heardPoint.y - z.y;
      let d = Math.hypot(dx, dy);
      // Come as close as the crowd allows to a point with nobody there: another of the
      // dead nearer it, within crowdArrive, and it is there. Only the one at the front
      // could get within arriveRadius of a door; the rest of a crowd went round and round
      // behind it, the point never reached, for as long as the building stood empty
      // (seed 1: 1,560 zombie-minutes to tick 20,000 at the doors of breached buildings,
      // no sound there). A door the living are behind is pressed on as before, close
      // enough to break in.
      if (
        z.target === null &&
        z.besieging === null &&
        d > zc.arriveRadius &&
        d <= zc.crowdArrive &&
        crowdNearer(world, ctx, z, z.heardPoint.x, z.heardPoint.y, d) &&
        doorAt(world, ctx, z.heardPoint.x, z.heardPoint.y) === null
      )
        d = 0;
      if (d <= zc.arriveRadius && z.besieging !== null) {
        // At the door: it stays, battering it — a step back, then into it again (beyond
        // arriveRadius it comes on at its pace, below). Staggered by id, so a crowd
        // heaves rather than marching in step (the user's picture of the dead ramming).
        pace = 0;
        atDoor = true;
        const phase = (tick + z.id) % zc.ram.cycle;
        if (phase < zc.ram.back && d > 0) {
          gx = -dx / d;
          gy = -dy / d;
          pace = zc.ram.pace;
        } else if (phase === zc.ram.back && z.heardPoint !== null) {
          // Still against the door as the heave starts. An event only: not a stimulus.
          ctx.events.push({ type: 'doorWhump', tick, building: z.besieging, x: z.heardPoint.x, y: z.heardPoint.y, sim: null });
        }
        z.heardAt = tick;
      } else if (d <= zc.arriveRadius && z.target === null) {
        // Come to a door the living are behind (shots fired from it, a scream from inside):
        // it stays there, besieging, as if it had seen someone go in. Clearing the point
        // instead, a crowd drifted off, was called back by the next shot, and went back and
        // forth at the door for as long as the building held.
        const b = doorAt(world, ctx, z.heardPoint.x, z.heardPoint.y);
        if (b !== null) {
          z.besieging = b.id;
          z.besiegeUntil = tick + zc.besiegeTicks;
          pace = 0;
        } else z.heardPoint = null;
      } else if (d > 0) {
        gx = dx / d;
        gy = dy / d;
        // Closing on someone: no further than striking distance. A full step from closer
        // than a step carried it past them, and it turned back the next tick — 68% of
        // moves within 3 m of a target were reversals, the dead bouncing like a ball.
        if (z.target !== null) pace = Math.min(pace, Math.max(0, d - config.combat.contactRange * zc.closeIn) / speed);
        // Coming on into a door it besieges: this step reaches the door. The whump is
        // that arrival. An event only, so the dead do not hear it.
        if (
          z.besieging !== null &&
          z.heardPoint !== null &&
          (tick + z.id) % zc.ram.cycle >= zc.ram.back &&
          d > zc.arriveRadius &&
          d - speed * pace <= zc.arriveRadius
        ) {
          ctx.events.push({ type: 'doorWhump', tick, building: z.besieging, x: z.heardPoint.x, y: z.heardPoint.y, sim: null });
        }
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
      // Drifted up against a building with the living in it: to its door, to besiege it.
      // Drifting on up the scent, the dead slid round and round the walls of the houses
      // the living were in, and never tried the door.
      const b = peopledWall(world, ctx, z);
      if (b !== null) {
        const e = entranceNearest(b, z.x, z.y);
        z.state = 'active';
        z.stateUntil = null;
        z.besieging = b.id;
        z.besiegeUntil = tick + zc.besiegeTicks;
        setHeard(z, e.x, e.y);
        z.heardAt = tick;
        ctx.zombieSpeed[z.id] = 0;
        continue;
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
    if (z.state === 'active' && !atDoor) {
      ctx.zombieHash.query(z.x, z.y, zc.flockRadius, ctx.ids2);
      let cx = 0, cy = 0, ax = 0, ay = 0, n = 0, crowd = 0, rx = 0, ry = 0;
      for (const oid of ctx.ids2) {
        if (oid === z.id) continue;
        const o = world.zombies[oid]!;
        if (o.state !== 'active') continue;
        const dx = o.x - z.x;
        const dy = o.y - z.y;
        const d = Math.hypot(dx, dy);
        // Walking with the dead gives an intact one away, for good: nobody takes it for one
        // of the living in that company (the user's note: it escaped the shooting the rest got).
        if (z.intact && !o.intact && d <= zc.intactCompany) z.intact = false;
        cx += dx;
        cy += dy;
        // Not the heading of one battering a door: it swings back and forth, and the dead
        // passing by took up the swing, bashing as they went.
        if (o.besieging === null) {
          ax += Math.cos(o.heading);
          ay += Math.sin(o.heading);
        }
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
  wakeNeighbours(world, ctx, alerts);
}

/**
 * Each fresh sighting wakes the dormant and idle dead within alertRadius of the
 * zombie that saw, sending them toward the survivor it saw. In sighting order (which
 * is zombie id order) and, per sighting, zombie id order.
 */
function wakeNeighbours(world: World, ctx: Context, alerts: { x: number; y: number; tx: number; ty: number }[]): void {
  const { config, tick, zombies } = world;
  for (const a of alerts) {
    ctx.zombieHash.query(a.x, a.y, config.zombie.alertRadius, ctx.ids2);
    ctx.ids2.sort((p, q) => p - q);
    for (const zid of ctx.ids2) {
      const o = zombies[zid]!;
      const idle = (o.state === 'active' || o.state === 'wandering') && o.target === null && o.heardPoint === null && o.besieging === null;
      if (o.state !== 'dormant' && !idle) continue;
      o.state = 'active';
      o.stateUntil = null;
      o.heardAt = tick;
      setHeard(o, a.tx, a.ty);
    }
  }
}
