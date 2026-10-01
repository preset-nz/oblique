import { describe, expect, it } from 'vitest';
import type { Modifier, PixelNode, TextNode, VectorMaskRef, VectorNode } from '@/scene/types';
import type { OpDescriptor } from '@/sidecar/opsCache';
import {
  type DescriptorDeps,
  descriptorsFor,
  firstDiff,
  isPrefix,
  sameDescriptors,
  sourceKeyFor,
} from './prefixCache';

describe('isPrefix', () => {
  it('accepts equal lists, proper prefixes and the empty list', () => {
    expect(isPrefix(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isPrefix(['a'], ['a', 'b'])).toBe(true);
    expect(isPrefix([], ['a'])).toBe(true);
  });
  it('rejects a longer list, a divergent element, and a reorder', () => {
    expect(isPrefix(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
    expect(isPrefix(['a', 'x'], ['a', 'b'])).toBe(false);
    expect(isPrefix(['b', 'a'], ['a', 'b'])).toBe(false);
  });
});

describe('firstDiff', () => {
  it('returns the first differing index', () => {
    expect(firstDiff(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(1);
    expect(firstDiff(['x'], ['a'])).toBe(0);
  });
  it('returns the shorter length when one is a prefix of the other, and the length when equal', () => {
    expect(firstDiff(['a', 'b'], ['a', 'b', 'c'])).toBe(2);
    expect(firstDiff(['a', 'b', 'c'], ['a', 'b'])).toBe(2);
    expect(firstDiff(['a', 'b'], ['a', 'b'])).toBe(2);
    expect(firstDiff([], [])).toBe(0);
  });
});

describe('sameDescriptors', () => {
  it('is element-wise equality', () => {
    expect(sameDescriptors(['a'], ['a'])).toBe(true);
    expect(sameDescriptors(['a'], ['a', 'b'])).toBe(false);
    expect(sameDescriptors(['a'], ['b'])).toBe(false);
  });
});

const ops: OpDescriptor[] = [
  {
    name: 'gaussian_blur',
    backend: 'python',
    params: [{ name: 'radius', type: 'float', default: 4, min: 0, max: 100, scale: 'spatial' }],
  },
  {
    name: 'levels',
    backend: 'python',
    params: [{ name: 'black', type: 'int', default: 0, min: 0, max: 255, scale: 'none' }],
  },
];

function pixel(modifiers: Modifier[], overrides: Partial<PixelNode> = {}): PixelNode {
  return {
    id: 'n1',
    label: 'L',
    type: 'pixel',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers,
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: false, working: false },
    sourcePath: '/a.png',
    sourceSize: [800, 400],
    ...overrides,
  } as PixelNode;
}

const t1 = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };

function deps(over: Partial<DescriptorDeps> = {}): DescriptorDeps {
  return {
    getNode: () => undefined,
    getVectorMaskRef: () => undefined,
    getDocumentSize: () => [800, 400],
    getOps: () => ops,
    ...over,
  };
}

const blur = (id: string, radius: number, over: Partial<Modifier> = {}): Modifier => ({
  id,
  type: 'gaussian_blur',
  enabled: true,
  params: { radius },
  ...over,
});

describe('descriptorsFor', () => {
  it('yields one descriptor per ENABLED modifier, in stack order', () => {
    const node = pixel([blur('a', 1), blur('b', 2, { enabled: false }), blur('c', 3)]);
    const d = descriptorsFor(node, deps());
    expect(d).toHaveLength(2);
    expect(d[0]).toContain('"id":"a"');
    expect(d[1]).toContain('"id":"c"');
  });

  it('uses document-space params: not scaled, so identical at every level', () => {
    const d = descriptorsFor(pixel([blur('a', 8)]), deps());
    expect(JSON.parse(d[0]).modifier.params).toEqual({ radius: 8 });
  });

  it('changes when a param, the order, or the enabled set changes', () => {
    const base = descriptorsFor(pixel([blur('a', 1), blur('b', 2)]), deps());
    expect(descriptorsFor(pixel([blur('a', 9), blur('b', 2)]), deps())[0]).not.toBe(base[0]);
    expect(descriptorsFor(pixel([blur('b', 2), blur('a', 1)]), deps())).not.toEqual(base);
    expect(descriptorsFor(pixel([blur('a', 1), blur('b', 2, { enabled: false })]), deps())).toEqual(
      [base[0]],
    );
  });

  it('is sensitive to the op registry (an op unknown at cook time passed params through unscaled)', () => {
    const node = pixel([blur('a', 8)]);
    expect(descriptorsFor(node, deps({ getOps: () => [] }))[0]).not.toBe(
      descriptorsFor(node, deps())[0],
    );
  });

  describe('masks', () => {
    const vec = (paths: VectorNode['paths']): VectorNode =>
      ({ id: 'v1', type: 'vector', paths, fillRule: 'nonzero' }) as VectorNode;
    const ref = (over: Partial<VectorMaskRef> = {}): VectorMaskRef => ({
      id: 'r1',
      nodeId: 'v1',
      featherPx: 0,
      expand: 0,
      invert: false,
      ...over,
    });
    const path = (x: number): VectorNode['paths'] => [
      { closed: true, anchors: [{ point: { x, y: 0 } }, { point: { x: 10, y: 10 } }] },
    ];
    const masked = (transform2d = t1) => pixel([blur('a', 1, { maskId: 'r1' })], { transform2d });
    const mk = (r: VectorMaskRef, target: VectorNode) =>
      deps({
        getVectorMaskRef: (id) => (id === 'r1' ? r : undefined),
        getNode: (id) => (id === 'v1' ? target : undefined),
      });

    it('folds the ref (feather) and the target geometry (anchors) into the descriptor', () => {
      const base = descriptorsFor(masked(), mk(ref(), vec(path(0))))[0];
      expect(descriptorsFor(masked(), mk(ref({ featherPx: 3 }), vec(path(0))))[0]).not.toBe(base);
      expect(descriptorsFor(masked(), mk(ref(), vec(path(5))))[0]).not.toBe(base);
    });

    it("includes the consumer's transform2d for a document-pinned mask", () => {
      const a = descriptorsFor(masked(), mk(ref(), vec(path(0))))[0];
      const b = descriptorsFor(masked({ ...t1, x: 5 }), mk(ref(), vec(path(0))))[0];
      expect(b).not.toBe(a);
    });

    it("leaves the consumer's transform2d out for a node-pinned mask", () => {
      const pinned = ref({ space: 'node', attachTransform: t1 });
      const a = descriptorsFor(masked(), mk(pinned, vec(path(0))))[0];
      const b = descriptorsFor(masked({ ...t1, x: 5 }), mk(pinned, vec(path(0))))[0];
      expect(b).toBe(a);
    });

    it('decides pinning per modifier: an unmasked prefix modifier ignores the consumer move', () => {
      const node = (x: number) =>
        pixel([blur('a', 1), blur('b', 2, { maskId: 'r1' })], { transform2d: { ...t1, x } });
      const d = (x: number) => descriptorsFor(node(x), mk(ref(), vec(path(0))));
      expect(d(0)[0]).toBe(d(9)[0]);
      expect(d(0)[1]).not.toBe(d(9)[1]);
    });

    it('an unresolvable maskId is "no mask", same as the cook', () => {
      const withGhost = descriptorsFor(pixel([blur('a', 1, { maskId: 'ghost' })]), deps())[0];
      expect(JSON.parse(withGhost).mask).toBeNull();
    });
  });
});

describe('sourceKeyFor', () => {
  it('pixel: the bitmap reference itself', () => {
    const bmp = {} as ImageBitmap;
    expect(sourceKeyFor(pixel([]), bmp)).toBe(bmp);
  });

  it('vector: {paths, fillRule} content, so an anchor move changes it', () => {
    const v = (x: number) =>
      ({
        id: 'v',
        type: 'vector',
        modifiers: [],
        fillRule: 'nonzero',
        paths: [{ closed: true, anchors: [{ point: { x, y: 0 } }] }],
      }) as unknown as VectorNode;
    expect(sourceKeyFor(v(0), undefined)).toBe(sourceKeyFor(v(0), undefined));
    expect(sourceKeyFor(v(0), undefined)).not.toBe(sourceKeyFor(v(1), undefined));
  });

  it('text: follows content and position, ignores transform2d', () => {
    const t = (over: Partial<TextNode>): TextNode =>
      ({
        id: 't',
        type: 'text',
        modifiers: [],
        content: 'HI',
        font: { family: 'F', style: 'R', postscriptName: 'F', weight: 400, italic: false },
        fontSize: 10,
        tracking: 0,
        kerning: 100,
        lineHeight: 1,
        align: 'left',
        fill: '#fff',
        stroke: null,
        position: { x: 0, y: 0 },
        ...over,
      }) as unknown as TextNode;
    const base = sourceKeyFor(t({}), undefined);
    expect(sourceKeyFor(t({ content: 'BYE' }), undefined)).not.toBe(base);
    expect(sourceKeyFor(t({ position: { x: 1, y: 0 } }), undefined)).not.toBe(base);
    expect(sourceKeyFor(t({ transform2d: { ...t1, x: 9 } }), undefined)).toBe(base);
  });
});
