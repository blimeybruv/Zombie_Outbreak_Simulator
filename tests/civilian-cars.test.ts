import { describe, expect, it } from 'vitest';
import { CIVILIAN_STYLES, carVisualHash, civilianLivery, civilianStyle } from '../src/render/civilian-cars';
import { CIVILIAN } from '../src/render/palette';

describe('civilian car appearance', () => {
  it('is a pure function of the car id', () => {
    for (let id = 0; id < 500; id++) {
      expect(civilianStyle(id)).toBe(civilianStyle(id));
      expect(civilianLivery(id)).toBe(civilianLivery(id));
      expect(CIVILIAN_STYLES).toContain(civilianStyle(id));
      expect(civilianLivery(id)).toBeGreaterThanOrEqual(0);
      expect(civilianLivery(id)).toBeLessThan(CIVILIAN.length);
    }
  });

  it('keeps the hash stable for a handful of ids', () => {
    expect([0, 1, 2, 18, 100, 2638].map(carVisualHash)).toEqual([
      3337415276, 2567845730, 2500147704, 3337063031, 130186059, 2368443558,
    ]);
  });

  it('uses every body and every paint across a fleet', () => {
    const styles = new Set<string>();
    const liveries = new Set<number>();
    for (let id = 0; id < 2000; id++) {
      styles.add(civilianStyle(id));
      liveries.add(civilianLivery(id));
    }
    expect([...styles].sort()).toEqual([...CIVILIAN_STYLES].sort());
    expect(liveries.size).toBe(CIVILIAN.length);
  });

  it('keeps sedans and hatchbacks in the majority', () => {
    let common = 0;
    const n = 3000;
    for (let id = 0; id < n; id++) if (civilianStyle(id) === 'sedan' || civilianStyle(id) === 'hatchback') common++;
    expect(common / n).toBeGreaterThan(0.6);
    expect(common / n).toBeLessThan(0.8);
  });
});
