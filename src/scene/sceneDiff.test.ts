import { describe, expect, it } from 'vitest';
import { sceneChangedIgnoringDirty } from './sceneDiff';
import type { MaskDef, Scene } from './types';

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

function mask(featherPx: number): MaskDef {
  return {
    id: 'mask-1',
    shape: { kind: 'rect', rect: { x: 0, y: 0, w: 10, h: 10 } },
    appliedTransform2d: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    featherPx,
    expand: 0,
    invert: false,
  };
}

describe('sceneChangedIgnoringDirty — masks', () => {
  it('an edited mask definition is a real edit', () => {
    const a = scene({ masks: { 'mask-1': mask(0) } });
    const b = scene({ masks: { 'mask-1': mask(12) } });
    expect(sceneChangedIgnoringDirty(a, b)).toBe(true);
  });

  it('absent and empty mask tables are equivalent (pre-mask files)', () => {
    expect(sceneChangedIgnoringDirty(scene(), scene({ masks: {} }))).toBe(false);
  });

  it('identical mask tables register no change', () => {
    const a = scene({ masks: { 'mask-1': mask(5) } });
    const b = scene({ masks: { 'mask-1': mask(5) } });
    expect(sceneChangedIgnoringDirty(a, b)).toBe(false);
  });
});
