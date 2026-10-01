import { describe, expect, it } from 'vitest';
import type { Scene, Transform2D, VectorMaskRef } from '@/scene/types';
import { editingDeltaFor, IDENTITY_MASK_DELTA, maskDisplayTransform } from './maskDisplayTransform';
import { localToWorld, type NodeExtent, type Point, worldToLocal } from './transform2d';

const extent: NodeExtent = { w: 100, h: 80 };
const attach: Transform2D = { x: 10, y: 5, scaleX: 1, scaleY: 1, rotation: 0 };
const rotated: Transform2D = { x: 10, y: 5, scaleX: 1.5, scaleY: 1.5, rotation: Math.PI / 6 };
const nodeRef: Pick<VectorMaskRef, 'space' | 'attachTransform'> = {
  space: 'node',
  attachTransform: attach,
};

function close(a: Point, b: Point) {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
}

describe('maskDisplayTransform', () => {
  it('is the identity for document-pinned refs (absent or explicit space)', () => {
    expect(maskDisplayTransform({}, { transform2d: rotated, extent })).toBe(IDENTITY_MASK_DELTA);
    expect(maskDisplayTransform({ space: 'document' }, { transform2d: rotated, extent })).toBe(
      IDENTITY_MASK_DELTA,
    );
    expect(IDENTITY_MASK_DELTA.toDisplay({ x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
  });

  it('is the identity while the consumer still sits at its attach frame', () => {
    expect(maskDisplayTransform(nodeRef, { transform2d: { ...attach }, extent }).identity).toBe(
      true,
    );
  });

  it('translation: the outline shifts by exactly the consumer move', () => {
    const moved: Transform2D = { ...attach, x: attach.x + 100 };
    const d = maskDisplayTransform(nodeRef, { transform2d: moved, extent });
    close(d.toDisplay({ x: 30, y: 40 }), { x: 130, y: 40 });
    close(d.fromDisplay({ x: 130, y: 40 }), { x: 30, y: 40 });
  });

  it('rotation + scale: the mask point rides with the consumer pixel it reads', () => {
    const d = maskDisplayTransform(nodeRef, { transform2d: rotated, extent });
    const stored = { x: 47, y: 31 };
    // The consumer-local pixel the rasteriser reads at `stored` (inverse of attach)...
    const local = worldToLocal(stored, attach, extent);
    // ...is composited by the consumer's CURRENT transform: that's where the outline shows.
    close(d.toDisplay(stored), localToWorld(local, rotated, extent));
    expect(d.identity).toBe(false);
  });

  it('fromDisplay inverts toDisplay (round-trip) under rotation and scale', () => {
    const d = maskDisplayTransform(nodeRef, { transform2d: rotated, extent });
    for (const p of [
      { x: 0, y: 0 },
      { x: 55.5, y: -12 },
      { x: 300, y: 200 },
    ]) {
      close(d.fromDisplay(d.toDisplay(p)), p);
    }
  });

  it('reports the max-axis scale ratio', () => {
    const d = maskDisplayTransform(nodeRef, {
      transform2d: { ...attach, scaleX: 2, scaleY: 0.5 },
      extent,
    });
    expect(d.scale).toBe(2);
  });
});

describe('editingDeltaFor', () => {
  const moved: Transform2D = { ...attach, x: 110 };

  function sceneWith(
    maskRefs: Record<string, VectorMaskRef>,
    consumers: { id: string; maskId: string; transform2d?: Transform2D }[],
  ): Scene {
    return {
      id: 's',
      nodes: consumers.map(
        (c) =>
          ({
            id: c.id,
            label: c.id,
            type: 'pixel',
            state: 'active',
            output: 'image',
            cameraId: null,
            modifiers: [
              { id: `m-${c.id}`, type: 'invert', enabled: true, params: {}, maskId: c.maskId },
            ],
            visible: true,
            blendMode: 'normal',
            opacity: 1,
            dirty: { draft: false, working: false },
            sourcePath: '/x.png',
            sourceSize: [100, 80],
            transform2d: c.transform2d,
          }) as Scene['nodes'][number],
      ),
      cameras: [],
      defaultCameraId: null,
      resolution: 'working',
      documentSize: [400, 300],
      maskRefs,
    };
  }

  const ref = (id: string, extra: Partial<VectorMaskRef> = {}): VectorMaskRef => ({
    id,
    nodeId: 'v',
    featherPx: 0,
    expand: 0,
    invert: false,
    ...extra,
  });

  it('identity when nothing references the shape, or only document-pinned refs do', () => {
    expect(editingDeltaFor('v', sceneWith({}, [])).identity).toBe(true);
    const scene = sceneWith({ r1: ref('r1') }, [{ id: 'c1', maskId: 'r1', transform2d: moved }]);
    expect(editingDeltaFor('v', scene).identity).toBe(true);
  });

  it("uses the first node-pinned ref's consumer (maskRefs order), skipping document-pinned and consumer-less refs", () => {
    const farther: Transform2D = { ...attach, x: 510 };
    const scene = sceneWith(
      {
        orphan: ref('orphan', { space: 'node', attachTransform: attach }), // no consumer
        doc: ref('doc'),
        first: ref('first', { space: 'node', attachTransform: attach }),
        second: ref('second', { space: 'node', attachTransform: attach }),
      },
      [
        { id: 'c2', maskId: 'second', transform2d: farther },
        { id: 'c1', maskId: 'first', transform2d: moved },
        { id: 'c0', maskId: 'doc', transform2d: farther },
      ],
    );
    const d = editingDeltaFor('v', scene);
    close(d.toDisplay({ x: 0, y: 0 }), { x: 100, y: 0 }); // 'first' (c1, moved by +100), not 'second'
  });

  it('ignores refs pointing at other shapes', () => {
    const scene = sceneWith(
      { r: ref('r', { nodeId: 'other', space: 'node', attachTransform: attach }) },
      [{ id: 'c', maskId: 'r', transform2d: moved }],
    );
    expect(editingDeltaFor('v', scene).identity).toBe(true);
  });
});
