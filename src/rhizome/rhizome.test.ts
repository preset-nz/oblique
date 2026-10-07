import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFontCatalogueStore } from '@/fonts/catalogue';
import { importFile } from '@/project/import';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import { beginNewTextAt, commitActiveTextEdit, useTextEditStore } from '@/scene/textEditState';
import * as transaction from '@/scene/transaction';
import type { PixelNode, Scene, SceneNode, TextNode, VectorNode } from '@/scene/types';
import { createRhizome, type Rhizome } from './rhizome';
import { FakeHost } from './testHost';

const emptyScene = (nodes: SceneNode[] = []): Scene => ({
  id: 'scene-1',
  nodes,
  cameras: [],
  defaultCameraId: null,
  resolution: 'working',
  documentSize: [0, 0],
});

const clean = { draft: false, working: false };

const pixel = (id: string, over: Partial<PixelNode> = {}): PixelNode => ({
  id,
  label: 'Layer',
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
  ...over,
});

const font = {
  family: 'Inter',
  style: 'Regular',
  postscriptName: 'Inter-Regular',
  weight: 400,
  italic: false,
  category: 'sans' as const,
};

const T = (x: number) => ({ x, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });

/** Lets queued promise work and timers-of-zero run. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

let host: FakeHost;
let rhizome: Rhizome;
let uninstall: () => void;
const notify = vi.fn();

/** A store and a host that hold the same scene, a running rhizome over them. */
async function setup(
  nodes: SceneNode[] = [],
  start = true,
  extra: Partial<Scene> = {},
  restore: (current: Scene, target: Scene) => Promise<void> = async (_current, target) =>
    useSceneStore.getState().loadScene(target),
) {
  const scene = { ...emptyScene(nodes), ...extra };
  useSceneStore.setState({ scene });
  host = new FakeHost(scene);
  rhizome = createRhizome({
    backend: host,
    store: useSceneStore,
    notify,
    restore,
    nextFrame: async () => undefined,
    schedule: () => undefined, // the tests call reconcile themselves
  });
  uninstall = rhizome.install();
  if (start) {
    await rhizome.start([]);
    await settle();
  }
}

/** Edit > Undo or Redo: Rust steps, and the webview rebuilds when `history-stepped` arrives. */
const undo = async () => {
  await host.step(true);
  await settle();
};
const redo = async () => {
  await host.step(false);
  await settle();
};

const node = (id: string) => useSceneStore.getState().scene.nodes.find((n) => n.id === id);
const state = () => useSceneStore.getState();

beforeEach(() => {
  notify.mockClear();
});
afterEach(() => {
  uninstall();
});

describe('commands first', () => {
  it('sends the command and changes the store only when the update comes back', async () => {
    await setup([pixel('a')]);
    state().setNodeTransform('a', T(7));
    expect(node('a')?.transform2d).toBeUndefined(); // nothing local yet
    await settle();
    expect(host.runs).toHaveLength(1);
    expect(host.runs[0].id).toBe('values.set');
    expect(host.runs[0].payload).toEqual({
      changes: [
        { at: '/layers/a', key: 'transform2d.position', value: [7, 0] },
        { at: '/layers/a', key: 'transform2d.scale', value: [1, 1] },
        { at: '/layers/a', key: 'transform2d.rotation', value: 0 },
      ],
    });
    expect(node('a')?.transform2d).toEqual(T(7));
    expect(node('a')?.dirty).toEqual(clean); // dirty rule 4: a move recooks nothing
  });

  it("applies through the store's own action, so its dirty rules hold", async () => {
    const vector: VectorNode = {
      ...(pixel('v') as unknown as VectorNode),
      type: 'vector',
      paths: [],
      fillRule: 'nonzero',
    };
    delete (vector as unknown as Partial<PixelNode>).sourcePath;
    delete (vector as unknown as Partial<PixelNode>).sourceSize;
    const masked = pixel('m', {
      modifiers: [{ id: 'mod', type: 'blur', enabled: true, params: {}, maskId: 'r' }],
    });
    await setup([masked, vector]);
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        maskRefs: { r: { id: 'r', nodeId: 'v', featherPx: 0, expand: 0, invert: false } },
      },
    }));
    // the host's rows need the same mask for the compare; only the dirty rule is checked here
    state().setNodeTransform('m', T(3));
    await settle();
    expect(node('m')?.dirty).toEqual({ draft: true, working: true }); // a document-pinned mask
    expect(node('v')?.dirty).toEqual(clean);
  });

  it('sends nothing for a locked layer', async () => {
    await setup([pixel('a', { state: 'locked' })]);
    state().setNodeTransform('a', T(7));
    await settle();
    expect(host.runs).toHaveLength(0);
  });

  it('props and the document size go the same way', async () => {
    await setup([pixel('a')]);
    state().setNodeProp('a', { opacity: 0.5, label: 'Renamed' });
    state().setDocumentSize([800, 600]);
    expect(node('a')?.opacity).toBe(1);
    expect(state().scene.documentSize).toEqual([0, 0]);
    await settle();
    expect(host.runs.map((r) => r.id)).toEqual(['values.set', 'document.set_size']);
    expect(node('a')?.opacity).toBe(0.5);
    expect(node('a')?.label).toBe('Renamed');
    expect(state().scene.documentSize).toEqual([800, 600]);
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('is latest-wins while a command is in flight', async () => {
    await setup([pixel('a')]);
    transaction.beginTransaction(); // a drag: inside a gesture, latest wins
    let release: () => void = () => undefined;
    host.hold = new Promise<void>((r) => {
      release = r;
    });
    state().setNodeTransform('a', T(1));
    await vi.waitFor(() => expect(host.runs).toHaveLength(1)); // sent, held
    state().setNodeTransform('a', T(2));
    state().setNodeTransform('a', T(3));
    state().setNodeTransform('a', T(4));
    host.hold = null;
    release();
    await settle();
    const xs = host.runs.map(
      (r) => (r.payload as { changes: { value: number[] }[] }).changes[0].value[0],
    );
    expect(xs).toEqual([1, 4]);
    expect(node('a')?.transform2d).toEqual(T(4));
    transaction.endTransaction();
  });

  it('a refusal from the host toasts and leaves the store alone', async () => {
    await setup([pixel('a')]);
    host.reject.add('values.set');
    state().setNodeProp('a', { opacity: 0.1 });
    await settle();
    expect(node('a')?.opacity).toBe(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });
});

describe('replace image (layer.set_source)', () => {
  const pix = (id: string) => node(id) as PixelNode | undefined;
  const vector = (id: string): VectorNode => ({
    ...(pixel(id) as unknown as VectorNode),
    type: 'vector',
    paths: [],
    fillRule: 'nonzero',
  });
  const node1 = { x: 100, y: 40, scaleX: -1, scaleY: 1, rotation: 0.3 };
  // what Rust would decide for 100x100 -> 400x200 (src-tauri holds the rule)
  const decided = { x: -50, y: -10, scaleX: -0.25, scaleY: 0.25, rotation: 0.3 };

  /** A pixel layer with a node-space mask, and a host that answers a resize as Rust would. */
  async function withMask(restore?: (current: Scene, target: Scene) => Promise<void>) {
    const consumer = pixel('a', {
      transform2d: node1,
      modifiers: [{ id: 'mod', type: 'blur', enabled: true, params: {}, maskId: 'r' }],
    });
    const v = vector('v');
    delete (v as unknown as Partial<PixelNode>).sourcePath;
    delete (v as unknown as Partial<PixelNode>).sourceSize;
    await setup(
      [consumer, v],
      true,
      {
        maskRefs: {
          r: {
            id: 'r',
            nodeId: 'v',
            featherPx: 0,
            expand: 0,
            invert: false,
            space: 'node',
            attachTransform: node1,
          },
        },
      },
      restore,
    );
    host.decided = (layer, rows) => {
      layer.values = {
        ...layer.values,
        'transform2d.position': [decided.x, decided.y],
        'transform2d.scale': [decided.scaleX, decided.scaleY],
      };
      const mod = [...rows.values()].find((r) => r.path === '/layers/a/mod');
      const b = mod?.bindings?.[0];
      if (b) b.values = { ...b.values, attachTransform: decided };
    };
  }

  it('sends the path and size, changes nothing until the update, then applies the whole result at once', async () => {
    await withMask();
    const seen: unknown[] = [];
    useSceneStore.subscribe((s) => seen.push(structuredClone(s.scene.nodes[0])));
    state().setPixelSource('a', '/new/b.png', [400, 200]);
    expect(pix('a')?.sourcePath).toBe('/tmp/a.png'); // nothing local yet
    await settle();
    expect(host.runs).toHaveLength(1);
    expect(host.runs[0].id).toBe('layer.set_source');
    expect(host.runs[0].payload).toEqual({
      at: '/layers/a',
      sourcePath: '/new/b.png',
      sourceSize: [400, 200],
    });
    const a = node('a') as PixelNode;
    expect(a.sourcePath).toBe('/new/b.png');
    expect(a.sourceSize).toEqual([400, 200]);
    expect(a.transform2d).toEqual(decided);
    expect(a.dirty).toEqual({ draft: true, working: true });
    expect(state().scene.maskRefs?.r.attachTransform).toEqual(decided);
    // no frame with the new transform over the old size, or the other way round
    for (const n of seen as PixelNode[]) {
      expect(n.sourceSize[0] === 400).toBe(n.transform2d?.x === decided.x);
    }
    await expect(rhizome.reconcile()).resolves.toBe('same');
    expect(host.messages.filter((m) => m.startsWith('reconcile:'))).toEqual([]);
  });

  it('without a size sends the path alone', async () => {
    await setup([pixel('a', { transform2d: node1 })]);
    state().setPixelSource('a', '/later.png');
    await settle();
    expect(host.runs[0].payload).toEqual({ at: '/layers/a', sourcePath: '/later.png' });
    expect(pix('a')?.sourcePath).toBe('/later.png');
    expect(pix('a')?.sourceSize).toEqual([100, 100]);
    expect(node('a')?.transform2d).toEqual(node1);
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('the same path and size (a missing file back as it was) sends nothing but still repaints', async () => {
    await setup([pixel('a', { transform2d: node1 })]);
    expect(node('a')?.dirty).toEqual(clean);
    state().setPixelSource('a', '/tmp/a.png', [100, 100]);
    state().setPixelSource('a', '/tmp/a.png');
    await settle();
    expect(host.runs).toHaveLength(0);
    expect(node('a')?.dirty).toEqual({ draft: true, working: true });
    expect(node('a')?.transform2d).toEqual(node1);
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('sends nothing for a locked or a missing layer', async () => {
    await setup([pixel('a', { state: 'locked' })]);
    state().setPixelSource('a', '/new/b.png', [400, 200]);
    state().setPixelSource('zzz', '/new/b.png', [400, 200]);
    await settle();
    expect(host.runs).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a refusal from the host toasts and leaves the store alone', async () => {
    await setup([pixel('a')]);
    host.reject.add('layer.set_source');
    state().setPixelSource('a', '/new/b.png', [400, 200]);
    await settle();
    expect(pix('a')?.sourcePath).toBe('/tmp/a.png');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });

  it('undo goes through the restore with the replaced image still on screen, so it re-decodes', async () => {
    const restore = vi.fn(async (_current: Scene, target: Scene) =>
      useSceneStore.getState().loadScene(target),
    );
    await withMask(restore);
    state().setPixelSource('a', '/new/b.png', [400, 200]);
    await settle();
    await undo();
    // restoreScene re-decodes only when the path on screen differs from the target's: an
    // echo that had already put the old path back would leave the new pixels showing
    const last = restore.mock.calls[restore.mock.calls.length - 1];
    const current = last[0].nodes.find((n) => n.id === 'a') as PixelNode;
    expect(current.sourcePath).toBe('/new/b.png');
    expect(pix('a')?.sourcePath).toBe('/tmp/a.png');
    expect(node('a')?.transform2d).toEqual(node1);
    expect(state().scene.maskRefs?.r.attachTransform).toEqual(node1);
    await redo();
    expect(pix('a')?.sourceSize).toEqual([400, 200]);
    expect(node('a')?.transform2d).toEqual(decided);
  });
});

describe('local first', () => {
  it('runs the original action at once and sends layer.add after, with the layer id it picked', async () => {
    await setup();
    const id = state().addPixelNode({ sourcePath: '/x.png', sourceSize: [10, 10] });
    expect(node(id)?.type).toBe('pixel'); // the caller can use the id synchronously
    expect(host.runs).toHaveLength(0);
    await settle();
    expect(host.runs).toHaveLength(1);
    expect(host.runs[0].id).toBe('layer.add');
    const sent = (host.runs[0].payload as { node: Record<string, unknown> }).node;
    expect(sent.id).toBe(id);
    expect(sent).not.toHaveProperty('dirty'); // cook state stays local
    expect(rhizome.mirror.byPath(`/layers/${id}`)).toBeDefined();
    expect(node(id)?.dirty).toEqual({ draft: true, working: true }); // the store's own, kept
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('keeps the order: the layer is added before the move that follows it', async () => {
    await setup();
    const id = state().addPixelNode({ sourcePath: '/x.png', sourceSize: [10, 10] });
    state().setDocumentSize([10, 10]);
    state().setNodeTransform(id, T(5));
    await settle();
    expect(host.runs.map((r) => r.id)).toEqual(['layer.add', 'document.set_size', 'values.set']);
    expect(node(id)?.transform2d).toEqual(T(5));
    expect(state().scene.documentSize).toEqual([10, 10]);
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('vector and text layers too, and text edits per keystroke', async () => {
    await setup();
    const v = state().addVectorNode({ paths: [], fillRule: 'nonzero' });
    const t = state().addTextNode({ content: 'Hi', font, position: { x: 1, y: 2 } });
    state().setTextProps(t, { content: 'Hi t' });
    state().setTextProps(t, { content: 'Hi th' });
    expect((node(t) as TextNode).content).toBe('Hi th'); // at once
    expect(node(t)?.label).toBe('Hi th');
    await settle();
    expect(host.runs.map((r) => r.id)).toEqual(['layer.add', 'layer.add', 'text.set', 'text.set']);
    expect(rhizome.mirror.byPath(`/layers/${v}`)).toBeDefined();
    await expect(rhizome.reconcile()).resolves.toBe('same'); // the label rule agrees
  });

  it('sends nothing for a text edit the store did not make', async () => {
    await setup();
    const t = state().addTextNode({ content: 'Hi', font, position: { x: 1, y: 2 } });
    await settle();
    host.runs.length = 0;
    state().setTextProps(t, { content: 'Hi' }); // unchanged
    state().setTextProps('nope', { content: 'x' });
    await settle();
    expect(host.runs).toHaveLength(0);
  });

  it('waits in the queue until the host exists', async () => {
    await setup([], false);
    const id = state().addPixelNode({ sourcePath: '/x.png', sourceSize: [10, 10] });
    state().setNodeTransform(id, T(5));
    await settle();
    expect(host.trace).toEqual([]); // not even init
    expect(node(id)).toBeDefined(); // local first still showed it
    await rhizome.start([{ name: 'blur', params: [] }]);
    await settle();
    expect(host.trace.slice(0, 4)).toEqual(['init', 'connect', 'view', 'run:layer.add']);
    expect(host.inited).toEqual([{ name: 'blur', params: [] }]);
    expect(host.runs.map((r) => r.id)).toEqual(['layer.add', 'values.set']);
    expect(node(id)?.transform2d).toEqual(T(5));
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('starts once however often the catalogue arrives', async () => {
    await setup([], false);
    await Promise.all([rhizome.start([]), rhizome.start([])]);
    expect(host.trace.filter((t) => t === 'init')).toHaveLength(1);
  });
});

describe('nudges', () => {
  it('three quick nudges move three steps, each its own undo step', async () => {
    await setup([pixel('a')]);
    // what Viewport does per keydown: start from the latest value sent, not the stale store
    const nudge = () => {
      const have = rhizome.latestTransform('a') ?? node('a')?.transform2d ?? T(0);
      state().setNodeTransform('a', { ...have, x: have.x + 1 });
    };
    nudge();
    nudge();
    nudge();
    await settle();
    expect(node('a')?.transform2d?.x).toBe(3);
    expect(host.runs).toHaveLength(3);
    expect(host.runs.every((r) => r.coalesce === undefined)).toBe(true);
    await undo();
    expect(node('a')?.transform2d?.x).toBe(2);
    await undo();
    expect(node('a')?.transform2d?.x).toBe(1);
  });

  it('forgets the pending value once answered', async () => {
    await setup([pixel('a')]);
    state().setNodeTransform('a', T(4));
    expect(rhizome.latestTransform('a')?.x).toBe(4);
    await settle();
    expect(rhizome.latestTransform('a')).toBeUndefined();
  });
});

describe('an empty new text layer', () => {
  it('goes by cancelling the gesture: no removeNode toast, no undo step', async () => {
    useFontCatalogueStore.setState({ status: 'idle', faces: [] });
    useTextEditStore.setState({ editing: null, focusRequest: 0, focusTarget: null });
    await setup();
    const id = beginNewTextAt({ x: 1, y: 2 });
    expect(node(id)).toBeDefined();
    await settle();
    expect(host.runs.map((r) => r.id)).toEqual(['layer.add']);
    commitActiveTextEdit();
    await settle();
    expect(host.trace).toContain('cancel:1');
    expect(host.trace.some((t) => t.startsWith('end'))).toBe(false);
    expect(node(id)).toBeUndefined();
    expect(host.runs.map((r) => r.id)).toEqual(['layer.add']); // no removal command either
    expect(notify).not.toHaveBeenCalled();
    await undo(); // nothing to undo: the creation was taken back with the gesture
    expect(state().scene.nodes).toHaveLength(0);
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });
});

describe('importing images, as the app does', () => {
  const deps = (w: number, h: number) => ({
    readFile: async () => new Uint8Array(),
    decode: async () => ({ width: w, height: h, close: () => undefined }),
  });

  it('sets the document size from the first image and logs no reconcile difference', async () => {
    await setup();
    sources.clearAll();
    // importFile sets the document size, then adds the layer, in the same tick
    const a = await importFile('/tmp/a.png', deps(640, 480));
    const b = await importFile('/tmp/b.png', deps(320, 200));
    expect(a.nodeId).toBeDefined();
    await settle();
    expect(state().scene.documentSize).toEqual([640, 480]);
    expect(state().scene.nodes.map((n) => n.id)).toEqual([b.nodeId, a.nodeId]);
    await expect(rhizome.reconcile()).resolves.toBe('same');
    expect(host.messages.filter((m) => m.startsWith('reconcile:'))).toEqual([]);
    expect(host.runs.map((r) => r.id)).toEqual(['document.set_size', 'layer.add', 'layer.add']);
    sources.clearAll();
  });
});

describe('starting', () => {
  it('sends the catalogue without null fields', async () => {
    await setup([], false);
    await rhizome.start([
      {
        name: 'blur',
        label: 'Blur',
        backend: 'python',
        params: [{ name: 'radius', type: 'float', default: 5, min: null, max: 100, scale: 'none' }],
      },
    ]);
    expect(JSON.parse(JSON.stringify(host.inited))).toEqual([
      { name: 'blur', params: [{ name: 'radius', type: 'float', default: 5, max: 100 }] },
    ]);
  });
});

describe('gestures and undo', () => {
  it('a transaction is a rhizome gesture, and the drag inside it one undo step', async () => {
    await setup([pixel('a')]);
    transaction.beginTransaction();
    for (const x of [1, 2, 3]) {
      state().setNodeTransform('a', T(x));
      await settle();
    }
    transaction.endTransaction();
    await settle();
    expect(host.trace.filter((t) => t.startsWith('begin') || t.startsWith('end'))).toEqual([
      'begin:Edit',
      'end:1',
    ]);
    expect(host.runs.every((r) => r.coalesce === 'transform:a')).toBe(true);
    expect(node('a')?.transform2d).toEqual(T(3));

    await undo();
    expect(node('a')?.transform2d).toBeUndefined(); // the whole drag, one step
    await redo();
    expect(node('a')?.transform2d).toEqual(T(3));
  });

  it('Rust steps the history behind the webview: the store follows from history-stepped alone', async () => {
    await setup([pixel('a')]);
    state().setNodeTransform('a', T(5));
    await settle();
    expect(node('a')?.transform2d).toEqual(T(5));
    const sent = host.runs.length;
    await undo(); // the menu: Rust runs edit.undo itself, the webview sends nothing
    expect(host.runs.length).toBe(sent + 1);
    expect(host.trace.filter((t) => t === 'run:edit.undo')).toHaveLength(1);
    expect(node('a')?.transform2d).toBeUndefined();
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('Undo while a gesture is open does nothing: Rust refuses it, and the item is greyed', async () => {
    await setup([pixel('a')]);
    state().setNodeTransform('a', T(1));
    await settle();
    transaction.beginTransaction();
    await settle();
    state().setNodeTransform('a', T(2));
    await settle();
    await undo();
    expect(node('a')?.transform2d).toEqual(T(2)); // the drag is still going
    transaction.endTransaction();
    await settle();
    await undo();
    expect(node('a')?.transform2d).toEqual(T(1)); // the drag was one step
  });

  it('undo takes back an added layer, and nothing beyond the empty document', async () => {
    await setup();
    const id = state().addPixelNode({ sourcePath: '/x.png', sourceSize: [10, 10] });
    await settle();
    await undo();
    expect(node(id)).toBeUndefined();
    await undo(); // no further
    expect(state().scene.nodes).toHaveLength(0);
    expect(host.runs[host.runs.length - 1].id).toBe('edit.undo');
  });

  it('an unmatched begin is closed before the next opens', async () => {
    await setup([pixel('a')]);
    transaction.beginTransaction();
    transaction.beginTransaction();
    transaction.endTransaction();
    await settle();
    expect(host.trace.filter((t) => /^(begin|end)/.test(t))).toEqual([
      'begin:Edit',
      'end:1',
      'begin:Edit',
      'end:2',
    ]);
  });

  it('cancel takes the gesture back and restores the store', async () => {
    await setup([pixel('a')]);
    transaction.beginTransaction();
    state().setNodeTransform('a', T(9));
    await settle();
    expect(node('a')?.transform2d).toEqual(T(9));
    transaction.cancelTransaction();
    await settle();
    expect(host.trace).toContain('cancel:1');
    expect(node('a')?.transform2d).toBeUndefined();
  });
});

describe('reconcile', () => {
  it('finds nothing to do when the store and rhizome agree', async () => {
    await setup([pixel('a')]);
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('lets rhizome win on a forced difference, and says so', async () => {
    await setup([pixel('a')]);
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: s.scene.nodes.map((n) => ({ ...n, opacity: 0.3 })) },
    }));
    await expect(rhizome.reconcile()).resolves.toBe('restored');
    expect(node('a')?.opacity).toBe(1);
    expect(host.messages.some((m) => m.startsWith('reconcile:') && m.includes('opacity'))).toBe(
      true,
    );
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('removes a layer rhizome refused', async () => {
    await setup();
    host.reject.add('layer.add');
    const id = state().addPixelNode({ sourcePath: '/x.png', sourceSize: [10, 10] });
    await settle();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    expect(node(id)).toBeDefined(); // still there until the reconcile
    await expect(rhizome.reconcile()).resolves.toBe('restored');
    expect(node(id)).toBeUndefined();
  });

  it('waits while a gesture is open or a command is queued', async () => {
    await setup([pixel('a')]);
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: s.scene.nodes.map((n) => ({ ...n, opacity: 0.3 })) },
    }));
    transaction.beginTransaction();
    await expect(rhizome.reconcile()).resolves.toBe('skipped');
    transaction.endTransaction();
    await settle();
    host.hold = new Promise(() => undefined);
    state().setNodeProp('a', { label: 'x' });
    await expect(rhizome.reconcile()).resolves.toBe('skipped');
    host.hold = null;
  });

  it('does not run before the host is live', async () => {
    await setup([pixel('a')], false);
    await expect(rhizome.reconcile()).resolves.toBe('skipped');
  });
});

describe('refusing what has not moved', () => {
  it('toasts and changes nothing for an action rhizome does not carry', async () => {
    await setup([pixel('a')]);
    const before = state().scene;
    state().removeNode('a');
    state().addModifier('a', 'blur', {});
    await settle();
    expect(state().scene).toBe(before);
    expect(host.runs).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'warning', message: "Remove node isn't on rhizome yet" }),
    );
  });
});
