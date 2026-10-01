import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as backgroundSource from './backgroundSource';

function bitmap(): ImageBitmap {
  return { width: 10, height: 10, close: vi.fn() } as unknown as ImageBitmap;
}

function deps(overrides: Partial<backgroundSource.BackgroundDecodeDeps> = {}) {
  return {
    readFile: vi.fn(async () => new Uint8Array([1])),
    decode: vi.fn(async () => bitmap()),
    ...overrides,
  };
}

const image = (sourcePath: string) => ({
  type: 'image' as const,
  sourcePath,
  sourceSize: [10, 10] as [number, number],
});

beforeEach(() => {
  backgroundSource.clear();
});

describe('backgroundSource holder (background-image.md)', () => {
  it('get is keyed by path: a different path reads nothing, never stale content', () => {
    const b = bitmap();
    backgroundSource.set('/a.png', b);
    expect(backgroundSource.get('/a.png')).toBe(b);
    expect(backgroundSource.get('/b.png')).toBeUndefined();
  });

  it('set closes the bitmap it replaces; clear closes and empties the slot', () => {
    const first = bitmap();
    const second = bitmap();
    backgroundSource.set('/a.png', first);
    backgroundSource.set('/b.png', second);
    expect(first.close).toHaveBeenCalledTimes(1);
    backgroundSource.clear();
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(backgroundSource.heldPath()).toBeUndefined();
    expect(backgroundSource.get('/b.png')).toBeUndefined();
  });

  it('bumps the version when a bitmap lands or is dropped (the recomposite trigger)', () => {
    const v0 = backgroundSource.useBackgroundSourceStore.getState().version;
    backgroundSource.set('/a.png', bitmap());
    const v1 = backgroundSource.useBackgroundSourceStore.getState().version;
    expect(v1).toBeGreaterThan(v0);
    backgroundSource.clear();
    expect(backgroundSource.useBackgroundSourceStore.getState().version).toBeGreaterThan(v1);
  });

  it('reconcile decodes an image background; a non-image background drops the holder', async () => {
    await backgroundSource.reconcile(image('/a.png'), deps());
    expect(backgroundSource.get('/a.png')).toBeDefined();
    await backgroundSource.reconcile({ type: 'color', color: '#fff' }, deps());
    expect(backgroundSource.heldPath()).toBeUndefined();
  });

  it('reconcile leaves an already-held path alone (no re-decode)', async () => {
    const d = deps();
    await backgroundSource.reconcile(image('/a.png'), d);
    await backgroundSource.reconcile(image('/a.png'), d);
    expect(d.decode).toHaveBeenCalledTimes(1);
  });

  it('an unreadable source flags missing and holds nothing — no throw', async () => {
    await backgroundSource.reconcile(
      image('/gone.png'),
      deps({
        readFile: vi.fn(async () => {
          throw new Error('gone');
        }),
      }),
    );
    expect(backgroundSource.heldPath()).toBeUndefined();
    expect(backgroundSource.useBackgroundSourceStore.getState().missing).toBe(true);
    await backgroundSource.reconcile(undefined, deps());
    expect(backgroundSource.useBackgroundSourceStore.getState().missing).toBe(false);
  });

  it('a decode that resolves after the user moved on is discarded and closed', async () => {
    let resolve: (b: ImageBitmap) => void = () => {};
    const late = bitmap();
    const slow = deps({
      decode: vi.fn(() => new Promise<ImageBitmap>((r) => (resolve = r))),
    });
    const pending = backgroundSource.reconcile(image('/slow.png'), slow);
    await Promise.resolve();
    await Promise.resolve();
    backgroundSource.clear(); // user chose none meanwhile
    resolve(late);
    await pending;
    expect(backgroundSource.heldPath()).toBeUndefined();
    expect(late.close).toHaveBeenCalledTimes(1);
  });
});
