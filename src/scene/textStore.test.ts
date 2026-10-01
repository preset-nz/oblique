import { beforeEach, describe, expect, it } from 'vitest';
import { textLabel, useSceneStore } from './store';
import type { Modifier, PixelNode, Scene, TextNode } from './types';

const font = {
  family: 'Helvetica',
  style: 'Regular',
  postscriptName: 'Helvetica',
  weight: 400,
  italic: false,
  category: 'sans' as const,
};

function emptyScene(): Scene {
  return {
    id: 's',
    nodes: [],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [800, 400],
  };
}

const state = () => useSceneStore.getState();
const textAt = (id: string) => state().scene.nodes.find((n) => n.id === id) as TextNode;
const clean = { draft: false, working: false };

function addText(content = 'HELLO'): string {
  const id = state().addTextNode({ content, font, position: { x: 10, y: 60 } });
  // clear the creation dirtiness so tests see what setTextProps does
  state().clearDirty(id, 'draft');
  state().clearDirty(id, 'working');
  return id;
}

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
});

describe('textLabel', () => {
  it('uses the first non-blank line, trimmed', () => {
    expect(textLabel('  \n\n  HELLO \nWORLD')).toBe('HELLO');
  });
  it("falls back to 'Text' for empty or whitespace-only content", () => {
    expect(textLabel('')).toBe('Text');
    expect(textLabel(' \n\t\n ')).toBe('Text');
  });
  it('cuts at 32 characters with an ellipsis, leaving exactly 32 alone', () => {
    const exactly32 = 'a'.repeat(32);
    expect(textLabel(exactly32)).toBe(exactly32);
    expect(textLabel('a'.repeat(33))).toBe(`${exactly32}…`);
  });
});

describe('addTextNode', () => {
  it('applies the documented defaults', () => {
    const id = state().addTextNode({ content: 'THE DEAD\nMARCH', font, position: { x: 1, y: 2 } });
    const n = textAt(id);
    expect(n).toMatchObject({
      type: 'text',
      label: 'THE DEAD',
      fontSize: 72,
      tracking: 0,
      kerning: true,
      lineHeight: 1.2,
      align: 'left',
      fill: '#ffffff',
      stroke: null,
      output: 'image',
      blendMode: 'normal',
      opacity: 1,
      visible: true,
      state: 'active',
      modifiers: [],
      dirty: { draft: true, working: true },
      position: { x: 1, y: 2 },
    });
  });

  it('inserts at the top of the stack', () => {
    const pixel: PixelNode = {
      id: 'p',
      label: 'P',
      type: 'pixel',
      state: 'active',
      output: 'image',
      cameraId: null,
      modifiers: [],
      visible: true,
      blendMode: 'normal',
      opacity: 1,
      dirty: clean,
      sourcePath: '/a.png',
      sourceSize: [10, 10],
    };
    useSceneStore.setState({ scene: { ...emptyScene(), nodes: [pixel] } });
    const id = addText();
    expect(state().scene.nodes.map((n) => n.id)).toEqual([id, 'p']);
  });

  it('honours explicit overrides, including fill: null', () => {
    const id = state().addTextNode({
      content: 'x',
      font,
      position: { x: 0, y: 0 },
      fill: null,
      fontSize: 10,
    });
    expect(textAt(id).fill).toBeNull();
    expect(textAt(id).fontSize).toBe(10);
  });
});

describe('setTextProps', () => {
  it('merges the patch and dirties both levels', () => {
    const id = addText();
    state().setTextProps(id, { fontSize: 100, tracking: 50 });
    expect(textAt(id)).toMatchObject({
      fontSize: 100,
      tracking: 50,
      dirty: { draft: true, working: true },
    });
  });

  it('is a no-op (same state object) on a missing, non-text or locked node', () => {
    const id = addText();
    state().setTextProps('nope', { fontSize: 1 });
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: s.scene.nodes.map((n) => ({ ...n, state: 'locked' as const })) },
    }));
    const before = state();
    state().setTextProps(id, { fontSize: 1 });
    expect(state()).toBe(before);
    expect(textAt(id).fontSize).toBe(72);

    const pixelId = state().addPixelNode({ sourcePath: '/a.png', sourceSize: [1, 1] });
    const before2 = state();
    state().setTextProps(pixelId, { fontSize: 1 });
    expect(state()).toBe(before2);
  });

  it('a patch that changes nothing returns the same state object', () => {
    const id = addText();
    const before = state();
    state().setTextProps(id, {
      fontSize: 72,
      font: { ...font },
      position: { x: 10, y: 60 },
      stroke: null,
    });
    expect(state()).toBe(before);
  });

  it('the label follows content only while it is still the auto label', () => {
    const id = addText('HELLO');
    state().setTextProps(id, { content: 'WORLD' });
    expect(textAt(id).label).toBe('WORLD');

    state().setNodeProp(id, { label: 'My title' });
    state().setTextProps(id, { content: 'AGAIN' });
    expect(textAt(id).label).toBe('My title');
  });

  it('dirties nodes whose modifier masks reference the edited text node', () => {
    const id = addText();
    const mod: Modifier = { id: 'm1', type: 'grain', enabled: true, params: {}, maskId: 'ref1' };
    const consumer: PixelNode = {
      id: 'c',
      label: 'C',
      type: 'pixel',
      state: 'active',
      output: 'image',
      cameraId: null,
      modifiers: [mod],
      visible: true,
      blendMode: 'normal',
      opacity: 1,
      dirty: clean,
      sourcePath: '/c.png',
      sourceSize: [10, 10],
    };
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [...s.scene.nodes, consumer],
        maskRefs: { ref1: { id: 'ref1', nodeId: id, featherPx: 0, expand: 0, invert: false } },
      },
    }));

    state().setTextProps(id, { content: 'CHANGED' });

    const c = state().scene.nodes.find((n) => n.id === 'c');
    expect(c?.dirty).toEqual({ draft: true, working: true });
  });
});
