import { describe, expect, it } from 'vitest';
import {
  ASPECT_PRESETS,
  computeDocumentSize,
  DEFAULT_LONG_EDGE,
  describeDocumentSize,
  longEdgeOf,
  nextDocumentSize,
} from './aspect';

describe('longEdgeOf', () => {
  it('returns the larger of the two edges', () => {
    expect(longEdgeOf([800, 600])).toBe(800);
    expect(longEdgeOf([600, 800])).toBe(800);
  });

  it('falls back to the default long edge for an empty document', () => {
    expect(longEdgeOf([0, 0])).toBe(DEFAULT_LONG_EDGE);
    expect(longEdgeOf([-1, 100])).toBe(DEFAULT_LONG_EDGE);
  });
});

describe('computeDocumentSize', () => {
  it('puts the long edge on width for landscape', () => {
    expect(computeDocumentSize(2048, 4 / 3, 'landscape')).toEqual([2048, 1536]);
  });

  it('puts the long edge on height for portrait', () => {
    expect(computeDocumentSize(2048, 4 / 3, 'portrait')).toEqual([1536, 2048]);
  });

  it('1:1 is orientation-invariant', () => {
    expect(computeDocumentSize(1000, 1, 'landscape')).toEqual([1000, 1000]);
    expect(computeDocumentSize(1000, 1, 'portrait')).toEqual([1000, 1000]);
  });

  it('every preset produces a positive integer size', () => {
    for (const preset of ASPECT_PRESETS) {
      for (const orientation of ['landscape', 'portrait'] as const) {
        const [w, h] = computeDocumentSize(2048, preset.ratio, orientation);
        expect(Number.isInteger(w)).toBe(true);
        expect(Number.isInteger(h)).toBe(true);
        expect(w).toBeGreaterThan(0);
        expect(h).toBeGreaterThan(0);
      }
    }
  });
});

describe('nextDocumentSize', () => {
  it('derives the long edge from the current document size', () => {
    const preset = ASPECT_PRESETS.find((p) => p.id === '1:2');
    if (!preset) throw new Error('fixture preset missing');
    expect(nextDocumentSize([800, 600], preset, 'landscape')).toEqual([800, 400]);
  });

  it('uses the default long edge for an empty document', () => {
    const preset = ASPECT_PRESETS.find((p) => p.id === '1:1');
    if (!preset) throw new Error('fixture preset missing');
    expect(nextDocumentSize([0, 0], preset, 'landscape')).toEqual([
      DEFAULT_LONG_EDGE,
      DEFAULT_LONG_EDGE,
    ]);
  });
});

describe('describeDocumentSize', () => {
  it('identifies an exact preset match and orientation', () => {
    expect(describeDocumentSize([2048, 1536])).toEqual({
      presetId: '4:3',
      orientation: 'landscape',
    });
    expect(describeDocumentSize([1536, 2048])).toEqual({
      presetId: '4:3',
      orientation: 'portrait',
    });
  });

  it('returns no preset for an arbitrary aspect ratio', () => {
    expect(describeDocumentSize([777, 421]).presetId).toBeNull();
  });

  it('returns landscape/null for an empty document', () => {
    expect(describeDocumentSize([0, 0])).toEqual({ presetId: null, orientation: 'landscape' });
  });
});
