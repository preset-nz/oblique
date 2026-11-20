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

describe('the raster rect beside the bitmap (layer-overflow.md)', () => {
  const grown = { x: -128, y: 0, w: 2304, h: 1536 };

  it('set stores the rect with the bitmap, per level; absent means the logical frame', () => {
    cache.set('t', 'draft', fakeBitmap(), grown);
    cache.set('t', 'working', fakeBitmap());
    expect(cache.getRect('t', 'draft')).toEqual(grown);
    expect(cache.getRect('t', 'working')).toBeUndefined();
    expect(cache.getRect('other', 'draft')).toBeUndefined();
  });

  it('a later write replaces the rect, and a write without one drops the old', () => {
    cache.set('t', 'draft', fakeBitmap(), grown);
    cache.set('t', 'draft', fakeBitmap(), { ...grown, x: -192 });
    expect(cache.getRect('t', 'draft')?.x).toBe(-192);
    cache.set('t', 'draft', fakeBitmap());
    expect(cache.getRect('t', 'draft')).toBeUndefined();
  });

  it('keeps its own copy: mutating the rect passed in changes nothing', () => {
    const rect = { ...grown };
    cache.set('t', 'baked', fakeBitmap(), rect);
    rect.x = 0;
    expect(cache.getRect('t', 'baked')?.x).toBe(-128);
  });

  it('clearLevel, clearNode and clearAll drop the rect with the bitmap', () => {
    cache.set('t', 'draft', fakeBitmap(), grown);
    cache.set('t', 'working', fakeBitmap(), grown);
    cache.clearLevel('t', 'draft');
    expect(cache.getRect('t', 'draft')).toBeUndefined();
    expect(cache.getRect('t', 'working')).toEqual(grown);
    cache.clearNode('t');
    expect(cache.getRect('t', 'working')).toBeUndefined();
    cache.set('u', 'baked', fakeBitmap(), grown);
    cache.clearAll();
    expect(cache.getRect('u', 'baked')).toBeUndefined();
  });
});
