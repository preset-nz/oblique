import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportDeps } from '@/project/import';
import { useProjectMetaStore } from '@/project/projectMeta';
import { duplicateNode } from './duplicateNode';
import * as sources from './sources';
import { DUPLICATE_OFFSET_PX, useSceneStore } from './store';
import type { Modifier, PixelNode, SceneNode, TextNode, VectorMaskRef, VectorNode } from './types';

function pixelNode(id: string, overrides: Partial<PixelNode> = {}): PixelNode {
  return {
    id,
    label: 'Eye',
    type: 'pixel',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 0.8,
    dirty: { draft: false, working: false },
    sourcePath: '/tmp/eye.png',
    sourceSize: [100, 60],
    ...overrides,
  };
}

function vectorNode(id: string, overrides: Partial<VectorNode> = {}): VectorNode {
  return {
    id,
    label: 'Shape',
    type: 'vector',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: false, working: false },
    paths: [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 }, handleOut: { x: 5, y: 0 } },
          { point: { x: 10, y: 10 }, handleIn: { x: 5, y: 10 } },
        ],
      },
    ],
    fillRule: 'evenodd',
    ...overrides,
  };
}

function textNode(id: string, overrides: Partial<TextNode> = {}): TextNode {
  return {
    id,
    label: 'Hello',
    type: 'text',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: false, working: false },
    content: 'Hello',
    font: {
      family: 'Inter',
      style: 'Regular',
      postscriptName: 'Inter-Regular',
      weight: 400,
      italic: false,
      category: 'sans',
    } as TextNode['font'],
    fontSize: 48,
    tracking: 0,
    kerning: 100,
    lineHeight: 1.2,
    align: 'left',
    fill: '#ffffff',
    stroke: { color: '#000000', width: 2 },
    position: { x: 10, y: 80 },
    ...overrides,
  };
}

function modifier(id: string, overrides: Partial<Modifier> = {}): Modifier {
  return { id, type: 'gaussian_blur', enabled: true, params: { radius: 4 }, ...overrides };
}

function setNodes(nodes: SceneNode[], maskRefs?: Record<string, VectorMaskRef>) {
  useSceneStore.setState({
    scene: { ...useSceneStore.getState().scene, nodes, ...(maskRefs ? { maskRefs } : {}) },
  });
}

const nodes = () => useSceneStore.getState().scene.nodes;
const maskRefs = () => useSceneStore.getState().scene.maskRefs;

beforeEach(() => {
  sources.clearAll();
  useSceneStore.setState({
    scene: {
      id: 'scene-1',
      nodes: [],
      cameras: [],
      defaultCameraId: null,
      resolution: 'working',
      documentSize: [200, 200],
    },
    bakingNodeIds: new Set(),
  });
  sources.useSourceMissingStore.setState({ missing: {} });
});

describe('store.duplicateNode', () => {
  it('returns null for an unknown id and leaves the scene alone', () => {
    setNodes([pixelNode('a')]);
    const before = useSceneStore.getState().scene;
    expect(useSceneStore.getState().duplicateNode('nope')).toBeNull();
    expect(useSceneStore.getState().scene).toBe(before);
  });

  it('inserts the copy at the original index (directly above it)', () => {
    setNodes([pixelNode('top'), pixelNode('a'), pixelNode('bottom')]);
    const newId = useSceneStore.getState().duplicateNode('a');
    expect(nodes().map((n) => n.id)).toEqual(['top', newId, 'a', 'bottom']);
  });

  it('labels, offsets, activates and dirties the copy', () => {
    setNodes([
      pixelNode('a', {
        state: 'locked',
        transform2d: { x: 4, y: 6, scaleX: 2, scaleY: 3, rotation: 0.5 },
      }),
    ]);
    const newId = useSceneStore.getState().duplicateNode('a');
    const copy = nodes().find((n) => n.id === newId) as PixelNode;
    expect(copy.id).not.toBe('a');
    expect(copy.label).toBe('Eye copy');
    expect(copy.state).toBe('active');
    expect(copy.dirty).toEqual({ draft: true, working: true });
    expect(copy.transform2d).toEqual({
      x: 4 + DUPLICATE_OFFSET_PX,
      y: 6 + DUPLICATE_OFFSET_PX,
      scaleX: 2,
      scaleY: 3,
      rotation: 0.5,
    });
    expect(copy.opacity).toBe(0.8);
    expect(copy.sourcePath).toBe('/tmp/eye.png');
    expect(copy.sourceSize).toEqual([100, 60]);
    // The original is untouched: still locked, not re-dirtied, no transform added.
    const original = nodes().find((n) => n.id === 'a') as PixelNode;
    expect(original.state).toBe('locked');
    expect(original.dirty).toEqual({ draft: false, working: false });
    expect(original.transform2d?.x).toBe(4);
  });

  it('offsets from identity when the original has no transform2d', () => {
    setNodes([pixelNode('a')]);
    const newId = useSceneStore.getState().duplicateNode('a');
    const copy = nodes().find((n) => n.id === newId);
    expect(copy?.transform2d).toEqual({
      x: DUPLICATE_OFFSET_PX,
      y: DUPLICATE_OFFSET_PX,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    });
  });

  it('copies modifiers with fresh ids and independent params, preserving order and enabled', () => {
    setNodes([
      pixelNode('a', {
        modifiers: [
          modifier('m1'),
          modifier('m2', { type: 'levels', enabled: false, params: { gamma: 1, label: 'x' } }),
          modifier('m3', { type: 'invert', params: {} }),
        ],
      }),
    ]);
    const newId = useSceneStore.getState().duplicateNode('a');
    const original = nodes().find((n) => n.id === 'a') as PixelNode;
    const copy = nodes().find((n) => n.id === newId) as PixelNode;
    expect(copy.modifiers.map((m) => m.type)).toEqual(['gaussian_blur', 'levels', 'invert']);
    expect(copy.modifiers.map((m) => m.enabled)).toEqual([true, false, true]);
    const ids = [...original.modifiers, ...copy.modifiers].map((m) => m.id);
    expect(new Set(ids).size).toBe(6);
    copy.modifiers.forEach((m, i) => {
      expect(m.params).toEqual(original.modifiers[i].params);
      expect(m.params).not.toBe(original.modifiers[i].params);
    });
    copy.modifiers[0].params.radius = 99;
    expect(original.modifiers[0].params.radius).toBe(4);
  });

  it('copies a maskRef under a fresh id with the same nodeId and no extra node', () => {
    const ref: VectorMaskRef = { id: 'r1', nodeId: 'sel', featherPx: 3, expand: 1, invert: false };
    setNodes(
      [
        pixelNode('a', { modifiers: [modifier('m1', { maskId: 'r1' })] }),
        vectorNode('sel', { label: 'Selection (rect)', visible: false }),
      ],
      { r1: ref },
    );
    const newId = useSceneStore.getState().duplicateNode('a');

    expect(nodes()).toHaveLength(3); // only the copy was added; 'sel' is shared, not duplicated
    expect(Object.keys(maskRefs() ?? {})).toHaveLength(2);
    const copy = nodes().find((n) => n.id === newId) as PixelNode;
    const newMaskId = copy.modifiers[0].maskId as string;
    expect(newMaskId).toBeDefined();
    expect(newMaskId).not.toBe('r1');
    expect(maskRefs()?.[newMaskId]).toEqual({ ...ref, id: newMaskId });
    expect(maskRefs()?.r1).toEqual(ref);
    expect((nodes().find((n) => n.id === 'a') as PixelNode).modifiers[0].maskId).toBe('r1');
  });

  it('carries a node-pinned ref verbatim (space + attachTransform) as an independent object (mask-follows-node.md)', () => {
    const attachTransform = { x: 5, y: 6, scaleX: 1.5, scaleY: 1.5, rotation: 0.4 };
    const ref: VectorMaskRef = {
      id: 'r1',
      nodeId: 'sel',
      featherPx: 3,
      expand: 1,
      invert: false,
      space: 'node',
      attachTransform,
    };
    setNodes(
      [
        pixelNode('a', { modifiers: [modifier('m1', { maskId: 'r1' })] }),
        vectorNode('sel', { label: 'Selection (rect)', visible: false }),
      ],
      { r1: ref },
    );
    const newId = useSceneStore.getState().duplicateNode('a');

    const copy = nodes().find((n) => n.id === newId) as PixelNode;
    const copied = maskRefs()?.[copy.modifiers[0].maskId as string];
    expect(copied?.space).toBe('node');
    expect(copied?.attachTransform).toEqual(attachTransform);
    expect(copied?.attachTransform).not.toBe(maskRefs()?.r1.attachTransform);
    // The copy is offset, but its mask still reads from the same attach frame — it travels with the copy.
    expect(copy.transform2d?.x).toBe(DUPLICATE_OFFSET_PX);
  });

  it('drops a dangling maskId on the copy', () => {
    setNodes([pixelNode('a', { modifiers: [modifier('m1', { maskId: 'gone' })] })]);
    const newId = useSceneStore.getState().duplicateNode('a');
    const copy = nodes().find((n) => n.id === newId) as PixelNode;
    expect('maskId' in copy.modifiers[0]).toBe(false);
    expect(maskRefs()).toBeUndefined();
  });

  it('deep-copies vector paths and anchors', () => {
    setNodes([vectorNode('v')]);
    const newId = useSceneStore.getState().duplicateNode('v');
    const original = nodes().find((n) => n.id === 'v') as VectorNode;
    const copy = nodes().find((n) => n.id === newId) as VectorNode;
    expect(copy.fillRule).toBe('evenodd');
    expect(copy.paths).toEqual(original.paths);
    expect(copy.paths).not.toBe(original.paths);
    expect(copy.paths[0]).not.toBe(original.paths[0]);
    expect(copy.paths[0].anchors[0]).not.toBe(original.paths[0].anchors[0]);
    expect(copy.paths[0].anchors[0].point).not.toBe(original.paths[0].anchors[0].point);
    expect(copy.paths[0].anchors[0].handleOut).not.toBe(original.paths[0].anchors[0].handleOut);
    expect(copy.paths[0].anchors[1].handleIn).not.toBe(original.paths[0].anchors[1].handleIn);
    // Absent handles stay absent.
    expect('handleIn' in copy.paths[0].anchors[0]).toBe(false);
    copy.paths[0].anchors[0].point.x = 999;
    expect(original.paths[0].anchors[0].point.x).toBe(0);
  });

  it('deep-copies a text node (font, position, stroke) and leaves position unshifted', () => {
    setNodes([textNode('t')]);
    const newId = useSceneStore.getState().duplicateNode('t');
    const original = nodes().find((n) => n.id === 't') as TextNode;
    const copy = nodes().find((n) => n.id === newId) as TextNode;
    expect(copy.type).toBe('text');
    expect(copy.content).toBe('Hello');
    expect(copy.label).toBe('Hello copy');
    expect(copy.font).toEqual(original.font);
    expect(copy.font).not.toBe(original.font);
    expect(copy.position).toEqual({ x: 10, y: 80 });
    expect(copy.position).not.toBe(original.position);
    expect(copy.stroke).toEqual(original.stroke);
    expect(copy.stroke).not.toBe(original.stroke);
    expect(copy.transform2d?.x).toBe(DUPLICATE_OFFSET_PX);
  });

  it('keeps a null text stroke null', () => {
    setNodes([textNode('t', { stroke: null })]);
    const newId = useSceneStore.getState().duplicateNode('t');
    expect((nodes().find((n) => n.id === newId) as TextNode).stroke).toBeNull();
  });
});

describe('duplicateNode (source-map orchestration)', () => {
  function stubDeps(): ImportDeps & { bitmaps: ImageBitmap[] } {
    const bitmaps: ImageBitmap[] = [];
    return {
      bitmaps,
      readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
      decode: vi.fn(async () => {
        const b = { width: 100, height: 60, close: vi.fn() } as unknown as ImageBitmap;
        bitmaps.push(b);
        return b;
      }),
    };
  }

  it('returns null for a missing node without decoding', async () => {
    const deps = stubDeps();
    expect(await duplicateNode('nope', deps)).toBeNull();
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it('re-decodes the source for the copy; never shares the original bitmap', async () => {
    setNodes([pixelNode('a')]);
    const original = { width: 100, height: 60, close: vi.fn() } as unknown as ImageBitmap;
    sources.set('a', original);
    const deps = stubDeps();

    const newId = await duplicateNode('a', deps);

    expect(newId).not.toBeNull();
    expect(deps.readFile).toHaveBeenCalledWith('/tmp/eye.png');
    const copyBitmap = sources.get(newId as string);
    expect(copyBitmap).toBe(deps.bitmaps[0]);
    expect(copyBitmap).not.toBe(original);
    expect(sources.get('a')).toBe(original);
    expect(sources.isSourceMissing(newId as string)).toBe(false);

    // Deleting the original closes only the original's bitmap.
    sources.remove('a');
    expect(original.close).toHaveBeenCalledTimes(1);
    expect(copyBitmap?.close).not.toHaveBeenCalled();
  });

  it('decodes before the store changes (no dirty node without a source)', async () => {
    setNodes([pixelNode('a')]);
    let nodeCountAtDecode = -1;
    const deps: ImportDeps = {
      readFile: async () => new Uint8Array(),
      decode: async () => {
        nodeCountAtDecode = nodes().length;
        return { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
      },
    };
    await duplicateNode('a', deps);
    expect(nodeCountAtDecode).toBe(1);
    expect(nodes()).toHaveLength(2);
  });

  it('reads a relative source path through the resolver, against the saved project folder', async () => {
    useProjectMetaStore.setState({ path: '/x/proj.oblique' });
    setNodes([pixelNode('a', { sourcePath: 'plates/eye.png' })]);
    const readFile = vi.fn(async () => new Uint8Array());
    const deps: ImportDeps = {
      readFile,
      decode: async () => ({ width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap,
    };
    const newId = await duplicateNode('a', deps);
    expect(readFile).toHaveBeenCalledWith('/x/plates/eye.png');
    expect(sources.isSourceMissing(newId as string)).toBe(false);
    // The copy keeps the path as typed.
    expect((nodes().find((n) => n.id === newId) as PixelNode).sourcePath).toBe('plates/eye.png');
    useProjectMetaStore.setState({ path: null });
  });

  it('still duplicates when the source cannot be read, flagging the copy as missing', async () => {
    setNodes([pixelNode('a')]);
    const deps: ImportDeps = {
      readFile: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
      decode: vi.fn(),
    };

    const newId = await duplicateNode('a', deps);

    expect(newId).not.toBeNull();
    expect(nodes()).toHaveLength(2);
    expect(sources.get(newId as string)).toBeUndefined();
    expect(sources.isSourceMissing(newId as string)).toBe(true);
    expect(deps.decode).not.toHaveBeenCalled();
  });

  it('also treats a decode failure as a missing source', async () => {
    setNodes([pixelNode('a')]);
    const deps: ImportDeps = {
      readFile: async () => new Uint8Array(),
      decode: async () => {
        throw new Error('bad image');
      },
    };
    const newId = await duplicateNode('a', deps);
    expect(newId).not.toBeNull();
    expect(sources.isSourceMissing(newId as string)).toBe(true);
  });

  it('skips the source map entirely for vector and text nodes', async () => {
    setNodes([vectorNode('v'), textNode('t')]);
    const deps = stubDeps();

    const v = await duplicateNode('v', deps);
    const t = await duplicateNode('t', deps);

    expect(v).not.toBeNull();
    expect(t).not.toBeNull();
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(sources.get(v as string)).toBeUndefined();
    expect(sources.isSourceMissing(v as string)).toBe(false);
    expect(sources.isSourceMissing(t as string)).toBe(false);
  });

  it('does not leave a bitmap behind if the node vanished while decoding', async () => {
    setNodes([pixelNode('a')]);
    const bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    const deps: ImportDeps = {
      readFile: async () => new Uint8Array(),
      decode: async () => {
        setNodes([]);
        return bitmap;
      },
    };
    expect(await duplicateNode('a', deps)).toBeNull();
    expect(bitmap.close).toHaveBeenCalled();
  });
});
