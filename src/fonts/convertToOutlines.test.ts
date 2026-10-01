import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./fontsIpc', () => ({ listFonts: vi.fn(), textOutlines: vi.fn() }));
vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn() });
  return { toast };
});

import { toast } from 'sonner';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { clearAll } from '@/scene/textGeometryCache';
import type { Scene, TextNode, VectorNode } from '@/scene/types';
import { convertedToastMessage, convertSelectedTextToOutlines } from './convertToOutlines';
import { textOutlines } from './fontsIpc';
import { BLACKLETTER_BOLD } from './testFixtures';
import type { TextGeometry } from './textGeometry';

const geometry: TextGeometry = {
  paths: [
    {
      closed: true,
      anchors: [
        { point: { x: 0, y: 0 }, handleOut: { x: 1, y: 0 } },
        { point: { x: 10, y: 0 } },
        { point: { x: 5, y: -10 } },
      ],
    },
  ],
  lines: [],
  ascent: 10,
  descent: 2,
  bounds: null,
};

const state = () => useSceneStore.getState();

function addText(overrides: Partial<TextNode> = {}): TextNode {
  const id = state().addTextNode({
    content: 'WRATH',
    font: BLACKLETTER_BOLD,
    position: { x: 100, y: 50 },
    ...overrides,
  });
  return state().scene.nodes.find((n) => n.id === id) as TextNode;
}

beforeEach(() => {
  const scene: Scene = {
    id: 's',
    nodes: [],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [800, 400],
  };
  useSceneStore.setState({ scene });
  useSelectionStore.getState().clear();
  clearAll();
  vi.mocked(textOutlines).mockReset();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('convertedToastMessage', () => {
  it('omits the caveat for a white or absent fill with no stroke', () => {
    expect(convertedToastMessage(addText({ fill: '#ffffff' }))).toBe('Converted to outlines');
    expect(convertedToastMessage(addText({ fill: '#FFF' }))).toBe('Converted to outlines');
    expect(convertedToastMessage(addText({ fill: null }))).toBe('Converted to outlines');
  });
  it('mentions the caveat for a non-white fill or any stroke', () => {
    const caveat = /fill colour and stroke aren't carried/;
    expect(convertedToastMessage(addText({ fill: '#aa0000' }))).toMatch(caveat);
    expect(convertedToastMessage(addText({ stroke: { color: '#ffffff', width: 2 } }))).toMatch(
      caveat,
    );
  });
});

describe('convertSelectedTextToOutlines', () => {
  it('converts the selection with document-space paths and selects the new node', async () => {
    vi.mocked(textOutlines).mockResolvedValue(geometry);
    const text = addText();
    useSelectionStore.getState().selectNode(text.id);

    await convertSelectedTextToOutlines();

    const [node] = state().scene.nodes;
    expect(node.type).toBe('vector');
    expect(node.id).not.toBe(text.id);
    expect((node as VectorNode).paths[0].anchors[0]).toEqual({
      point: { x: 100, y: 50 },
      handleOut: { x: 101, y: 50 },
    });
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'node', nodeId: node.id });
    expect(toast).toHaveBeenCalledWith('Converted to outlines');
  });

  it('tells the user when nothing convertible is selected', async () => {
    await convertSelectedTextToOutlines();
    expect(toast).toHaveBeenCalledWith('Select an unlocked text layer to convert');
    expect(textOutlines).not.toHaveBeenCalled();
  });

  it('refuses a locked text layer', async () => {
    const text = addText({ state: 'locked' });
    useSelectionStore.getState().selectNode(text.id);
    await convertSelectedTextToOutlines();
    expect(toast).toHaveBeenCalledWith('Select an unlocked text layer to convert');
    expect(state().scene.nodes[0].type).toBe('text');
  });

  it('shows the error and changes nothing when shaping rejects', async () => {
    vi.mocked(textOutlines).mockRejectedValue(new Error('font not found'));
    const text = addText();
    useSelectionStore.getState().selectNode(text.id);

    await convertSelectedTextToOutlines();

    expect(toast.error).toHaveBeenCalledWith('font not found');
    expect(state().scene.nodes[0].type).toBe('text');
  });
});
