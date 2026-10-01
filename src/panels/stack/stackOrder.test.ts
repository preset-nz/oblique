import { describe, expect, it } from 'vitest';
import { invertIndex, toDisplayOrder } from './stackOrder';

describe('toDisplayOrder', () => {
  it('reverses model order into bottom-to-top display order', () => {
    // Model order [invert, levels, grain]: invert applies first (bottom),
    // grain applies last (top). Displayed top-to-bottom reads [grain,
    // levels, invert] — last-applied first in the rendered list.
    expect(toDisplayOrder(['invert', 'levels', 'grain'])).toEqual(['grain', 'levels', 'invert']);
  });

  it('is its own inverse (reversing twice restores model order)', () => {
    const model = ['a', 'b', 'c', 'd'];
    expect(toDisplayOrder(toDisplayOrder(model))).toEqual(model);
  });

  it('handles empty and single-element stacks', () => {
    expect(toDisplayOrder([])).toEqual([]);
    expect(toDisplayOrder(['only'])).toEqual(['only']);
  });
});

describe('invertIndex', () => {
  it('maps model index 0 (first-applied) to the last display index (bottom row)', () => {
    expect(invertIndex(0, 3)).toBe(2);
  });

  it('maps the last model index (last-applied) to display index 0 (top row)', () => {
    expect(invertIndex(2, 3)).toBe(0);
  });

  it('is self-inverse: inverting twice returns the original index', () => {
    for (let i = 0; i < 5; i++) {
      expect(invertIndex(invertIndex(i, 5), 5)).toBe(i);
    }
  });
});
