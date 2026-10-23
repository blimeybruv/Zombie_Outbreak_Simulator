import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { generateMap } from '../src/sim/mapgen/generate';
import { LABEL_FONT_MID, LABEL_FONT_NEAR, ROAD_MAIN_MIN_W, placeStreetLabels, streetLabelCandidates, streetLabelsForMode } from '../src/render/street-labels';

function pack(
  segs: { x1: number; y1: number; x2: number; y2: number; w: number }[],
  names: string[],
) {
  const streets = new Float64Array(segs.length * 5);
  segs.forEach((s, i) => streets.set([s.x1, s.y1, s.x2, s.y2, s.w], i * 5));
  return streetLabelCandidates(streets, names);
}

describe('street labels', () => {
  it('uses the carriageway main-road cut', () => {
    expect(ROAD_MAIN_MIN_W).toBe(16);
    expect(config.map.streetWidth.main).toBeGreaterThanOrEqual(ROAD_MAIN_MIN_W);
    expect(config.map.streetWidth.highway).toBeGreaterThanOrEqual(ROAD_MAIN_MIN_W);
    expect(config.map.streetWidth.standard).toBeLessThan(ROAD_MAIN_MIN_W);
    expect(config.map.streetWidth.alley).toBeLessThan(ROAD_MAIN_MIN_W);
  });

  it('labels every long named street at near zoom and only main roads at mid', () => {
    const set = pack(
      [
        { x1: 0, y1: 0, x2: 80, y2: 0, w: 6 },
        { x1: 0, y1: 30, x2: 80, y2: 30, w: 12 },
        { x1: 0, y1: 60, x2: 80, y2: 60, w: 20 },
        { x1: 0, y1: 90, x2: 80, y2: 90, w: 28 },
        { x1: 0, y1: 120, x2: 20, y2: 120, w: 20 },
      ],
      ['Alley', 'Standard', 'Main', 'Highway', 'Short'],
    );
    expect(set.labels.map((l) => l.name).sort()).toEqual(['Alley', 'Highway', 'Main', 'Standard']);
    expect(set.skippedLength).toBe(1);
    expect(streetLabelsForMode(set.labels, 'near').map((l) => l.name).sort()).toEqual(['Alley', 'Highway', 'Main', 'Standard']);
    expect(streetLabelsForMode(set.labels, 'mid').map((l) => l.name).sort()).toEqual(['Highway', 'Main']);
    expect(set.labels.find((l) => l.name === 'Main')!.width).toBe(20);
  });

  it('on map seed 1, mid labels are the main-road subset of the near set', () => {
    const map = generateMap(config, 1, true);
    const streets = new Float64Array(map.streets.length * 5);
    const names: string[] = [];
    const widths = new Map<string, Set<number>>();
    map.streets.forEach((s, i) => {
      const a = map.nodes[s.a]!, b = map.nodes[s.b]!;
      streets.set([a.x, a.y, b.x, b.y, s.width], i * 5);
      names.push(s.name);
      if (s.name) {
        let set = widths.get(s.name);
        if (!set) widths.set(s.name, (set = new Set()));
        set.add(s.width);
      }
    });
    expect([...widths.values()].every((w) => w.size === 1)).toBe(true);
    const { labels } = streetLabelCandidates(streets, names);
    const near = streetLabelsForMode(labels, 'near');
    const mid = streetLabelsForMode(labels, 'mid');
    expect(near).toHaveLength(labels.length);
    expect(mid.length).toBeLessThan(near.length);
    expect(mid.every((l) => l.width >= ROAD_MAIN_MIN_W)).toBe(true);
    expect(near.some((l) => l.width < ROAD_MAIN_MIN_W)).toBe(true);
    const shownNear = placeStreetLabels(near, 2.4, LABEL_FONT_NEAR).placed.length;
    const shownMid = placeStreetLabels(mid, 0.55, LABEL_FONT_MID).placed.length;
    expect(shownMid).toBeLessThan(shownNear);
    expect(shownMid).toBe(mid.length);
  });
});
