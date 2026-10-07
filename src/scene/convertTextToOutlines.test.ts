import { beforeEach, describe, expect, it } from 'vitest';
import * as cache from './cache';
import * as sources from './sources';
import { useSceneStore } from './store';
import type { PixelNode, Scene, TextNode, VectorNode, VectorPath } from './types';

const font = {
  family: 'Helvetica',
  style: 'Bold',
  postscriptName: 'Helvetica-Bold',
  weight: 700,
  italic: false,
  category: 'sans' as const,
};

const paths: VectorPath[] = [
  {
    closed: true,
    anchors: [{ point: { x: 1, y: 2 } }, { point: { x: 9, y: 2 } }, { point: { x: 5, y: 8 } }],
  },
];

const state = () => useSceneStore.getState();
const clean = { draft: false, working: false };

function pixel(id: string): PixelNode {
  return {
    id,
    label: id,
    type: 'pixel',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: clean,
    sourcePath: `/tmp/${id}.png`,
    sourceSize: [100, 100],
  };
}

function setScene(nodes: Scene['nodes'], maskRefs?: Scene['maskRefs']) {
  const scene: Scene = {
    id: 's',
    nodes,
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [800, 400],
    ...(maskRefs ? { maskRefs } : {}),
  };
  useSceneStore.setState({ scene });
}

function textNode(overrides: Partial<TextNode> = {}): TextNode {
  const id = state().addTextNode({
    content: 'WRATH',
    font,
    position: { x: 10, y: 60 },
  });
  const node = state().scene.nodes.find((n) => n.id === id) as TextNode;
  return {
    ...node,
    output: 'mask',
    visible: false,
    blendMode: 'multiply',
    opacity: 0.5,
    transform2d: { x: 3, y: 4, scaleX: 2, scaleY: 3, rotation: 0.5 },
    modifiers: [{ id: 'm-grain', type: 'grain', enabled: true, params: { amount: 1 } }],
    dirty: clean,
    ...overrides,
  };
}

beforeEach(() => {
  useSceneStore.setState({ scene: { ...state().scene, nodes: [] } });
  cache.clearAll();
  sources.clearAll();
});

describe('convertTextToOutlines', () => {
  it('replaces the text at the same index with a vector node: new id, carried fields, nonzero', () => {
    const text = textNode();
    setScene([pixel('top'), text, pixel('bottom')]);

    const newId = state().convertTextToOutlines(text.id, paths);

    expect(newId).not.toBeNull();
    expect(newId).not.toBe(text.id);
    const nodes = state().scene.nodes;
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.id)).toEqual(['top', newId, 'bottom']);
    const v = nodes[1] as VectorNode;
    expect(v).toMatchObject({
      type: 'vector',
      label: text.label,
      fillRule: 'nonzero',
      state: 'active',
      output: 'mask',
      visible: false,
      blendMode: 'multiply',
      opacity: 0.5,
      transform2d: { x: 3, y: 4, scaleX: 2, scaleY: 3, rotation: 0.5 },
      dirty: { draft: true, working: true },
    });
    expect(v.paths).toEqual(paths);
    expect(v.modifiers).toEqual(text.modifiers);
    expect(v.modifiers[0].id).toBe('m-grain');
  });

  it('repoints maskRefs at the text and dirties their consumers', () => {
    const text = textNode();
    const consumer: PixelNode = {
      ...pixel('consumer'),
      modifiers: [
        { id: 'm1', type: 'grain', enabled: true, params: {}, maskId: 'ref1' },
        { id: 'm2', type: 'grain', enabled: true, params: {}, maskId: 'refOther' },
      ],
    };
    const bystander: PixelNode = {
      ...pixel('bystander'),
      modifiers: [{ id: 'm3', type: 'grain', enabled: true, params: {}, maskId: 'refOther' }],
    };
    setScene([consumer, bystander, text], {
      ref1: { id: 'ref1', nodeId: text.id, featherPx: 2, expand: 0, invert: true },
      refOther: { id: 'refOther', nodeId: 'bystander', featherPx: 0, expand: 0, invert: false },
    });

    const newId = state().convertTextToOutlines(text.id, paths);

    const { maskRefs, nodes } = state().scene;
    expect(maskRefs?.ref1).toEqual({
      id: 'ref1',
      nodeId: newId,
      featherPx: 2,
      expand: 0,
      invert: true,
    });
    expect(maskRefs?.refOther.nodeId).toBe('bystander');
    expect(nodes.find((n) => n.id === 'consumer')?.dirty).toEqual({ draft: true, working: true });
    expect(nodes.find((n) => n.id === 'bystander')?.dirty).toEqual(clean);
  });

  it('returns null and changes nothing for a missing, locked or non-text node', () => {
    const locked = textNode({ state: 'locked' });
    setScene([pixel('p'), locked]);
    const before = state().scene;

    expect(state().convertTextToOutlines('nope', paths)).toBeNull();
    expect(state().convertTextToOutlines('p', paths)).toBeNull();
    expect(state().convertTextToOutlines(locked.id, paths)).toBeNull();
    expect(state().scene).toBe(before);
  });
});
