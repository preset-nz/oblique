import { describe, expect, it } from 'vitest';
import { onlyNoteChanged, sceneChangedIgnoringDirty } from './sceneDiff';
import type { Scene, SceneBackground, VectorMaskRef } from './types';

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    nodes: [],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [100, 100],
    ...overrides,
  };
}

function maskRef(featherPx: number): VectorMaskRef {
  return {
    id: 'ref-1',
    nodeId: 'v1',
    featherPx,
    expand: 0,
    invert: false,
  };
}

describe('sceneChangedIgnoringDirty — maskRefs', () => {
  it('an edited mask ref definition is a real edit', () => {
    const a = scene({ maskRefs: { 'ref-1': maskRef(0) } });
    const b = scene({ maskRefs: { 'ref-1': maskRef(12) } });
    expect(sceneChangedIgnoringDirty(a, b)).toBe(true);
  });

  it('absent and empty maskRefs tables are equivalent (pre-mask files)', () => {
    expect(sceneChangedIgnoringDirty(scene(), scene({ maskRefs: {} }))).toBe(false);
  });

  it('identical maskRefs tables register no change', () => {
    const a = scene({ maskRefs: { 'ref-1': maskRef(5) } });
    const b = scene({ maskRefs: { 'ref-1': maskRef(5) } });
    expect(sceneChangedIgnoringDirty(a, b)).toBe(false);
  });
});

describe('sceneChangedIgnoringDirty — background', () => {
  it('setting, changing or clearing the background is a real edit', () => {
    const image: SceneBackground = { type: 'image', sourcePath: '/bg.png', sourceSize: [10, 10] };
    expect(sceneChangedIgnoringDirty(scene(), scene({ background: image }))).toBe(true);
    expect(
      sceneChangedIgnoringDirty(
        scene({ background: { type: 'color', color: '#000000' } }),
        scene({ background: image }),
      ),
    ).toBe(true);
    expect(sceneChangedIgnoringDirty(scene({ background: image }), scene())).toBe(true);
  });

  it('an identical background registers no change', () => {
    const mk = () =>
      scene({ background: { type: 'image', sourcePath: '/bg.png', sourceSize: [10, 10] } });
    expect(sceneChangedIgnoringDirty(mk(), mk())).toBe(false);
  });
});

describe('sceneChangedIgnoringDirty — note (composition-note.md)', () => {
  it('a changed note is a real edit', () => {
    expect(sceneChangedIgnoringDirty(scene({ note: 'a' }), scene({ note: 'ab' }))).toBe(true);
  });

  it('adding or removing a note is a real edit', () => {
    expect(sceneChangedIgnoringDirty(scene(), scene({ note: 'hello' }))).toBe(true);
    expect(sceneChangedIgnoringDirty(scene({ note: 'hello' }), scene())).toBe(true);
  });

  it('absent and empty notes are equivalent', () => {
    expect(sceneChangedIgnoringDirty(scene(), scene({ note: '' }))).toBe(false);
  });

  it('identical notes register no change', () => {
    expect(sceneChangedIgnoringDirty(scene({ note: 'same' }), scene({ note: 'same' }))).toBe(false);
  });
});

describe('onlyNoteChanged', () => {
  const base = {
    id: 's',
    nodes: [],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [10, 10],
  } as unknown as Scene;

  it('is true when only the note differs', () => {
    expect(onlyNoteChanged({ ...base, note: 'a' }, { ...base, note: 'b' })).toBe(true);
    expect(onlyNoteChanged({ ...base, note: 'a' }, base)).toBe(true);
  });

  it('is false when the note is unchanged or anything else changed too', () => {
    expect(onlyNoteChanged(base, { ...base })).toBe(false);
    expect(onlyNoteChanged({ ...base, note: 'a' }, { ...base, note: 'b', nodes: [] })).toBe(false);
  });
});
