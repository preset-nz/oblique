import { beforeEach, describe, expect, it } from 'vitest';
import { useCacheVersionStore } from './cache';
import {
  clearAllHistograms,
  getHistogram,
  type HistogramBins,
  histogramFromWire,
  histogramKey,
  setHistogram,
  storeResponseHistograms,
} from './histograms';

const bins = (n: number): HistogramBins => ({
  luma: new Array(256).fill(n),
  r: new Array(256).fill(n),
  g: new Array(256).fill(n),
  b: new Array(256).fill(n),
});

beforeEach(() => clearAllHistograms());

describe('histogram cache', () => {
  it('keeps the last bins per modifier and bumps the cache version on a write', () => {
    const before = useCacheVersionStore.getState().cacheVersion;
    setHistogram('a', bins(1));
    setHistogram('b', bins(2));
    setHistogram('a', bins(3));
    expect(getHistogram('a')?.luma[0]).toBe(3);
    expect(getHistogram('b')?.luma[0]).toBe(2);
    expect(getHistogram('c')).toBeUndefined();
    expect(useCacheVersionStore.getState().cacheVersion).toBe(before + 3);
  });

  it('clearAllHistograms empties it', () => {
    setHistogram('a', bins(1));
    clearAllHistograms();
    expect(getHistogram('a')).toBeUndefined();
  });
});

describe('histogramFromWire', () => {
  it('takes four channels of 256 counts, and drops the rest of the entry', () => {
    const wire = { modifierIndex: 1, ...bins(7) };
    expect(histogramFromWire(wire)).toEqual(bins(7));
  });

  it.each([
    ['not an object', null],
    ['a short channel', { ...bins(1), r: [1, 2, 3] }],
    ['a missing channel', { luma: bins(1).luma, r: bins(1).r, g: bins(1).g }],
    ['a non-number count', { ...bins(1), b: new Array(256).fill('x') }],
  ])('refuses %s', (_name, wire) => {
    expect(histogramFromWire(wire)).toBeUndefined();
  });
});

describe('storeResponseHistograms', () => {
  it('files each entry under the modifier of that index that asked, and no other', () => {
    const asked = [{}, { histogramFor: histogramKey('layer', 'levels-1') }, {}];
    storeResponseHistograms([{ modifierIndex: 1, ...bins(4) }], asked);
    expect(getHistogram('layer/levels-1')?.luma[0]).toBe(4);
    expect(getHistogram('layer/levels-1')?.r).toHaveLength(256);
  });

  it('drops an entry for a modifier that did not ask, one out of range, or a bad one', () => {
    const asked = [{}, { histogramFor: 'layer/a' }];
    storeResponseHistograms(
      [
        { modifierIndex: 0, ...bins(1) },
        { modifierIndex: 9, ...bins(1) },
        { modifierIndex: 1, luma: [1] },
        null,
      ],
      asked,
    );
    expect(getHistogram('layer/a')).toBeUndefined();
  });

  it('does nothing for a response with no histograms', () => {
    const before = useCacheVersionStore.getState().cacheVersion;
    storeResponseHistograms(undefined, [{ histogramFor: 'layer/a' }]);
    expect(useCacheVersionStore.getState().cacheVersion).toBe(before);
  });

  it('keeps two layers with the same modifier id apart', () => {
    const asked = [{ histogramFor: histogramKey('one', 'm') }];
    storeResponseHistograms([{ modifierIndex: 0, ...bins(1) }], asked);
    expect(getHistogram(histogramKey('two', 'm'))).toBeUndefined();
  });
});
