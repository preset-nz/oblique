import { describe, expect, it } from 'vitest';
import { computeBufferSize, ensureBuffer, viewChangeNeedsRecomposite } from './paintScene';

describe('viewChangeNeedsRecomposite', () => {
  it('is false for a pure pan/zoom change — docW/docH unchanged', () => {
    const prev = { docW: 200, docH: 100 };
    const next = { docW: 200, docH: 100 };
    expect(viewChangeNeedsRecomposite(prev, next)).toBe(false);
  });

  it('is true when docW changes', () => {
    const prev = { docW: 200, docH: 100 };
    const next = { docW: 400, docH: 100 };
    expect(viewChangeNeedsRecomposite(prev, next)).toBe(true);
  });

  it('is true when docH changes', () => {
    const prev = { docW: 200, docH: 100 };
    const next = { docW: 200, docH: 250 };
    expect(viewChangeNeedsRecomposite(prev, next)).toBe(true);
  });
});

describe('computeBufferSize', () => {
  it('scales the document down by the level factor, rounding, minimum 1px', () => {
    expect(computeBufferSize(200, 100, 'working')).toEqual([100, 50]);
    expect(computeBufferSize(200, 100, 'draft')).toEqual([25, 13]);
    expect(computeBufferSize(200, 100, 'baked')).toEqual([200, 100]);
    expect(computeBufferSize(1, 1, 'draft')).toEqual([1, 1]);
  });
});

describe('ensureBuffer', () => {
  it('allocates a new buffer when none exists', () => {
    if (typeof OffscreenCanvas === 'undefined') return; // non-browser test environment
    const buffer = ensureBuffer(null, 100, 50);
    expect(buffer.width).toBe(100);
    expect(buffer.height).toBe(50);
  });

  it('reuses the existing buffer when the size is unchanged', () => {
    if (typeof OffscreenCanvas === 'undefined') return;
    const first = ensureBuffer(null, 100, 50);
    const second = ensureBuffer(first, 100, 50);
    expect(second).toBe(first);
  });

  it('allocates a fresh buffer when the size changed', () => {
    if (typeof OffscreenCanvas === 'undefined') return;
    const first = ensureBuffer(null, 100, 50);
    const second = ensureBuffer(first, 200, 100);
    expect(second).not.toBe(first);
    expect(second.width).toBe(200);
  });
});
