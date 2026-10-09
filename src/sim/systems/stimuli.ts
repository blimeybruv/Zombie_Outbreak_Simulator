// Tick step 3, plus the one way noise enters the world.

import type { BuildingId, StimulusKind, World } from '../state';

export function emitStimulus(
  world: World,
  x: number,
  y: number,
  kind: StimulusKind,
  radius: number,
  indoors: boolean,
  intensity = world.config.combat.weaponNoiseIntensity,
  from: BuildingId | null = null,
): void {
  if (radius <= 0) return;
  const { config, tick } = world;
  world.stimuli.push({
    x,
    y,
    kind,
    radius: indoors ? radius * config.combat.indoorNoiseFactor : radius,
    intensity,
    createdAt: tick,
    expiresAt: tick + config.stimulus.decay,
    from,
  });
}

/** Intensity of a stimulus at a point: full at the origin, zero at the radius. */
export function intensityAt(s: { x: number; y: number; radius: number; intensity: number }, x: number, y: number): number {
  const d = Math.hypot(x - s.x, y - s.y);
  return d >= s.radius ? 0 : s.intensity * (1 - d / s.radius);
}

export function expireStimuli(world: World): void {
  world.stimuli = world.stimuli.filter((s) => s.expiresAt > world.tick);
}
