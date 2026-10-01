import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextGeometry, TextSpec } from '@/fonts/textGeometry';

vi.mock('@/fonts/fontsIpc', () => ({ textOutlines: vi.fn(), listFonts: vi.fn() }));

import { textOutlines } from '@/fonts/fontsIpc';
import {
  clearAll,
  documentPathsFor,
  ensureGeometry,
  getGeometry,
  specFor,
  specKey,
  textCookKey,
  useTextGeometryStore,
} from './textGeometryCache';
import type { TextNode } from './types';

function textNode(overrides: Partial<TextNode> = {}): TextNode {
  return {
    id: 't1',
    label: 'Text',
    type: 'text',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: false, working: false },
    content: 'HELLO',
    font: {
      family: 'Helvetica',
      style: 'Regular',
      postscriptName: 'Helvetica',
      weight: 400,
      italic: false,
      category: 'sans',
    },
    fontSize: 72,
    tracking: 0,
    kerning: 100,
    lineHeight: 1.2,
    align: 'left',
    fill: '#ffffff',
    stroke: null,
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

const geom = (w: number): TextGeometry => ({
  paths: [],
  lines: [],
  ascent: 1,
  descent: 1,
  bounds: { x: 0, y: 0, w, h: 1 },
});

const ipc = vi.mocked(textOutlines);

beforeEach(() => {
  clearAll();
  ipc.mockReset();
  ipc.mockImplementation(async (spec: TextSpec) => geom(spec.content.length));
});

describe('specFor / specKey / textCookKey', () => {
  it('specFor takes the PostScript name from the effective font', () => {
    expect(specFor(textNode()).postscriptName).toBe('Helvetica');
  });

  it('specKey is stable and ignores position/fill/stroke', () => {
    const a = textNode();
    const b = textNode({
      position: { x: 5, y: 5 },
      fill: '#000000',
      stroke: { color: '#f00', width: 2 },
    });
    expect(specKey(specFor(a))).toBe(specKey(specFor(a)));
    expect(specKey(specFor(a))).toBe(specKey(specFor(b)));
    expect(specKey(specFor(a))).not.toBe(specKey(specFor(textNode({ content: 'X' }))));
  });

  it('textCookKey also covers position, fill and stroke, but not the dirty flag', () => {
    const a = textNode();
    expect(textCookKey(a)).toBe(textCookKey({ ...a, dirty: { draft: true, working: true } }));
    expect(textCookKey(a)).not.toBe(textCookKey(textNode({ position: { x: 1, y: 0 } })));
    expect(textCookKey(a)).not.toBe(textCookKey(textNode({ fill: null })));
    expect(textCookKey(a)).not.toBe(textCookKey(textNode({ stroke: { color: '#000', width: 1 } })));
  });
});

describe('ensureGeometry / getGeometry', () => {
  it('getGeometry is undefined until cached; a hit makes no IPC call', async () => {
    const node = textNode();
    expect(getGeometry(node)).toBeUndefined();
    await ensureGeometry(node);
    expect(getGeometry(node)).toBeDefined();
    await ensureGeometry(textNode({ id: 'other', position: { x: 9, y: 9 } }));
    expect(ipc).toHaveBeenCalledTimes(1);
  });

  it('dedups in-flight requests: two calls, one IPC', async () => {
    const node = textNode();
    const [a, b] = await Promise.all([ensureGeometry(node), ensureGeometry(node)]);
    expect(a).toBe(b);
    expect(ipc).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejection, and a retry reaches IPC again', async () => {
    const node = textNode();
    ipc.mockRejectedValueOnce(new Error('FontNotFound'));
    await expect(ensureGeometry(node)).rejects.toThrow('FontNotFound');
    expect(getGeometry(node)).toBeUndefined();
    await expect(ensureGeometry(node)).resolves.toBeDefined();
    expect(ipc).toHaveBeenCalledTimes(2);
  });

  it('bumps the store version on every insert', async () => {
    const before = useTextGeometryStore.getState().version;
    await ensureGeometry(textNode());
    expect(useTextGeometryStore.getState().version).toBe(before + 1);
  });

  it('evicts the oldest entry at 129 specs (LRU: a hit protects an entry)', async () => {
    const nodes = Array.from({ length: 129 }, (_, i) => textNode({ content: `t${i}` }));
    for (let i = 0; i < 128; i++) await ensureGeometry(nodes[i]);
    getGeometry(nodes[0]); // refresh t0 so t1 is now the oldest
    await ensureGeometry(nodes[128]);
    expect(getGeometry(nodes[1])).toBeUndefined();
    expect(getGeometry(nodes[0])).toBeDefined();
    expect(getGeometry(nodes[128])).toBeDefined();
  });
});

describe('documentPathsFor', () => {
  it('translates every anchor point and handle by position, leaving closed and the input alone', () => {
    const geometry: TextGeometry = {
      paths: [
        {
          closed: true,
          anchors: [
            { point: { x: 1, y: 2 }, handleOut: { x: 3, y: 4 } },
            { point: { x: 5, y: 6 }, handleIn: { x: 7, y: 8 }, handleOut: { x: 9, y: 10 } },
          ],
        },
        { closed: false, anchors: [{ point: { x: 0, y: 0 } }] },
      ],
      lines: [],
      ascent: 0,
      descent: 0,
      bounds: null,
    };
    const before = JSON.stringify(geometry);
    const out = documentPathsFor(textNode({ position: { x: 100, y: 200 } }), geometry);

    expect(out).toEqual([
      {
        closed: true,
        anchors: [
          { point: { x: 101, y: 202 }, handleOut: { x: 103, y: 204 } },
          {
            point: { x: 105, y: 206 },
            handleIn: { x: 107, y: 208 },
            handleOut: { x: 109, y: 210 },
          },
        ],
      },
      { closed: false, anchors: [{ point: { x: 100, y: 200 } }] },
    ]);
    // absent handles stay absent (a corner, not a handle at the position)
    expect(out[0].anchors[0]).not.toHaveProperty('handleIn');
    expect(JSON.stringify(geometry)).toBe(before);
  });
});
