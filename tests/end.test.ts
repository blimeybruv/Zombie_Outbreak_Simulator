import { describe, expect, it } from 'vitest';
import { lonerLine } from '../src/ui/end';

describe('the end screen', () => {
  it('says loners did best only when they did', () => {
    expect(lonerLine({ loners: 102, lonersLived: 1, civilians: 3725, civiliansLived: 112 })).toMatch(/^Keeping away from other people did not save them: 1% .* against 3% /);
    expect(lonerLine({ loners: 100, lonersLived: 40, civilians: 1000, civiliansLived: 300 })).toMatch(/^Those who kept away from other people did best: 40% /);
    expect(lonerLine({ loners: 100, lonersLived: 30, civilians: 1000, civiliansLived: 300 })).toMatch(/^Keeping to themselves made no difference/);
    expect(lonerLine({ loners: 0, lonersLived: 0, civilians: 1000, civiliansLived: 300 })).toBeNull();
  });
});
