import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cache from './cache';
import { useCacheVersionStore } from './cache';

/** Minimal ImageBitmap-like stub — vitest's node environment has no real ImageBitmap. */
function fakeBitmap(): ImageBitmap {
  return { close: vi.fn() } as unknown as ImageBitmap;
}

beforeEach(() => {
  cache.clearAll();
  useCacheVersionStore.setState({ cacheVersion: 0 });
});

describe('set / get', () => {
  it('round-trips a bitmap at a given level', () => {
    const bitmap = fakeBitmap();
    cache.set('node-1', 'draft', bitmap);
    expect(cache.get('node-1', 'draft')).toBe(bitmap);
    expect(cache.get('node-1', 'working')).toBeUndefined();
  });

  it('bumps cacheVersion on write', () => {
    const before = useCacheVersionStore.getState().cacheVersion;
    cache.set('node-1', 'draft', fakeBitmap());
    expect(useCacheVersionStore.getState().cacheVersion).toBe(before + 1);
  });

  it('closes the bitmap it replaces at the same level', () => {
    const first = fakeBitmap();
    cache.set('node-1', 'draft', first);
    cache.set('node-1', 'draft', fakeBitmap());
    expect(first.close).toHaveBeenCalledOnce();
  });
});

describe('clearLevel', () => {
  it('closes and evicts only the given level', () => {
    const draft = fakeBitmap();
    const working = fakeBitmap();
    cache.set('node-1', 'draft', draft);
    cache.set('node-1', 'working', working);

    cache.clearLevel('node-1', 'draft');

    expect(draft.close).toHaveBeenCalledOnce();
    expect(cache.get('node-1', 'draft')).toBeUndefined();
    expect(cache.get('node-1', 'working')).toBe(working);
    expect(working.close).not.toHaveBeenCalled();
  });

  it('is a no-op for an unknown node', () => {
    expect(() => cache.clearLevel('missing', 'draft')).not.toThrow();
  });
});

describe('clearNode', () => {
  it('closes every level and drops the entry', () => {
    const draft = fakeBitmap();
    const working = fakeBitmap();
    const baked = fakeBitmap();
    cache.set('node-1', 'draft', draft);
    cache.set('node-1', 'working', working);
    cache.set('node-1', 'baked', baked);

    cache.clearNode('node-1');

    expect(draft.close).toHaveBeenCalledOnce();
    expect(working.close).toHaveBeenCalledOnce();
    expect(baked.close).toHaveBeenCalledOnce();
    expect(cache.get('node-1', 'draft')).toBeUndefined();
    expect(cache.get('node-1', 'working')).toBeUndefined();
    expect(cache.get('node-1', 'baked')).toBeUndefined();
  });

  it('tolerates bitmaps without a close method (guard for non-browser environments)', () => {
    const bareBitmap = {} as ImageBitmap;
    cache.set('node-1', 'draft', bareBitmap);
    expect(() => cache.clearNode('node-1')).not.toThrow();
  });
});
