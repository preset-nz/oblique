import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFontCatalogueStore } from '@/fonts/catalogue';
import { importFile } from '@/project/import';
import * as cache from '@/scene/cache';
import { deleteNode } from '@/scene/deleteNode';
import * as sources from '@/scene/sources';
import { DUPLICATE_OFFSET_PX, useSceneStore } from '@/scene/store';
import { beginNewTextAt, commitActiveTextEdit, useTextEditStore } from '@/scene/textEditState';
import * as transaction from '@/scene/transaction';
import type {
  PixelNode,
  Scene,
  SceneNode,
  TextNode,
  VectorMaskRef,
  VectorNode,
} from '@/scene/types';
import { type OpDescriptor, useOpsCacheStore } from '@/sidecar/opsCache';
import { createRhizome, type DocumentEvents, type Rhizome } from './rhizome';
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

/** The store's own actions, before rhizome wraps them: what a layer edit must come to. */
const originals = { ...useSceneStore.getState() };

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
  events?: DocumentEvents,
) {
  const scene = { ...emptyScene(nodes), ...extra };
  useSceneStore.setState({ scene });
  host = new FakeHost(scene);
  rhizome = createRhizome({
    backend: host,
    store: useSceneStore,
    notify,
    restore,
    events,
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
        params: [
          {
            name: 'radius',
            label: 'Blur radius',
            type: 'float',
            default: 5,
            min: null,
            max: 100,
            scale: 'none',
          },
        ],
      },
    ]);
    expect(JSON.parse(JSON.stringify(host.inited))).toEqual([
      {
        name: 'blur',
        label: 'Blur',
        params: [{ name: 'radius', label: 'Blur radius', type: 'float', default: 5, max: 100 }],
      },
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

describe('a document replaced from Rust (app-kit: open, Revert, restore, Finder, New)', () => {
  /** A file holding one layer, for the host to open. */
  const putFile = (path: string, id = 'kept') => {
    host.disk.set(path, FakeHost.fileOf(emptyScene([pixel(id)])));
  };

  /** What the project and the store did, in order. */
  let order: string[];
  /** Records the order of the project's steps and what the store held at each. */
  const recording = (hold?: Promise<void>): DocumentEvents => ({
    opened: async (opened, adopt) => {
      order.push(`opened:${opened.path}`);
      await hold;
      await adopt(async (target) => {
        order.push(
          `before:${target.nodes.map((n) => n.id)}|store:${state().scene.nodes.map((n) => n.id)}`,
        );
      });
      order.push(`after|store:${state().scene.nodes.map((n) => n.id)}`);
    },
    saved: async (saved) => {
      order.push(`saved:${saved.previous}->${saved.path}`);
    },
  });
  const recordingRestore = async (_current: Scene, target: Scene) => {
    order.push('restore');
    useSceneStore.getState().loadScene(target);
  };

  beforeEach(() => {
    order = [];
  });

  it('runs the project before the scene reaches the store, then restores, in that order', async () => {
    await setup([pixel('old')], true, {}, recordingRestore, recording());
    putFile('/p/x.oblique');
    await host.openFile('/p/x.oblique');
    await settle();
    expect(order).toEqual([
      'opened:/p/x.oblique',
      'before:kept|store:old', // the old scene is still in the store when the project clears caches
      'restore',
      'after|store:kept',
    ]);
    expect(host.messages.filter((m) => m.startsWith('reconcile:'))).toEqual([]);
  });

  it('neither the status that announces it, nor the reconcile, puts the new scene in the store first', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await setup([pixel('old')], true, {}, recordingRestore, recording(held));
    putFile('/p/x.oblique');
    const opening = host.openFile('/p/x.oblique'); // status has gone out; document-opened waits on `held`
    await settle();
    // the status with the new generation has been heard: the path is known to the project
    expect(rhizome.status()?.path).toBe('/p/x.oblique');
    // ... and nothing rebuilt the store, nor will a reconcile
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['old']);
    expect(order).not.toContain('restore');
    await expect(rhizome.reconcile()).resolves.toBe('skipped');
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['old']);

    release();
    await opening;
    await settle();
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['kept']);
    expect(order.indexOf('restore')).toBeGreaterThan(-1);
    // and the reconcile is free again, with nothing to say
    await expect(rhizome.reconcile()).resolves.toBe('same');
    expect(host.messages.filter((m) => m.startsWith('reconcile:'))).toEqual([]);
  });

  it('a file held until the catalogue is opened inside init: the event is not lost, and nothing is reconciled', async () => {
    await setup([], false, {}, recordingRestore, recording());
    putFile('/p/held.oblique');
    host.heldOpen = '/p/held.oblique'; // Rust applies it during `init`
    await rhizome.start([]);
    await settle();
    expect(order).toEqual([
      'opened:/p/held.oblique',
      'before:kept|store:',
      'restore',
      'after|store:kept',
    ]);
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['kept']);
    expect(rhizome.status()?.path).toBe('/p/held.oblique');
    await expect(rhizome.reconcile()).resolves.toBe('same');
    expect(host.messages.filter((m) => m.startsWith('reconcile:'))).toEqual([]);
  });

  it('a held file whose events land after init has answered is gated the same way, with a reconcile in between', async () => {
    await setup([], false, {}, recordingRestore, recording());
    putFile('/p/held.oblique');
    host.heldOpen = '/p/held.oblique';
    host.lateHeldEvents = 15; // Tauri orders an event against a command's reply no more than this
    await rhizome.start([]);
    // init has answered and the host is live, but nothing has been heard of the open: the store
    // is still empty, and a reconcile in this window must leave it alone
    expect(rhizome.isLive()).toBe(true);
    expect(state().scene.nodes).toHaveLength(0);
    await expect(rhizome.reconcile()).resolves.toBe('skipped');
    expect(order).toEqual([]);

    await vi.waitFor(() => expect(order).toContain('restore'));
    await settle();
    expect(order).toEqual([
      'opened:/p/held.oblique',
      'before:kept|store:',
      'restore',
      'after|store:kept',
    ]);
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['kept']);
    await expect(rhizome.reconcile()).resolves.toBe('same');
    expect(host.messages.filter((m) => m.startsWith('reconcile:'))).toEqual([]);
  });

  it('a reloaded page (init answers false, no file held) is not gated', async () => {
    await setup([pixel('a')], false);
    await rhizome.start([]);
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('opens the same file twice in a row: the second still rebuilds', async () => {
    await setup([], true, {}, recordingRestore, recording());
    putFile('/p/x.oblique');
    await host.openFile('/p/x.oblique');
    await host.openFile('/p/x.oblique');
    await settle();
    expect(order.filter((o) => o === 'restore')).toHaveLength(2);
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('New replaces the document the same way, with no file', async () => {
    await setup([pixel('old')], true, {}, recordingRestore, recording());
    await host.newFile();
    await settle();
    expect(order[0]).toBe('opened:null');
    expect(state().scene.nodes).toHaveLength(0);
    expect(rhizome.status()?.path).toBeNull();
  });

  it('without the project (no events) a replaced document is simply restored', async () => {
    await setup([pixel('old')]);
    putFile('/p/x.oblique');
    await host.openFile('/p/x.oblique');
    await settle();
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['kept']);
  });

  it('a save tells the project where the document was and is, after the status', async () => {
    await setup([pixel('a')], true, {}, recordingRestore, recording());
    await host.saveFile('/p/a.oblique');
    await host.saveFile('/q/b.oblique');
    expect(order).toEqual(['saved:null->/p/a.oblique', 'saved:/p/a.oblique->/q/b.oblique']);
    expect(rhizome.status()?.path).toBe('/q/b.oblique');
    // a save is not a replacement: the store is left alone and the reconcile runs
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('a project handler that throws is a toast, and the store still follows the document', async () => {
    await setup([pixel('old')], true, {}, recordingRestore, {
      opened: async () => {
        throw new Error('boom');
      },
      saved: async () => undefined,
    });
    putFile('/p/x.oblique');
    await host.openFile('/p/x.oblique');
    await settle();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    // the handler never adopted the scene: rhizome did, and the gate is down
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['kept']);
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });
});

// ---------------------------------------------------------------- layer edits (story 3)

const vectorLayer = (id: string, over: Partial<VectorNode> = {}): VectorNode => ({
  id,
  label: 'Layer',
  type: 'vector',
  state: 'active',
  output: 'image',
  cameraId: null,
  modifiers: [],
  visible: true,
  blendMode: 'normal',
  opacity: 1,
  dirty: clean,
  paths: [],
  fillRule: 'nonzero',
  ...over,
});

const textLayer = (id: string): TextNode => ({
  id,
  label: 'Hi',
  type: 'text',
  state: 'active',
  output: 'image',
  cameraId: null,
  modifiers: [],
  visible: true,
  blendMode: 'normal',
  opacity: 1,
  dirty: clean,
  content: 'Hi',
  font,
  fontSize: 72,
  tracking: 0,
  kerning: 100,
  lineHeight: 1.2,
  align: 'left',
  fill: '#ffffff',
  stroke: null,
  position: { x: 1, y: 2 },
});

const ref = (over: Partial<VectorMaskRef> = {}): VectorMaskRef => ({
  id: 'r1',
  nodeId: 'v',
  featherPx: 3,
  expand: 1,
  invert: true,
  space: 'node',
  attachTransform: { x: 5, y: 6, scaleX: 2, scaleY: 1.5, rotation: 0.4 },
  ...over,
});

/** Layer `m` has a blurred, masked modifier (mask `r1` from the vector layer `v`) and a plain one. */
function maskedScene(): { nodes: SceneNode[]; extra: Partial<Scene> } {
  const v = vectorLayer('v', { label: 'Shape' });
  const m = pixel('m', {
    label: 'Photo',
    transform2d: { x: 100, y: 40, scaleX: -1, scaleY: 1, rotation: 0.3 },
    modifiers: [
      { id: 'mod1', type: 'blur', enabled: true, params: { radius: 12 }, maskId: 'r1' },
      { id: 'mod2', type: 'sharpen', enabled: false, params: {} },
    ],
  });
  return { nodes: [v, m, pixel('z')], extra: { maskRefs: { r1: ref() } } };
}

/** What the store's original action makes of `scene`, for `run` to be compared with. */
function plainResult(nodes: SceneNode[], extra: Partial<Scene>, run: () => void): Scene {
  useSceneStore.setState({ scene: { ...emptyScene(nodes), ...extra } });
  run();
  return useSceneStore.getState().scene;
}

describe('layer edits: remove (layer.remove)', () => {
  it('sends the command and changes the store only when the update comes back', async () => {
    await setup([pixel('a'), pixel('b')]);
    state().removeNode('a');
    expect(node('a')).toBeDefined(); // nothing local yet
    await settle();
    expect(host.runs.map((r) => ({ id: r.id, payload: r.payload }))).toEqual([
      { id: 'layer.remove', payload: { at: '/layers/a' } },
    ]);
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['b']);
    await expect(rhizome.reconcile()).resolves.toBe('same');
    expect(notify).not.toHaveBeenCalled();
  });

  it('prunes the masks the layer was the source of, with no reconcile difference', async () => {
    const { nodes, extra } = maskedScene();
    await setup(nodes, true, extra);
    state().removeNode('v');
    await settle();
    expect(node('v')).toBeUndefined();
    expect(node('m')?.modifiers.map((m) => m.maskId)).toEqual([undefined, undefined]);
    expect(state().scene.maskRefs).toEqual({});
    // the store's own action comes to the same
    const want = plainResult(nodes, extra, () => originals.removeNode('v'));
    expect(state().scene.nodes.map((n) => n.modifiers)).toEqual(want.nodes.map((n) => n.modifiers));
    await expect(rhizome.reconcile()).resolves.toBe('same');
    expect(host.messages.filter((m) => m.startsWith('reconcile:'))).toEqual([]);
  });

  it('undo brings the layer and its masks back, redo takes them away again', async () => {
    const { nodes, extra } = maskedScene();
    await setup(nodes, true, extra);
    state().removeNode('v');
    await settle();
    await undo();
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['v', 'm', 'z']);
    expect(node('m')?.modifiers[0].maskId).toBe('r1');
    expect(state().scene.maskRefs).toEqual({ r1: ref() });
    await expect(rhizome.reconcile()).resolves.toBe('same');
    await redo();
    expect(node('v')).toBeUndefined();
    expect(node('m')?.modifiers[0].maskId).toBeUndefined();
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('removes a locked layer, as the store always did', async () => {
    await setup([pixel('a', { state: 'locked' }), pixel('b')]);
    state().removeNode('a');
    await settle();
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['b']);
  });

  it('sends nothing for a layer the store does not have', async () => {
    await setup([pixel('a')]);
    state().removeNode('nope');
    await settle();
    expect(host.runs).toHaveLength(0);
  });

  it('a refusal from the host toasts and leaves the layer, and deleteNode evicts nothing', async () => {
    await setup([pixel('a'), pixel('b')]);
    const bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    cache.set('a', 'draft', bitmap);
    host.reject.add('layer.remove');
    deleteNode('a');
    await settle();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    expect(node('a')).toBeDefined();
    expect(cache.get('a', 'draft')).toBe(bitmap);
    expect(bitmap.close).not.toHaveBeenCalled();
    cache.clearAll();
  });

  it('deleteNode evicts when the update shows the layer gone, not when the command is sent', async () => {
    await setup([pixel('a'), pixel('b')]);
    const bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    cache.set('a', 'draft', bitmap);
    sources.set('a', bitmap);
    let release: () => void = () => undefined;
    host.hold = new Promise<void>((r) => {
      release = r;
    });
    deleteNode('a');
    await settle();
    expect(host.runs).toHaveLength(1); // sent, not yet answered
    expect(node('a')).toBeDefined();
    expect(cache.get('a', 'draft')).toBe(bitmap);
    host.hold = null;
    release();
    await settle();
    expect(node('a')).toBeUndefined();
    expect(cache.get('a', 'draft')).toBeUndefined();
    expect(sources.get('a')).toBeUndefined();
    expect(bitmap.close).toHaveBeenCalled();
  });
});

describe('layer edits: reorder (layer.reorder)', () => {
  const ids = () => state().scene.nodes.map((n) => n.id);
  const four = () => ['a', 'b', 'c', 'd'].map((id) => pixel(id));

  it.each([
    ['a', 3],
    ['d', 0],
    ['b', 2],
    ['c', 0],
    ['a', 1],
    ['d', 2],
    ['b', 3],
  ])(
    "moving %s to %i comes to what the store's reorderNode does, with no reconcile difference",
    async (id, to) => {
      const want = plainResult(four(), {}, () => originals.reorderNode(id, to)).nodes.map(
        (n) => n.id,
      );
      await setup(four());
      state().reorderNode(id, to);
      expect(ids()).toEqual(['a', 'b', 'c', 'd']); // nothing local yet
      await settle();
      expect(host.runs.map((r) => ({ id: r.id, payload: r.payload }))).toEqual([
        { id: 'layer.reorder', payload: { at: `/layers/${id}`, to } },
      ]);
      expect(ids()).toEqual(want);
      // compositing only: nothing is dirtied (dirty rule 4)
      for (const n of state().scene.nodes) expect(n.dirty).toEqual(clean);
      await expect(rhizome.reconcile()).resolves.toBe('same');
      expect(host.messages.filter((m) => m.startsWith('reconcile:'))).toEqual([]);
    },
  );

  it('is one undo step: undo puts the order back, redo moves it again', async () => {
    await setup(four());
    state().reorderNode('d', 0);
    await settle();
    expect(ids()).toEqual(['d', 'a', 'b', 'c']);
    await undo();
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);
    await redo();
    expect(ids()).toEqual(['d', 'a', 'b', 'c']);
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('clamps an index past the end to the end, and moving to where it is changes nothing', async () => {
    await setup(four());
    state().reorderNode('a', 99);
    await settle();
    expect(ids()).toEqual(['b', 'c', 'd', 'a']);
    state().reorderNode('a', 3); // already there
    await settle();
    expect(ids()).toEqual(['b', 'c', 'd', 'a']);
    await undo(); // the one step undone is the first move; the second was never a step
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('moves a locked layer: it is compositing only', async () => {
    await setup([pixel('a', { state: 'locked' }), pixel('b')]);
    state().reorderNode('a', 1);
    await settle();
    expect(ids()).toEqual(['b', 'a']);
  });

  it('sends nothing for a layer the store does not have', async () => {
    await setup(four());
    state().reorderNode('nope', 0);
    await settle();
    expect(host.runs).toHaveLength(0);
  });
});

describe('layer edits: duplicate (layer.duplicate)', () => {
  it('runs the original at once and sends the ids it picked', async () => {
    const { nodes, extra } = maskedScene();
    await setup(nodes, true, extra);
    const id = state().duplicateNode('m') as string;
    const copy = node(id);
    expect(copy).toBeDefined(); // local first: there at once
    expect(copy?.label).toBe('Photo copy');
    await settle();
    expect(host.runs).toHaveLength(1);
    expect(host.runs[0].id).toBe('layer.duplicate');
    expect(host.runs[0].payload).toEqual({
      at: '/layers/m',
      id,
      modifierIds: copy?.modifiers.map((m) => m.id),
      maskIds: [copy?.modifiers[0].maskId, null],
    });
    expect(copy?.modifiers[0].maskId).toBeTruthy();
    expect(copy?.modifiers[0].maskId).not.toBe('r1');
  });

  it("comes to what the store's duplicate comes to: no reconcile difference, masks included", async () => {
    const { nodes, extra } = maskedScene();
    await setup(nodes, true, extra);
    const id = state().duplicateNode('m') as string;
    await settle();
    await expect(rhizome.reconcile()).resolves.toBe('same');
    expect(host.messages.filter((m) => m.startsWith('reconcile:'))).toEqual([]);
    // directly above the original, offset, active, a fresh ref carrying the original's values
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['v', id, 'm', 'z']);
    expect(node(id)?.transform2d).toEqual({
      x: 100 + DUPLICATE_OFFSET_PX,
      y: 40 + DUPLICATE_OFFSET_PX,
      scaleX: -1,
      scaleY: 1,
      rotation: 0.3,
    });
    const newRef = state().scene.maskRefs?.[node(id)?.modifiers[0].maskId as string];
    expect(newRef).toEqual({ ...ref(), id: node(id)?.modifiers[0].maskId });
    expect(state().scene.maskRefs?.r1).toEqual(ref());
  });

  it('undo takes the copy and its mask away, redo brings them back', async () => {
    const { nodes, extra } = maskedScene();
    await setup(nodes, true, extra);
    const id = state().duplicateNode('m') as string;
    await settle();
    await undo();
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['v', 'm', 'z']);
    expect(Object.keys(state().scene.maskRefs ?? {})).toEqual(['r1']);
    await expect(rhizome.reconcile()).resolves.toBe('same');
    await redo();
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['v', id, 'm', 'z']);
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('a locked layer is copied active, and a layer never moved is copied at the offset', async () => {
    await setup([pixel('a', { state: 'locked' })]);
    const id = state().duplicateNode('a') as string;
    await settle();
    expect(node(id)?.state).toBe('active');
    expect(node('a')?.state).toBe('locked');
    expect(node(id)?.transform2d).toEqual({
      x: DUPLICATE_OFFSET_PX,
      y: DUPLICATE_OFFSET_PX,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    });
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });

  it('vector and text layers too', async () => {
    const text = textLayer('t');
    const shape = vectorLayer('s');
    await setup([text, shape]);
    state().duplicateNode('t');
    state().duplicateNode('s');
    await settle();
    expect(state().scene.nodes).toHaveLength(4);
    await expect(rhizome.reconcile()).resolves.toBe('same');
    expect(host.runs.map((r) => r.id)).toEqual(['layer.duplicate', 'layer.duplicate']);
  });

  it('sends nothing for a layer the store does not have, and returns null', async () => {
    await setup([pixel('a')]);
    expect(state().duplicateNode('nope')).toBeNull();
    await settle();
    expect(host.runs).toHaveLength(0);
  });

  it('a refusal from the host toasts, and the reconcile takes the copy back', async () => {
    await setup([pixel('a')]);
    host.reject.add('layer.duplicate');
    state().duplicateNode('a');
    await settle();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    await expect(rhizome.reconcile()).resolves.toBe('restored');
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['a']);
  });
});

describe('layer edits in a row', () => {
  it('duplicate, move the copy up and delete the original, each one undo step', async () => {
    await setup([pixel('a'), pixel('b')]);
    const id = state().duplicateNode('b') as string;
    state().reorderNode(id, 0);
    state().removeNode('b');
    await settle();
    expect(state().scene.nodes.map((n) => n.id)).toEqual([id, 'a']);
    await expect(rhizome.reconcile()).resolves.toBe('same');
    await undo();
    expect(state().scene.nodes.map((n) => n.id)).toEqual([id, 'a', 'b']);
    await undo();
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['a', id, 'b']);
    await undo();
    expect(state().scene.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    await expect(rhizome.reconcile()).resolves.toBe('same');
  });
});

// ---------------------------------------------------------------- modifiers and masks (story 4)

describe('modifiers and masks (modifier.*, mask.*)', () => {
  const OPS = [
    {
      name: 'blur',
      label: 'Blur',
      backend: 'python',
      params: [
        { name: 'radius', type: 'float', default: 5, min: 0, max: 100, scale: 'none' },
        { name: 'mode', type: 'enum', default: 'soft', choices: ['soft', 'hard'], scale: 'none' },
      ],
    },
    { name: 'sharpen', label: 'Sharpen', backend: 'python', params: [] },
  ] as unknown as OpDescriptor[];

  beforeEach(() => useOpsCacheStore.setState({ ops: OPS }));
  afterEach(() => useOpsCacheStore.setState({ ops: [] }));

  /** A store and a host over `nodes`, with the op catalogue the host takes defaults from. */
  async function withOps(nodes: SceneNode[], extra: Partial<Scene> = {}) {
    await setup(nodes, false, extra);
    await rhizome.start(OPS);
    await settle();
  }

  /** The store holds what the mirror does, and the terminal got no reconcile line. */
  const agrees = async () => {
    await expect(rhizome.reconcile()).resolves.toBe('same');
    expect(host.messages.filter((m) => m.startsWith('reconcile:'))).toEqual([]);
  };

  const sent = () => host.runs.map((r) => r.id);
  const modifiers = (id: string) => node(id)?.modifiers ?? [];
  const maskRefs = () => state().scene.maskRefs ?? {};

  /** `m` has three plain modifiers, and a masked one is `maskedScene`'s `mod1`. */
  const threeModifiers = (): SceneNode[] => [
    pixel('m', {
      modifiers: ['mod1', 'mod2', 'mod3'].map((id) => ({
        id,
        type: 'blur',
        enabled: true,
        params: { radius: 12 },
      })),
    }),
  ];

  describe('add (modifier.add)', () => {
    it('runs the original at once, sends the id it picked and no defaults, and agrees', async () => {
      await withOps([pixel('a')]);
      const id = state().addModifier('a', 'blur', { radius: 5, mode: 'soft' });
      expect(modifiers('a').map((m) => m.id)).toEqual([id]); // local first: there at once
      await settle();
      expect(host.runs.map((r) => ({ id: r.id, payload: r.payload }))).toEqual([
        { id: 'modifier.add', payload: { at: '/layers/a', id, type: 'blur' } },
      ]);
      // Rust took the defaults from the catalogue: the rows hold them, and the store matches
      await agrees();
      expect(node('a')?.dirty).toEqual({ draft: true, working: true });
    });

    it("sends a modifier's own values when they differ from the defaults (Duplicate Modifier)", async () => {
      await withOps([pixel('a')]);
      const id = state().addModifier('a', 'blur', { radius: 40, mode: 'soft' });
      await settle();
      expect(host.runs[0].payload).toEqual({
        at: '/layers/a',
        id,
        type: 'blur',
        params: { radius: 40 },
      });
      expect(modifiers('a')[0].params).toEqual({ radius: 40, mode: 'soft' });
      await agrees();
    });

    it('appends last, one undo step each', async () => {
      await withOps(threeModifiers());
      const id = state().addModifier('m', 'sharpen', {});
      await settle();
      expect(modifiers('m').map((m) => m.id)).toEqual(['mod1', 'mod2', 'mod3', id]);
      await agrees();
      await undo();
      expect(modifiers('m').map((m) => m.id)).toEqual(['mod1', 'mod2', 'mod3']);
      await agrees();
      await redo();
      expect(modifiers('m').map((m) => m.id)).toEqual(['mod1', 'mod2', 'mod3', id]);
      await agrees();
    });

    it('sends nothing for a locked or a missing layer', async () => {
      await withOps([pixel('a', { state: 'locked' })]);
      state().addModifier('a', 'blur', {});
      state().addModifier('nope', 'blur', {});
      await settle();
      expect(host.runs).toHaveLength(0);
      expect(modifiers('a')).toEqual([]);
    });

    it('a refusal from the host (an op it lacks) toasts, and the reconcile takes it back', async () => {
      await withOps([pixel('a')]);
      state().addModifier('a', 'no_such_op', {});
      await settle();
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
      await expect(rhizome.reconcile()).resolves.toBe('restored');
      expect(modifiers('a')).toEqual([]);
    });
  });

  describe('remove (modifier.remove)', () => {
    it('sends the command and changes the store only when the update comes back', async () => {
      await withOps(threeModifiers());
      state().removeModifier('m', 'mod2');
      expect(modifiers('m')).toHaveLength(3); // nothing local yet
      await settle();
      expect(host.runs.map((r) => ({ id: r.id, payload: r.payload }))).toEqual([
        { id: 'modifier.remove', payload: { at: '/layers/m/mod2' } },
      ]);
      expect(modifiers('m').map((m) => m.id)).toEqual(['mod1', 'mod3']);
      expect(node('m')?.dirty).toEqual({ draft: true, working: true });
      await agrees();
    });

    it('drops its mask and keeps the layer that was the mask, as the store does', async () => {
      const { nodes, extra } = maskedScene();
      await withOps(nodes, extra);
      state().removeModifier('m', 'mod1');
      await settle();
      expect(node('v')).toBeDefined();
      expect(maskRefs()).toEqual({});
      const want = plainResult(nodes, extra, () => originals.removeModifier('m', 'mod1'));
      expect(state().scene.nodes.map((n) => n.modifiers)).toEqual(
        want.nodes.map((n) => n.modifiers),
      );
      await agrees();
      await undo();
      expect(modifiers('m')[0].maskId).toBe('r1');
      expect(maskRefs()).toEqual({ r1: ref() });
      await agrees();
    });

    it('sends nothing for a locked layer or a modifier the store lacks', async () => {
      await withOps([
        pixel('a', {
          state: 'locked',
          modifiers: [{ id: 'x', type: 'blur', enabled: true, params: {} }],
        }),
      ]);
      state().removeModifier('a', 'x');
      state().removeModifier('a', 'nope');
      await settle();
      expect(host.runs).toHaveLength(0);
    });
  });

  describe('reorder (modifier.reorder)', () => {
    it.each([
      ['mod1', 2],
      ['mod3', 0],
      ['mod2', 0],
      ['mod2', 2],
      ['mod1', 1],
      ['mod3', 1],
    ])(
      "moving %s to %i comes to what the store's reorderModifier does, and agrees",
      async (id, to) => {
        const want = plainResult(threeModifiers(), {}, () =>
          originals.reorderModifier('m', id, to),
        ).nodes[0].modifiers.map((m) => m.id);
        await withOps(threeModifiers());
        state().reorderModifier('m', id, to);
        expect(modifiers('m').map((m) => m.id)).toEqual(['mod1', 'mod2', 'mod3']);
        await settle();
        expect(modifiers('m').map((m) => m.id)).toEqual(want);
        expect(host.runs.map((r) => r.payload)).toEqual([{ at: `/layers/m/${id}`, to }]);
        expect(node('m')?.dirty).toEqual({ draft: true, working: true }); // the order changes the pixels
        await agrees();
      },
    );

    it('is one undo step, and clamps an index past the end', async () => {
      await withOps(threeModifiers());
      state().reorderModifier('m', 'mod1', 99);
      await settle();
      expect(modifiers('m').map((m) => m.id)).toEqual(['mod2', 'mod3', 'mod1']);
      await undo();
      expect(modifiers('m').map((m) => m.id)).toEqual(['mod1', 'mod2', 'mod3']);
      await agrees();
    });
  });

  describe('params and enabled (modifier.set)', () => {
    it('sends the tree key, and the store follows the update through its own action', async () => {
      await withOps(threeModifiers());
      state().setModifierParam('m', 'mod1', 'radius', 30);
      expect(modifiers('m')[0].params.radius).toBe(12); // nothing local yet
      await settle();
      expect(host.runs[0]).toMatchObject({
        id: 'modifier.set',
        payload: { at: '/layers/m/mod1', key: 'params.radius', value: 30 },
      });
      expect(modifiers('m')[0].params.radius).toBe(30);
      expect(node('m')?.dirty).toEqual({ draft: true, working: true });
      await agrees();
    });

    it('keeps a value past the slider end (soft max) and toggles enabled', async () => {
      await withOps(threeModifiers());
      state().setModifierParam('m', 'mod1', 'radius', 250);
      state().setModifierEnabled('m', 'mod2', false);
      await settle();
      expect(modifiers('m')[0].params.radius).toBe(250);
      expect(modifiers('m')[1].enabled).toBe(false);
      expect(host.runs[1].payload).toEqual({ at: '/layers/m/mod2', key: 'enabled', value: false });
      await agrees();
      await undo();
      expect(modifiers('m')[1].enabled).toBe(true);
      await undo();
      expect(modifiers('m')[0].params.radius).toBe(12);
      await agrees();
    });

    it('a scrub inside a gesture is latest-wins and one undo step', async () => {
      await withOps(threeModifiers());
      transaction.beginTransaction();
      for (const r of [20, 30, 40, 50]) state().setModifierParam('m', 'mod1', 'radius', r);
      transaction.endTransaction();
      await settle();
      expect(modifiers('m')[0].params.radius).toBe(50);
      expect(host.runs.length).toBeLessThan(4); // the ones waiting were replaced
      expect(host.runs.every((r) => r.coalesce === 'modifier:m:mod1:radius')).toBe(true);
      await agrees();
      await undo();
      expect(modifiers('m')[0].params.radius).toBe(12); // the whole scrub is gone
      await agrees();
    });

    it('outside a gesture each edit is a step of its own', async () => {
      await withOps(threeModifiers());
      state().setModifierParam('m', 'mod1', 'radius', 20);
      state().setModifierParam('m', 'mod1', 'radius', 30);
      await settle();
      expect(host.runs).toHaveLength(2);
      await undo();
      expect(modifiers('m')[0].params.radius).toBe(20);
    });

    it('sends nothing for a locked layer or a modifier the store lacks', async () => {
      await withOps([
        pixel('a', {
          state: 'locked',
          modifiers: [{ id: 'x', type: 'blur', enabled: true, params: {} }],
        }),
      ]);
      state().setModifierParam('a', 'x', 'radius', 3);
      state().setModifierEnabled('a', 'x', false);
      state().setModifierParam('a', 'nope', 'radius', 3);
      await settle();
      expect(host.runs).toHaveLength(0);
    });
  });

  describe('masks (mask.attach, mask.detach, mask.set_space)', () => {
    /** `maskedScene` plus a second vector layer `w` and a text layer `t` to mask with. */
    const scene = () => {
      const { nodes, extra } = maskedScene();
      return { nodes: [...nodes, vectorLayer('w', { label: 'Other' }), textLayer('t')], extra };
    };

    it('attaches a fresh mask under the modifier id, returned at once, and agrees', async () => {
      const { nodes, extra } = scene();
      await withOps(nodes, extra);
      const id = state().setModifierVectorMask('m', 'mod2', 'v', {
        featherPx: 2,
        expand: 1,
        invert: false,
      });
      expect(id).toBe('mod2'); // the id a first mask takes
      expect(modifiers('m')[1].maskId).toBeUndefined(); // nothing local yet
      await settle();
      expect(host.runs[0].payload).toEqual({
        at: '/layers/m/mod2',
        source: '/layers/v',
        featherPx: 2,
        expand: 1,
        invert: false,
      });
      expect(modifiers('m')[1].maskId).toBe('mod2');
      const want = plainResult(nodes, extra, () =>
        originals.setModifierVectorMask('m', 'mod2', 'v', {
          featherPx: 2,
          expand: 1,
          invert: false,
        }),
      );
      expect(maskRefs().mod2).toEqual(want.maskRefs?.mod2);
      expect(node('m')?.dirty).toEqual({ draft: true, working: true });
      await agrees();
    });

    it('replacing the source or editing the numbers keeps the mask id, and a text layer masks too', async () => {
      const { nodes, extra } = scene();
      await withOps(nodes, extra);
      state().setModifierVectorMask('m', 'mod1', 'w', { featherPx: 9, expand: 0, invert: false });
      await settle();
      expect(maskRefs().r1).toEqual({
        id: 'r1',
        nodeId: 'w',
        featherPx: 9,
        expand: 0,
        invert: false,
      }); // document space again: a replace is the whole ref
      await agrees();
      state().setModifierVectorMask('m', 'mod1', 't', { featherPx: 1, expand: 0, invert: true });
      await settle();
      expect(maskRefs().r1.nodeId).toBe('t');
      await agrees();
      await undo();
      expect(maskRefs().r1.nodeId).toBe('w');
      await agrees();
    });

    it('a feather scrub inside a gesture is one undo step', async () => {
      const { nodes, extra } = scene();
      await withOps(nodes, extra);
      transaction.beginTransaction();
      for (const f of [4, 5, 6, 7]) {
        state().setModifierVectorMask('m', 'mod1', 'v', {
          featherPx: f,
          expand: 1,
          invert: true,
          space: 'node',
          attachTransform: ref().attachTransform,
        });
      }
      transaction.endTransaction();
      await settle();
      expect(maskRefs().r1.featherPx).toBe(7);
      await agrees();
      await undo();
      expect(maskRefs().r1).toEqual(ref());
      await agrees();
    });

    it('sends nothing for a source that cannot mask, a locked layer or a missing modifier', async () => {
      const { nodes, extra } = scene();
      await withOps(
        nodes.map((n) => (n.id === 'z' ? { ...n, state: 'locked' as const } : n)),
        extra,
      );
      const numbers = { featherPx: 1, expand: 0, invert: false };
      expect(state().setModifierVectorMask('m', 'mod2', 'z', numbers)).toBe('mod2'); // a pixel layer
      expect(state().setModifierVectorMask('m', 'mod2', 'nope', numbers)).toBe('mod2');
      expect(state().setModifierVectorMask('m', 'nope', 'v', numbers)).toBe('nope');
      await settle();
      expect(host.runs).toHaveLength(0);
    });

    it('detaches the mask and keeps the layer, as the store does', async () => {
      const { nodes, extra } = scene();
      await withOps(nodes, extra);
      state().removeModifierMask('m', 'mod1');
      expect(modifiers('m')[0].maskId).toBe('r1'); // nothing local yet
      await settle();
      expect(host.runs[0]).toMatchObject({ id: 'mask.detach', payload: { at: '/layers/m/mod1' } });
      expect(modifiers('m')[0].maskId).toBeUndefined();
      expect(maskRefs()).toEqual({});
      expect(node('v')).toBeDefined();
      await agrees();
      await undo();
      expect(maskRefs()).toEqual({ r1: ref() });
      await agrees();
    });

    it('detaching a modifier that has no mask sends nothing', async () => {
      const { nodes, extra } = scene();
      await withOps(nodes, extra);
      state().removeModifierMask('m', 'mod2');
      await settle();
      expect(host.runs).toHaveLength(0);
    });

    it("Follows Layer switches space as the store's setMaskSpace does, and agrees", async () => {
      const { nodes, extra } = scene();
      await withOps(nodes, extra);
      state().setMaskSpace('m', 'mod1', 'document');
      await settle();
      const asDocument = plainResult(nodes, extra, () =>
        originals.setMaskSpace('m', 'mod1', 'document'),
      );
      expect(maskRefs().r1).toEqual(asDocument.maskRefs?.r1);
      expect(maskRefs().r1.space).toBeUndefined();
      await agrees();
      // the layer moves, then follows again: the snapshot is the transform now
      state().setNodeTransform('m', T(77));
      await settle();
      state().setMaskSpace('m', 'mod1', 'node');
      await settle();
      expect(maskRefs().r1.space).toBe('node');
      expect(maskRefs().r1.attachTransform).toEqual(T(77));
      await agrees();
      await undo();
      expect(maskRefs().r1.space).toBeUndefined();
      await agrees();
    });

    it('is a no-op, sending nothing, when the mask is already in that space or there is none', async () => {
      const { nodes, extra } = scene();
      await withOps(nodes, extra);
      state().setMaskSpace('m', 'mod1', 'node'); // r1 is node-pinned already
      state().setMaskSpace('m', 'mod2', 'node'); // no mask
      await settle();
      expect(host.runs).toHaveLength(0);
    });

    it('a locked consumer sends nothing for any of them', async () => {
      const { nodes, extra } = scene();
      await withOps(
        nodes.map((n) => (n.id === 'm' ? { ...n, state: 'locked' as const } : n)),
        extra,
      );
      state().setModifierVectorMask('m', 'mod1', 'w', { featherPx: 1, expand: 0, invert: false });
      state().removeModifierMask('m', 'mod1');
      state().setMaskSpace('m', 'mod1', 'document');
      state().removeModifier('m', 'mod1');
      state().reorderModifier('m', 'mod1', 1);
      await settle();
      expect(host.runs).toHaveLength(0);
    });
  });

  describe('Mask from Selection (mask.from_marquee)', () => {
    const rect = { kind: 'rect', rect: { x: 10, y: 20, w: 30, h: 40 } } as const;
    const params = { featherPx: 2, expand: 1, invert: false };
    const withModifier = () =>
      pixel('a', {
        transform2d: { x: 30, y: 40, scaleX: 1, scaleY: 1, rotation: 0 },
        modifiers: [{ id: 'mod1', type: 'blur', enabled: true, params: { radius: 5 } }],
      });

    it('is one command and one undo step, and agrees', async () => {
      await withOps([withModifier(), pixel('b')]);
      const made = state().applyMarqueeAsVectorMask('a', 'mod1', rect, params);
      expect(made).toBeDefined();
      const sel = made?.vectorNodeId as string;
      // local first: the hidden layer is on top and bound at once
      expect(state().scene.nodes.map((n) => n.id)).toEqual([sel, 'a', 'b']);
      expect(node(sel)?.visible).toBe(false);
      expect(node(sel)?.label).toBe('Selection (rect)');
      await settle();
      // the whole edit is one command, not an add, an attach and a remove
      expect(sent()).toEqual(['mask.from_marquee']);
      expect(host.runs[0].payload).toMatchObject({
        at: '/layers/a/mod1',
        vectorId: sel,
        fillRule: 'nonzero',
        label: 'Selection (rect)',
        ...params,
      });
      expect(maskRefs().mod1).toEqual({
        id: 'mod1',
        nodeId: sel,
        ...params,
        space: 'node',
        attachTransform: { x: 30, y: 40, scaleX: 1, scaleY: 1, rotation: 0 },
      });
      await agrees();
      await undo();
      expect(state().scene.nodes.map((n) => n.id)).toEqual(['a', 'b']); // one step took it all back
      expect(maskRefs()).toEqual({});
      await agrees();
      await redo();
      expect(state().scene.nodes.map((n) => n.id)).toEqual([sel, 'a', 'b']);
      await agrees();
    });

    it('replaces an orphaned selection layer in the same step', async () => {
      await withOps([withModifier()]);
      const first = state().applyMarqueeAsVectorMask('a', 'mod1', rect, params)?.vectorNodeId;
      await settle();
      const second = state().applyMarqueeAsVectorMask(
        'a',
        'mod1',
        { ...rect, kind: 'ellipse' },
        params,
      )?.vectorNodeId as string;
      await settle();
      expect(sent()).toEqual(['mask.from_marquee', 'mask.from_marquee']);
      expect(state().scene.nodes.map((n) => n.id)).toEqual([second, 'a']); // the old one went
      expect(node(first as string)).toBeUndefined();
      expect(maskRefs().mod1.nodeId).toBe(second);
      await agrees();
      await undo(); // one step: the old selection layer is back and bound
      expect(state().scene.nodes.map((n) => n.id)).toEqual([first, 'a']);
      expect(maskRefs().mod1.nodeId).toBe(first);
      await agrees();
    });

    it('keeps a layer the user made or one another modifier shares', async () => {
      await withOps([withModifier(), vectorLayer('shape', { label: 'My shape' })]);
      state().setModifierVectorMask('a', 'mod1', 'shape', params);
      await settle();
      const sel = state().applyMarqueeAsVectorMask('a', 'mod1', rect, params)?.vectorNodeId;
      await settle();
      expect(state().scene.nodes.map((n) => n.id)).toEqual([sel, 'a', 'shape']);
      await agrees();
    });

    it('a locked consumer returns undefined and sends nothing', async () => {
      await withOps([{ ...withModifier(), state: 'locked' }]);
      expect(state().applyMarqueeAsVectorMask('a', 'mod1', rect, params)).toBeUndefined();
      await settle();
      expect(host.runs).toHaveLength(0);
      expect(state().scene.nodes).toHaveLength(1);
    });
  });
});

describe('refusing what has not moved', () => {
  it('toasts and changes nothing for an action rhizome does not carry', async () => {
    await setup([pixel('a')]);
    const before = state().scene;
    void state().lockNode('a', async () => ({}) as ImageBitmap);
    state().setNote('hello');
    await settle();
    expect(state().scene).toBe(before);
    expect(host.runs).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'warning', message: "Lock node isn't on rhizome yet" }),
    );
  });
});
