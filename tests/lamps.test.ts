import { describe, expect, it } from 'vitest';
import { LAMP_GLOW_RADIUS, LAMP_KERB_INSET } from '../src/render/lamps';
import { LAMP_GLOW_CORE, LAMP_GLOW_EDGE, LAMP_HEAD } from '../src/render/palette';

describe('street lamp glow', () => {
  it('is the softer pool that still meets over a main road', () => {
    expect(LAMP_GLOW_RADIUS).toBeCloseTo((16 * 4) / 5.5, 8);
    // Opposite kerbs of a 20 m road, each inset from the carriageway edge.
    expect(LAMP_GLOW_RADIUS * 2).toBeGreaterThan(20 - 2 * LAMP_KERB_INSET);
    expect(LAMP_GLOW_CORE).toBe('rgba(255, 214, 150, 0.22)');
    expect(LAMP_GLOW_EDGE).toBe('rgba(255, 180, 110, 0)');
    expect(LAMP_HEAD).toBe('rgba(255, 210, 140, 0.22)');
  });
});
