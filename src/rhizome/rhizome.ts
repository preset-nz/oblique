/**
 * Oblique's document held in rhizome (Epic 21 story 1, "Runs on rhizome"): the wiring.
 *
 * - **Mirror.** A view, then updates (rhizome decision 48), kept as rows (`Mirror`).
 * - **Commands first** (drags and scrubs): `setNodeTransform`, `setNodeProp` and
 *   `setDocumentSize` send a command; the store changes when the update comes back, through
 *   the store's ORIGINAL action, so its dirty rules hold and Oblique's own history sees
 *   nothing.
 * - **Replace Image** (`setPixelSource`) is commands-first too, but a step of its own, not a
 *   drag: `layer.set_source` sends the new path and size, and Rust decides the fit. The update
 *   coming back puts the whole result (path, size, transform, mask refits) in the store at once.
 * - **Local first** (where a caller needs the result at once): `addPixelNode`,
 *   `addVectorNode`, `addTextNode` and `setTextProps` run the original action at once, then
 *   send the command.
 * - **Reconcile.** When nothing is queued and no gesture is open, the scene rebuilt from the
 *   mirror is compared with the store (cook state aside). A difference means rhizome refused
 *   something or the two rule sets disagree: rhizome wins through `restoreScene`, and the
 *   difference is logged.
 * - **Gestures.** `beginTransaction`/`endTransaction` become `pom_begin`/`pom_end`: a drag is
 *   one rhizome undo step. Cmd+Z is rhizome's.
 * - **Refusal.** Every other scene-writing action refuses with a toast (`refusal.ts`).
 * - **Startup.** The document host is made once the sidecar's op catalogue arrives
 *   (`document_init`); until then the channel is shut and edits wait in its queue.
 * - **Files.** `replaceDocument` (new, open), `save` and `saveAs` go through the same channel,
 *   so a drag still on its way lands first. A replaced document is read whole and put in the
 *   store through `restoreScene`; no reconcile diff is left behind. The status POM reports
 *   (path, unsaved) is what the project meta store follows.
 *
 * Only inside the Tauri app: the web build and the store's own tests run Oblique as it is.
 */
import { notify, type SnackbarOptions } from '@preset.nz/ux-kit';
import { bindProjectMeta } from '@/project/projectMeta';
import { setHistoryBackend, withoutCapture } from '@/scene/history';
import { restoreScene } from '@/scene/restore';
import { useSceneStore } from '@/scene/store';
import {
  IDENTITY_TRANSFORM_2D,
  isPixelNode,
  type Scene,
  type SceneNode,
  type Transform2D,
  type VectorMaskRef,
} from '@/scene/types';
import { useOpsCacheStore } from '@/sidecar/opsCache';
import {
  DOCUMENT_PATH,
  firstDifference,
  LAYERS_PATH,
  layerNode,
  layerPath,
  Mirror,
  normal,
  PROP_KEYS,
  transform2d,
  transformChanges,
  val,
} from './adapter';
import { installRefusals } from './refusal';
import {
  type Channel,
  createChannel,
  type Issue,
  inTauri,
  type Ran,
  type RhizomeBackend,
  type Row,
  type Status,
  tauriBackend,
  type Update,
  type View,
} from './transport';

type Store = typeof useSceneStore;

export interface RhizomeDeps {
  backend: RhizomeBackend;
  store: Store;
  notify: (options: SnackbarOptions) => void;
  /** Puts `target` in the store, re-decoding what it must. Defaults to `restoreScene`. */
  restore?: (current: Scene, target: Scene) => Promise<void>;
  nextFrame?: () => Promise<void>;
  /** Runs the reconcile later; defaults to `setTimeout`. */
  schedule?: (f: () => void, ms: number) => void;
  now?: () => number;
}

export type ReconcileResult = 'skipped' | 'same' | 'restored';

export interface Rhizome {
  readonly channel: Channel;
  readonly mirror: Mirror;
  /** Makes the document host from the op catalogue, then lets the queue through. Once. */
  start(ops: unknown[]): Promise<void>;
  /** Wraps the store's actions and takes over history. Returns the way back. */
  install(): () => void;
  /** Compares the mirror with the store now; rhizome wins. */
  reconcile(): Promise<ReconcileResult>;
  /** The transform last sent for a layer and not yet answered, if any. */
  latestTransform(id: string): Transform2D | undefined;
  /** Re-reads the whole document and puts it in the store (open, new, undo, redo, cancel). */
  rebuild(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  isLive(): boolean;
  /** A path macOS asked to open before the front end was listening, once. */
  takeLaunchPath(): string | null;
  /** The status as POM last reported it, and a way to hear about changes. */
  status(): Status | null;
  onStatus(f: (s: Status) => void): () => void;
  /**
   * Replaces the document with a new one or a file. Resolves with what the load couldn't
   * take as written; rejects with rhizome's own error, leaving the open document alone.
   * `beforeRestore` runs once the new document is read and the status (path) is known, and
   * before the store takes it: the place to clear caches and read baked bitmaps.
   */
  replaceDocument(
    what: { kind: 'new' } | { kind: 'open'; path: string },
    beforeRestore?: (target: Scene) => Promise<void>,
  ): Promise<Issue[]>;
  /** Plain Save: to the document's own file. Rejects when it has none. */
  save(): Promise<Status>;
  /** Saves to `path` (rhizome adds `.oblique` when it has no extension); the status names the file. */
  saveAs(path: string): Promise<Status>;
  /** macOS asked to open a document while the app is running. */
  onOpenDocument(f: (path: string) => void): Promise<() => void>;
}

const RECONCILE_DELAY_MS = 150;
const REPEAT_TOAST_MS = 2000;

/**
 * The op catalogue as `document_init` reads it (`Op` in document/mod.rs): only what the
 * object model needs, with absent fields left out rather than null.
 */
function catalogue(ops: unknown[]): unknown[] {
  return (ops as { name: string; params?: Record<string, unknown>[] }[]).map((op) => ({
    name: op.name,
    params: (op.params ?? []).map((p) => ({
      name: p.name,
      type: p.type,
      default: p.default ?? undefined,
      min: p.min ?? undefined,
      max: p.max ?? undefined,
      choices: p.choices ?? undefined,
    })),
  }));
}

const isCommitted = (ran: Ran): ran is { committed: { seq: number; label: string } } =>
  typeof ran === 'object' && ran !== null && 'committed' in ran;

export function createRhizome(deps: RhizomeDeps): Rhizome {
  const { backend, store } = deps;
  const channel = createChannel(backend, { nextFrame: deps.nextFrame });
  const mirror = new Mirror();
  const restore = deps.restore ?? ((current, target) => restoreScene(current, target));
  const schedule = deps.schedule ?? ((f, ms) => void setTimeout(f, ms));
  const now = deps.now ?? (() => Date.now());

  let live = false;
  let started: Promise<void> | null = null;
  let launchPath: string | null = null;
  let lastStatus: Status | null = null;
  /** Documents being replaced right now: their status and view are read by the replacing call. */
  let replacing = 0;
  const statusListeners = new Set<(s: Status) => void>();
  /** The highest commit seq a command answered with: the mirror must reach it before a compare. */
  let acked = 0;
  /**
   * Local-first commands not yet answered, by layer: an update for such a layer may predate a
   * newer local edit (a keystroke), so its echo must not be applied over it.
   */
  const localLayers = new Map<string, number>();
  let gesture: Promise<number> | null = null;
  let restoring: Promise<void> = Promise.resolve();
  let restoringNow = false;
  let reconcileQueued = false;

  const scene = () => store.getState().scene;
  const nodeOf = (id: string): SceneNode | undefined => scene().nodes.find((n) => n.id === id);

  // ---------------------------------------------------------------- reporting

  function info(message: string): void {
    console.info(`[rhizome] ${message}`);
    void backend.log(message);
  }

  let lastFailure = { text: '', at: 0 };
  function fail(e: unknown): void {
    const text = String(e);
    console.error('[rhizome] refused', e);
    void backend.log(`refused: ${text}`);
    const t = now();
    if (text === lastFailure.text && t - lastFailure.at < REPEAT_TOAST_MS) return;
    lastFailure = { text, at: t };
    deps.notify({ kind: 'error', message: "That change didn't go through", description: text });
  }

  // ---------------------------------------------------------------- sending

  function track(p: Promise<Ran>): Promise<Ran> {
    return p.then((ran) => {
      if (isCommitted(ran)) acked = Math.max(acked, ran.committed.seq);
      return ran;
    });
  }

  /** A drag's or scrub's command: latest wins, paced by frames. */
  function sendDrag(key: string, id: string, payload: unknown): Promise<unknown> {
    const sent = track(channel.drag(key, id, payload, gesture ? key : undefined))
      .catch(fail)
      .finally(scheduleReconcile);
    return sent;
  }

  /**
   * The transform last sent for a layer and not yet answered. The store only catches up when
   * the update comes back, so a caller building the next value from the store (an arrow-key
   * nudge) would start from a stale one.
   */
  const pendingTransforms = new Map<string, Transform2D>();
  let nudges = 0;

  /** A discrete command (one undo step, nothing to coalesce): its update applies the result. */
  function sendCommand(id: string, payload: unknown): void {
    track(channel.run(id, payload)).catch(fail).finally(scheduleReconcile);
  }

  /**
   * A command for an edit already made locally to `layer`. The count drops in the first
   * handler on the command's own promise, ahead of the next queued command starting, so that
   * command's update isn't taken for an echo of this one.
   */
  function sendLocal(layer: string, id: string, payload: unknown): void {
    localLayers.set(layer, (localLayers.get(layer) ?? 0) + 1);
    const sent = channel.run(id, payload);
    const settled = () => {
      const left = (localLayers.get(layer) ?? 1) - 1;
      if (left > 0) localLayers.set(layer, left);
      else localLayers.delete(layer);
      scheduleReconcile();
    };
    sent.then(settled, settled);
    track(sent).catch(fail);
  }

  // ---------------------------------------------------------------- the store's actions

  type State = ReturnType<Store['getState']>;
  const stateNow = () => store.getState();
  const original = {
    setNodeTransform: stateNow().setNodeTransform,
    setNodeProp: stateNow().setNodeProp,
    setDocumentSize: stateNow().setDocumentSize,
    addPixelNode: stateNow().addPixelNode,
    addVectorNode: stateNow().addVectorNode,
    addTextNode: stateNow().addTextNode,
    setTextProps: stateNow().setTextProps,
    setPixelSource: stateNow().setPixelSource,
  };

  const withoutDirty = (node: SceneNode) => {
    const { dirty: _dirty, ...rest } = node;
    return rest;
  };

  /** Local first: the original adds the layer (and picks its id); the command follows. */
  function addLocal<A extends unknown[]>(add: (...a: A) => string): (...a: A) => string {
    return (...args) => {
      const id = add(...args);
      const node = nodeOf(id);
      if (node) sendLocal(id, 'layer.add', { node: withoutDirty(node) });
      return id;
    };
  }

  const wrappers: Partial<State> = {
    setPixelSource: (id, sourcePath, sourceSize) => {
      const node = nodeOf(id);
      if (!node || !isPixelNode(node) || node.state === 'locked') return; // Rust holds it too
      const sameSize =
        !sourceSize ||
        (sourceSize[0] === node.sourceSize[0] && sourceSize[1] === node.sourceSize[1]);
      if (sameSize && sourcePath === node.sourcePath) {
        // Nothing for Rust to change (a missing file that came back as it was): the pixels did
        // change, so repaint, as the store action always did. Same values, so no step and no
        // difference for the reconcile.
        withoutCapture(() => original.setPixelSource(id, sourcePath, sourceSize));
        return;
      }
      sendCommand('layer.set_source', {
        at: layerPath(id),
        sourcePath,
        ...(sourceSize ? { sourceSize } : {}),
      });
    },
    setNodeTransform: (id: string, t: Transform2D) => {
      const node = nodeOf(id);
      if (!node || node.state === 'locked') return; // the store's own guard; Rust holds it too
      // Inside a gesture (a drag) the moves are one undo step and latest wins. Outside one
      // (a nudge) each is a step of its own, as before, so none may replace another.
      const key = gesture ? `transform:${id}` : `transform:${id}:${++nudges}`;
      pendingTransforms.set(id, t);
      void sendDrag(key, 'values.set', { changes: transformChanges(layerPath(id), t) }).finally(
        () => {
          if (pendingTransforms.get(id) === t) pendingTransforms.delete(id);
        },
      );
    },
    setNodeProp: (id, patch) => {
      if (!nodeOf(id)) return;
      const changes = Object.entries(patch)
        .filter(([, v]) => v !== undefined)
        .map(([key, value]) => ({ at: layerPath(id), key, value }));
      if (changes.length === 0) return;
      sendDrag(`prop:${id}:${changes.map((c) => c.key).join(',')}`, 'values.set', { changes });
    },
    setDocumentSize: (size) => sendDrag('document-size', 'document.set_size', { size }),
    addPixelNode: addLocal(original.addPixelNode),
    addVectorNode: addLocal(original.addVectorNode),
    addTextNode: addLocal(original.addTextNode),
    setTextProps: (id, patch) => {
      const before = scene();
      original.setTextProps(id, patch);
      if (scene() === before) return; // refused or nothing changed: nothing to tell rhizome
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      sendLocal(id, 'text.set', { at: layerPath(id), patch: defined });
    },
  };

  // ---------------------------------------------------------------- updates

  /**
   * A pixel layer whose source differs from the store's (`layer.set_source`, its undo or redo
   * landing here): the path and size, with the transform and mask refits Rust decided, in one
   * mutation, so no frame shows the new transform over the old size.
   */
  function applySourceEcho(r: Row): void {
    const node = nodeOf(r.name);
    if (!node || !isPixelNode(node) || r.type !== 'pixel') return;
    const path = r.refs?.source?.file ?? '';
    const size = val(r, 'sourceSize') as [number, number];
    if (
      path === node.sourcePath &&
      size[0] === node.sourceSize[0] &&
      size[1] === node.sourceSize[1]
    ) {
      return;
    }
    const maskRefs: Record<string, VectorMaskRef> = {};
    const built = layerNode(mirror.rows, r, maskRefs);
    original.setPixelSource(node.id, path, size, { transform2d: built.transform2d, maskRefs });
  }

  /**
   * An update's effect on the store, for the commands-first edits: each touched layer's
   * transform and props, and the document size, through the original actions, and a pixel
   * layer's new source with what Rust decided to go with it. Everything else (a layer added,
   * text, paths, order) is left to the reconcile.
   */
  function applyEcho(u: Update): void {
    if (restoringNow) return;
    // POM labels what undo, redo and a cancelled gesture commit "Undo <step>", "Redo <step>"
    // and "Cancel <gesture>" (rhizome-core `Tree::undo`, `redo`, `cancel`). The rebuild that follows them goes through `restoreScene`, which
    // also swaps the decoded pixels of a replaced image, but only when the path on screen still
    // differs from the target's: echoing the source here first would leave it nothing to see.
    const stepped = /^(Undo|Redo|Cancel)\b/.test(u.label);
    const layers = mirror.byPath(LAYERS_PATH);
    if (!layers) return;
    withoutCapture(() => {
      for (const r of u.rows) {
        if (r.path === DOCUMENT_PATH) {
          const size = val(r, 'documentSize') as [number, number] | undefined;
          const have = scene().documentSize;
          if (size && (size[0] !== have[0] || size[1] !== have[1])) original.setDocumentSize(size);
        } else if (r.parent === layers.id) {
          const node = nodeOf(r.name);
          if (!node || localLayers.has(node.id)) continue;
          if (!stepped) applySourceEcho(r);
          const t = transform2d(r);
          const h = nodeOf(node.id)?.transform2d;
          if (
            t &&
            (!h ||
              t.x !== h.x ||
              t.y !== h.y ||
              t.scaleX !== h.scaleX ||
              t.scaleY !== h.scaleY ||
              t.rotation !== h.rotation)
          ) {
            original.setNodeTransform(node.id, t);
          }
          const have = node as unknown as Record<string, unknown>;
          const patch: Record<string, unknown> = {};
          for (const k of PROP_KEYS) if (have[k] !== val(r, k)) patch[k] = val(r, k);
          if (Object.keys(patch).length > 0) original.setNodeProp(node.id, patch);
        }
      }
    });
  }

  function takeUpdate(u: Update): void {
    if (!live) return;
    const result = mirror.apply(u);
    if (result === 'gap') {
      void reload().catch(fail);
      return;
    }
    if (result === 'stale') return;
    applyEcho(u);
    scheduleReconcile();
  }

  function announce(s: Status): void {
    lastStatus = s;
    for (const f of statusListeners) f(s);
  }

  function takeStatus(s: Status): void {
    announce(s);
    // a replacing call reads the new view itself, once the path is in
    if (live && replacing === 0 && s.generation !== mirror.generation) {
      void rebuild().catch(fail);
    }
  }

  /** Re-reads the view into the mirror. A new generation (open, new) also restores the store. */
  async function reload(): Promise<void> {
    if (replacing > 0) return;
    const view = await backend.view();
    if (view.generation !== mirror.generation) return rebuild(view);
    if (view.seq >= mirror.seq) mirror.load(view);
    scheduleReconcile();
  }

  // ---------------------------------------------------------------- restoring and reconciling

  function restoreFromMirror(): Promise<void> {
    const run = async () => {
      const target = mirror.scene();
      if (!target) return;
      restoringNow = true;
      try {
        await restore(scene(), target);
      } finally {
        restoringNow = false;
      }
    };
    restoring = restoring.then(run, run);
    return restoring;
  }

  async function rebuild(known?: View): Promise<void> {
    const view = known ?? (await backend.view());
    mirror.load(view);
    acked = view.seq;
    await restoreFromMirror();
  }

  async function reconcile(): Promise<ReconcileResult> {
    if (!live || restoringNow || gesture || channel.pending > 0) {
      return 'skipped';
    }
    if (mirror.seq < acked) {
      // a command was answered but its update hasn't landed: read the document, then compare
      void reload().catch(fail);
      return 'skipped';
    }
    const target = mirror.scene();
    if (!target) return 'skipped';
    const diff = firstDifference(normal(scene()), normal(target));
    if (!diff) return 'same';
    info(`reconcile: the store differs from rhizome at ${diff}; rhizome wins`);
    await restoreFromMirror();
    return 'restored';
  }

  function scheduleReconcile(): void {
    if (reconcileQueued) return;
    reconcileQueued = true;
    schedule(() => {
      reconcileQueued = false;
      void reconcile().catch(fail);
    }, RECONCILE_DELAY_MS);
  }
  channel.onIdle(scheduleReconcile);

  // ---------------------------------------------------------------- gestures, undo, redo

  function endGesture(): void {
    const g = gesture;
    gesture = null;
    if (g) channel.end(g).catch(fail).finally(scheduleReconcile);
  }

  async function step(id: 'edit.undo' | 'edit.redo'): Promise<void> {
    endGesture();
    // rebuild whatever the answer: the document may have moved without `committed` saying so
    const failed = await channel.run(id).then(
      () => false,
      (e) => {
        fail(e);
        return true;
      },
    );
    if (!failed) await rebuild();
  }

  // ---------------------------------------------------------------- files

  async function replaceDocument(
    what: { kind: 'new' } | { kind: 'open'; path: string },
    beforeRestore?: (target: Scene) => Promise<void>,
  ): Promise<Issue[]> {
    endGesture(); // an unmatched begin: close it ahead of the replacement, which would drop it
    replacing += 1;
    try {
      // queued behind every edit made before it; a refusal (an old JSON file) throws here,
      // with the open document untouched
      let issues: Issue[] = [];
      if (what.kind === 'open') issues = await channel.openDocument(what.path);
      else await channel.newDocument();
      // the path first: relative sources resolve against it while the store is restored
      announce(await channel.status());
      const view = await channel.view();
      mirror.load(view);
      acked = view.seq;
      pendingTransforms.clear();
      localLayers.clear();
      const target = mirror.scene();
      if (target) {
        await beforeRestore?.(target);
        await restoreFromMirror();
      }
      return issues;
    } finally {
      replacing -= 1;
      scheduleReconcile();
    }
  }

  async function saveWith(write: () => Promise<unknown>): Promise<Status> {
    endGesture();
    await write();
    const s = await channel.status();
    announce(s);
    return s;
  }

  // ---------------------------------------------------------------- start

  function start(ops: unknown[]): Promise<void> {
    started ??= (async () => {
      const off: (() => void)[] = [];
      try {
        await backend.init(catalogue(ops));
        off.push(await backend.onUpdate(takeUpdate), await backend.onStatus(takeStatus));
        launchPath = await backend.connect();
        const view = await backend.view();
        mirror.load(view);
        acked = view.seq;
        // a new document's scene id is rhizome's; the store's is a random one nothing reads
        const target = mirror.scene();
        if (target && scene().id !== target.id) {
          store.setState((s) => ({ scene: { ...s.scene, id: target.id } }));
        }
        live = true;
        channel.release();
        info(`ready, ${mirror.rows.size} rows`);
      } catch (e) {
        for (const f of off) f();
        started = null; // the next catalogue (a sidecar restart) tries again
        fail(e);
      }
    })();
    return started;
  }

  function install(): () => void {
    const own = { ...wrappers };
    store.setState(own);
    const undoRefusals = installRefusals(store, { notify: deps.notify, now });
    setHistoryBackend({
      begin: () => {
        endGesture(); // an unmatched earlier begin: close it first, as history's own does
        const g = channel.begin('Edit');
        g.catch(fail);
        gesture = g;
      },
      end: endGesture,
      cancel: () => {
        const g = gesture;
        gesture = null;
        if (g) {
          channel
            .cancel(g)
            .then(() => rebuild())
            .catch(fail);
        }
      },
      undo: () => step('edit.undo'),
      redo: () => step('edit.redo'),
    });
    return () => {
      undoRefusals();
      setHistoryBackend(null);
      store.setState(original as Partial<State>);
    };
  }

  return {
    channel,
    mirror,
    start,
    install,
    reconcile,
    rebuild: () => rebuild(),
    undo: () => step('edit.undo'),
    redo: () => step('edit.redo'),
    latestTransform: (id) => pendingTransforms.get(id),
    isLive: () => live,
    takeLaunchPath: () => {
      const p = launchPath;
      launchPath = null;
      return p;
    },
    status: () => lastStatus,
    onStatus: (f) => {
      statusListeners.add(f);
      return () => void statusListeners.delete(f);
    },
    replaceDocument,
    save: () => saveWith(() => channel.run('file.save')),
    saveAs: (path) => saveWith(() => channel.saveAs(path)),
    onOpenDocument: (f) => backend.onOpenDocument(f),
  };
}

// ---------------------------------------------------------------- the app's instance

let instance: Rhizome | null = null;

/**
 * A layer's transform as the next edit should start from it: what was last sent, if rhizome
 * hasn't answered yet, else the store's (identity when it was never moved).
 */
export function currentTransform(id: string): Transform2D {
  return (
    instance?.latestTransform(id) ??
    useSceneStore.getState().scene.nodes.find((n) => n.id === id)?.transform2d ??
    IDENTITY_TRANSFORM_2D
  );
}

/** The running document host, or `null` outside the Tauri app. */
export const rhizome = (): Rhizome | null => instance;

/** Puts a host in place of the app's (or takes it away with `null`): the tests' way in. */
export function adoptRhizome(next: Rhizome | null): void {
  instance = next;
}

/**
 * Installs rhizome over the scene store, once, and starts the host when the sidecar's op
 * catalogue is in (and again, harmlessly, whenever it is re-sent). A no-op outside the Tauri
 * app. `onLive` runs once, when the host is up: the place to open what macOS launched the
 * app with.
 */
export function installRhizome(options: { onLive?: (r: Rhizome) => void } = {}): void {
  if (instance || !inTauri()) return;
  const r = createRhizome({ backend: tauriBackend, store: useSceneStore, notify });
  instance = r;
  r.install();
  bindProjectMeta(r);
  let announced = false;
  const begin = (ops: unknown[]) => {
    if (ops.length === 0) return;
    void r.start(ops).then(() => {
      if (announced || !r.isLive()) return;
      announced = true;
      options.onLive?.(r);
    });
  };
  begin(useOpsCacheStore.getState().ops);
  useOpsCacheStore.subscribe((s) => begin(s.ops));
}
