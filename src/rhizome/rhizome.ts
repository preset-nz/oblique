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
 * - **Layer edits** (story 3): `removeNode` (`layer.remove`) and `reorderNode`
 *   (`layer.reorder`) are commands-first, each a step of its own. Their update changes the
 *   store through the original action (`applyEcho`), so the cache eviction a delete needs runs
 *   once the layer is really gone (`scene/deleteNode.ts`). `duplicateNode` is local first: the
 *   caller selects the copy at once, so the original runs, picks the ids, and `layer.duplicate`
 *   carries them.
 * - **Modifiers and masks** (story 4): `removeModifier`, `reorderModifier`, `setModifierParam`,
 *   `setModifierEnabled`, `setModifierVectorMask`, `removeModifierMask` and `setMaskSpace` are
 *   commands-first (`modifier.*`, `mask.*`); a param or mask-number scrub inside a gesture is
 *   latest-wins, so one drag is one undo step. Their update changes the store through the
 *   original actions (`applyModifierEcho`), so the dirty rules hold. `addModifier` and
 *   `applyMarqueeAsVectorMask` are local first: the caller uses the id, or the new layer, at once.
 * - **Vectors and text** (story 5): `setVectorPaths`, `setVectorFillRule` and
 *   `convertTextToOutlines` are local first: the caller's overlay (a path drag's release, the
 *   pen's focus) and selection need the result at once, so the original runs, dirtying the layer
 *   and its masked consumers, and the command follows (`vector.set_paths`,
 *   `vector.set_fill_rule`, `text.to_outlines`). A path drag inside a gesture is latest-wins, so
 *   it is one undo step. Until the layer's commands are answered its updates are not echoed
 *   (`localLayers`), so an older frame can't pull the store back.
 * - **Local first** (where a caller needs the result at once): `addPixelNode`,
 *   `addVectorNode`, `addTextNode`, `duplicateNode`, `addModifier`, `applyMarqueeAsVectorMask`,
 *   `setVectorPaths`, `setVectorFillRule`, `convertTextToOutlines` and `setTextProps` run the
 *   original action at once, then send the command.
 * - **Reconcile.** When nothing is queued and no gesture is open, the scene rebuilt from the
 *   mirror is compared with the store (cook state aside). A difference means rhizome refused
 *   something or the two rule sets disagree: rhizome wins through `restoreScene`, and the
 *   difference is logged.
 * - **Gestures.** `beginTransaction`/`endTransaction` become `pom_begin`/`pom_end`: a drag is
 *   one rhizome undo step.
 * - **Undo and redo are app-kit's** (Epic 22 slice b): the Edit menu runs the document host's
 *   history in Rust, and the host says `history-stepped` after the commit events. That is the
 *   one cue to rebuild the store from the mirror; nothing here sends `edit.undo`.
 * - **Refusal.** Every other scene-writing action refuses with a toast (`refusal.ts`).
 * - **Startup.** The document host is made once the sidecar's op catalogue arrives
 *   (`document_init`); until then the channel is shut and edits wait in its queue.
 * - **Files are app-kit's** (Epic 22 slice c): New, Open, Open Recent, Revert, Save, Save As,
 *   relaunch restore and Finder opens all happen in Rust, which tells this side afterwards.
 *   - *Opened.* A replacement (a new status generation) is announced by `pom://status` first and
 *     by `document-opened` after. The status only tells this side a replacement is in flight:
 *     neither it, nor the mirror's echo, nor the reconcile may put the new scene in the store,
 *     because the project must clear its caches and read the baked bitmaps first. The
 *     `document-opened` handler reads the whole document and gives the project its turn
 *     (`DocumentEvents.opened`) before `restoreScene` takes the scene.
 *   - *Held at launch.* A file asked for before the sidecar's catalogue is applied inside
 *     `document_init`, so its `document-opened` is emitted during `backend.init`. The listeners
 *     are registered before that call, the event is kept until the host is live, then handled.
 *   - *Saved.* `document-saved` carries the previous and new path for the project's baked
 *     bitmaps and its relative-source re-check (`DocumentEvents.saved`).
 *   - The status POM reports (path) is what the project meta store follows; the unsaved mark and
 *     the window title are app-kit's.
 *
 * Only inside the Tauri app: the web build and the store's own tests run Oblique as it is.
 */
import { notify, type SnackbarOptions } from '@preset.nz/ux-kit';
import { bindProjectMeta } from '@/project/projectMeta';
import { restoreScene } from '@/scene/restore';
import { useSceneStore } from '@/scene/store';
import { setTransactionBackend } from '@/scene/transaction';
import {
  IDENTITY_TRANSFORM_2D,
  isPixelNode,
  isTextNode,
  isVectorNode,
  type Modifier,
  type Scene,
  type SceneNode,
  type Transform2D,
  type VectorMaskRef,
  type VectorNode,
} from '@/scene/types';
import { useOpsCacheStore } from '@/sidecar/opsCache';
import {
  DOCUMENT_PATH,
  firstDifference,
  LAYERS_PATH,
  layerNode,
  layerPath,
  Mirror,
  modifierPath,
  normal,
  PARAM_PREFIX,
  PROP_KEYS,
  reorderMoves,
  transform2d,
  transformChanges,
  val,
} from './adapter';
import { installRefusals } from './refusal';
import {
  type Channel,
  createChannel,
  inTauri,
  type Opened,
  type Ran,
  type RhizomeBackend,
  type Row,
  type Saved,
  type Status,
  tauriBackend,
  type Update,
  type View,
} from './transport';

type Store = typeof useSceneStore;

/**
 * Brings `target`, the document Rust just replaced the old one with, into the store: reads the
 * whole document, runs `beforeRestore` (the place to clear caches and read baked bitmaps), then
 * restores the scene. Resolves once the store holds it.
 */
export type Adopt = (beforeRestore?: (target: Scene) => Promise<void>) => Promise<void>;

/**
 * What the project does around the document rhizome holds, supplied by `project/io.ts` so that
 * this module knows nothing of baked bitmaps or sources.
 */
export interface DocumentEvents {
  /**
   * The document was replaced from Rust. Call `adopt` once, with what must run before the
   * scene reaches the store; whatever follows (marking dirty, the issues toast) goes after it.
   */
  opened(opened: Opened, adopt: Adopt): Promise<void>;
  /** The document was saved to a file; its status (path) has been announced already. */
  saved(saved: Saved): Promise<void>;
}

export interface RhizomeDeps {
  backend: RhizomeBackend;
  store: Store;
  notify: (options: SnackbarOptions) => void;
  /** The project's side of opening and saving. Without it a replaced document is just restored. */
  events?: DocumentEvents;
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
  isLive(): boolean;
  /** The status as POM last reported it, and a way to hear about changes. */
  status(): Status | null;
  onStatus(f: (s: Status) => void): () => void;
}

const RECONCILE_DELAY_MS = 150;
const REPEAT_TOAST_MS = 2000;

/**
 * The op catalogue as `document_init` reads it (`Op` in document/mod.rs): only what the
 * object model needs, with absent fields left out rather than null.
 */
function catalogue(ops: unknown[]): unknown[] {
  return (ops as { name: string; label?: string; params?: Record<string, unknown>[] }[]).map(
    (op) => ({
      name: op.name,
      label: op.label ?? undefined,
      params: (op.params ?? []).map((p) => ({
        name: p.name,
        label: p.label ?? undefined,
        type: p.type,
        default: p.default ?? undefined,
        min: p.min ?? undefined,
        max: p.max ?? undefined,
        choices: p.choices ?? undefined,
      })),
    }),
  );
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
  let lastStatus: Status | null = null;
  /**
   * Replacements Rust has announced (a status with a new generation) and `document-opened` has
   * not yet been handled for. While any is in flight the store must not be rebuilt from the
   * mirror, nor reconciled with it: the mirror still holds the old document, and the project has
   * not cleared its caches or read the baked bitmaps for the new one.
   */
  let opening = 0;
  /** The generation the last status named, to tell a replacement from an ordinary status. */
  let seenGeneration = 0;
  /** A `document-opened` that arrived before the host was live (a file held until the catalogue). */
  let earlyOpened: Opened | null = null;
  /** Opened-document handling, one at a time and in order. */
  let adopting: Promise<void> = Promise.resolve();
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
   * A command for an edit already made locally to `layers`. The count drops in the first
   * handler on the command's own promise, ahead of the next queued command starting, so that
   * command's update isn't taken for an echo of this one.
   */
  function sendLocal(layers: string | string[], id: string, payload: unknown): void {
    const named = typeof layers === 'string' ? [layers] : layers;
    for (const layer of named) localLayers.set(layer, (localLayers.get(layer) ?? 0) + 1);
    const sent = channel.run(id, payload);
    const settled = () => {
      for (const layer of named) {
        const left = (localLayers.get(layer) ?? 1) - 1;
        if (left > 0) localLayers.set(layer, left);
        else localLayers.delete(layer);
      }
      scheduleReconcile();
    };
    sent.then(settled, settled);
    track(sent).catch(fail);
  }

  /**
   * `sendLocal` for an edit that may repeat inside a gesture: latest wins (a drag is one undo
   * step), else each is a command of its own. Every call counts against the layer and settles
   * on the promise it gets back; a frame that replaced a waiting one gets the same promise, so
   * the count still balances.
   */
  function sendLocalScrub(layer: string, key: string, id: string, payload: unknown): void {
    localLayers.set(layer, (localLayers.get(layer) ?? 0) + 1);
    const sent = track(gesture ? channel.drag(key, id, payload, key) : channel.run(id, payload));
    const settled = () => {
      const left = (localLayers.get(layer) ?? 1) - 1;
      if (left > 0) localLayers.set(layer, left);
      else localLayers.delete(layer);
      scheduleReconcile();
    };
    sent.then(settled, settled);
    sent.catch(fail);
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
    removeNode: stateNow().removeNode,
    reorderNode: stateNow().reorderNode,
    duplicateNode: stateNow().duplicateNode,
    addModifier: stateNow().addModifier,
    removeModifier: stateNow().removeModifier,
    reorderModifier: stateNow().reorderModifier,
    setModifierParam: stateNow().setModifierParam,
    setModifierEnabled: stateNow().setModifierEnabled,
    setModifierVectorMask: stateNow().setModifierVectorMask,
    removeModifierMask: stateNow().removeModifierMask,
    setMaskSpace: stateNow().setMaskSpace,
    applyMarqueeAsVectorMask: stateNow().applyMarqueeAsVectorMask,
    setVectorPaths: stateNow().setVectorPaths,
    setVectorFillRule: stateNow().setVectorFillRule,
    convertTextToOutlines: stateNow().convertTextToOutlines,
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

  const modifierOf = (nodeId: string, modId: string): Modifier | undefined =>
    nodeOf(nodeId)?.modifiers.find((m) => m.id === modId);

  /** The modifier, if the store has it on a layer that isn't locked (Rust holds the lock too). */
  function editable(nodeId: string, modId: string): Modifier | undefined {
    const node = nodeOf(nodeId);
    return node && node.state !== 'locked' ? modifierOf(nodeId, modId) : undefined;
  }

  /** The vector layer, if the store has it and it isn't locked (Rust holds the lock too). */
  function editableVector(id: string): VectorNode | undefined {
    const node = nodeOf(id);
    return node && isVectorNode(node) && node.state !== 'locked' ? node : undefined;
  }

  /**
   * A scrub's command: inside a gesture latest wins (one drag, one undo step); outside one each
   * is a step of its own, as it always was.
   */
  function sendScrub(key: string, id: string, payload: unknown): void {
    if (gesture) void sendDrag(key, id, payload);
    else sendCommand(id, payload);
  }

  /**
   * The params a caller gave `addModifier` that differ from the op's defaults. Rust holds the
   * defaults, so a plain Add sends none; Duplicate Modifier passes the modifier's own values.
   * An op the cache doesn't know sends them all (Rust refuses the op anyway).
   */
  function ownParams(type: string, params: Modifier['params']): { params?: Modifier['params'] } {
    const op = useOpsCacheStore.getState().ops.find((o) => o.name === type);
    const own = Object.fromEntries(
      Object.entries(params).filter(
        ([name, v]) => v !== op?.params.find((p) => p.name === name)?.default,
      ),
    );
    return Object.keys(own).length > 0 ? { params: own } : {};
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
        original.setPixelSource(id, sourcePath, sourceSize);
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
    removeNode: (id) => {
      if (!nodeOf(id)) return;
      sendCommand('layer.remove', { at: layerPath(id) });
    },
    reorderNode: (id, to) => {
      if (!nodeOf(id)) return;
      // Rust clamps `to`; the store follows when the update comes back
      sendCommand('layer.reorder', { at: layerPath(id), to });
    },
    duplicateNode: (id) => {
      const newId = original.duplicateNode(id);
      const copy = newId ? nodeOf(newId) : undefined;
      if (!newId || !copy) return newId;
      // the ids the original picked go to Rust: a mask id per modifier, null where unmasked
      sendLocal(newId, 'layer.duplicate', {
        at: layerPath(id),
        id: newId,
        modifierIds: copy.modifiers.map((m) => m.id),
        maskIds: copy.modifiers.map((m) => m.maskId ?? null),
      });
      return newId;
    },
    addModifier: (nodeId, type, defaults) => {
      const modId = original.addModifier(nodeId, type, defaults);
      // a locked or missing layer: the original added nothing, and there is nothing to send
      if (!modifierOf(nodeId, modId)) return modId;
      sendLocal(nodeId, 'modifier.add', {
        at: layerPath(nodeId),
        id: modId,
        type,
        ...ownParams(type, defaults),
      });
      return modId;
    },
    removeModifier: (nodeId, modId) => {
      if (!editable(nodeId, modId)) return;
      sendCommand('modifier.remove', { at: modifierPath(nodeId, modId) });
    },
    reorderModifier: (nodeId, modId, toIndex) => {
      if (!editable(nodeId, modId)) return;
      // Rust clamps `toIndex`; the store follows when the update comes back
      sendCommand('modifier.reorder', { at: modifierPath(nodeId, modId), to: toIndex });
    },
    setModifierParam: (nodeId, modId, key, value) => {
      if (!editable(nodeId, modId)) return;
      sendScrub(`modifier:${nodeId}:${modId}:${key}`, 'modifier.set', {
        at: modifierPath(nodeId, modId),
        key: `${PARAM_PREFIX}${key}`,
        value,
      });
    },
    setModifierEnabled: (nodeId, modId, enabled) => {
      if (!editable(nodeId, modId)) return;
      sendCommand('modifier.set', {
        at: modifierPath(nodeId, modId),
        key: 'enabled',
        value: enabled,
      });
    },
    setModifierVectorMask: (nodeId, modId, vectorNodeId, ref) => {
      const mod = editable(nodeId, modId);
      // the id the mask has, or will take (the store's rule, `mask_ref_id` in Rust)
      const maskId = mod?.maskId ?? modId;
      const source = nodeOf(vectorNodeId);
      if (!mod || !source || !(isVectorNode(source) || isTextNode(source))) return maskId;
      sendScrub(`mask:${nodeId}:${modId}`, 'mask.attach', {
        at: modifierPath(nodeId, modId),
        source: layerPath(vectorNodeId),
        featherPx: ref.featherPx,
        expand: ref.expand,
        invert: ref.invert,
        ...(ref.space ? { space: ref.space } : {}),
        ...(ref.attachTransform ? { attachTransform: ref.attachTransform } : {}),
      });
      return maskId;
    },
    removeModifierMask: (nodeId, modId) => {
      if (!editable(nodeId, modId)?.maskId) return;
      sendCommand('mask.detach', { at: modifierPath(nodeId, modId) });
    },
    setMaskSpace: (nodeId, modId, space) => {
      const maskId = editable(nodeId, modId)?.maskId;
      const ref = maskId ? scene().maskRefs?.[maskId] : undefined;
      // already in that space: no command, as the store's own no-op
      if (!ref || (ref.space ?? 'document') === space) return;
      sendCommand('mask.set_space', { at: modifierPath(nodeId, modId), space });
    },
    applyMarqueeAsVectorMask: (nodeId, modId, marquee, params) => {
      // The original builds the layer and the mask here at once (the caller's UI reads them),
      // without sending a command of its own part by part; one command carries the whole edit.
      const made = original.applyMarqueeAsVectorMask(nodeId, modId, marquee, params);
      const vector = made ? nodeOf(made.vectorNodeId) : undefined;
      if (!made || !vector || !isVectorNode(vector)) return made;
      sendLocal([nodeId, made.vectorNodeId], 'mask.from_marquee', {
        at: modifierPath(nodeId, modId),
        vectorId: made.vectorNodeId,
        paths: vector.paths,
        fillRule: vector.fillRule,
        label: vector.label,
        featherPx: params.featherPx,
        expand: params.expand,
        invert: params.invert,
      });
      return made;
    },
    setVectorPaths: (id, paths) => {
      if (!editableVector(id)) return;
      // local first: the editor's overlay and the pen's focus read the store at once. Inside a
      // gesture latest wins (one drag, one undo step); outside one each edit is a step.
      original.setVectorPaths(id, paths);
      sendLocalScrub(id, `paths:${id}`, 'vector.set_paths', { at: layerPath(id), paths });
    },
    setVectorFillRule: (id, fillRule) => {
      const node = editableVector(id);
      if (!node || node.fillRule === fillRule) return; // already that rule: no step
      original.setVectorFillRule(id, fillRule);
      sendLocalScrub(id, `fill-rule:${id}`, 'vector.set_fill_rule', {
        at: layerPath(id),
        fillRule,
      });
    },
    convertTextToOutlines: (id, paths) => {
      // The original makes the vector layer at once (the caller selects it) and picks its id;
      // the command carries that id and the outlines TypeScript shaped. Null for a missing,
      // non-text or locked layer: nothing changed, nothing to send.
      const newId = original.convertTextToOutlines(id, paths);
      if (!newId) return null;
      sendLocal([id, newId], 'text.to_outlines', { at: layerPath(id), id: newId, paths });
      return newId;
    },
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
   * A layer's modifiers as the mirror has them, put in the store through the original actions
   * (so each marks the consumer dirty as the store always did): a modifier removed, a new
   * order, an `enabled` or param value, a mask attached, changed or taken off (feather, expand,
   * invert, space). A modifier the mirror has and the store hasn't is a local-first add the
   * store makes itself, and anything else is left to the reconcile.
   */
  function applyModifierEcho(nodeId: string): void {
    const row = mirror.byPath(layerPath(nodeId));
    if (!nodeOf(nodeId) || !row) return;
    const refs: Record<string, VectorMaskRef> = {};
    const want = layerNode(mirror.rows, row, refs).modifiers;
    const wantIds = want.map((m) => m.id);
    for (const m of nodeOf(nodeId)?.modifiers ?? []) {
      if (!wantIds.includes(m.id)) original.removeModifier(nodeId, m.id);
    }
    const haveIds = (nodeOf(nodeId)?.modifiers ?? []).map((m) => m.id);
    for (const m of reorderMoves(haveIds, wantIds)) original.reorderModifier(nodeId, m.id, m.to);
    for (const w of want) {
      const have = modifierOf(nodeId, w.id);
      if (!have) continue;
      if (have.enabled !== w.enabled) original.setModifierEnabled(nodeId, w.id, w.enabled);
      for (const [key, v] of Object.entries(w.params)) {
        if (have.params[key] !== v) original.setModifierParam(nodeId, w.id, key, v);
      }
      const ref = w.maskId ? refs[w.maskId] : undefined;
      const mine = have.maskId ? scene().maskRefs?.[have.maskId] : undefined;
      if (!ref) {
        if (have.maskId) original.removeModifierMask(nodeId, w.id);
      } else if (firstDifference(mine, ref) !== null) {
        const { id: _id, nodeId: source, ...numbers } = ref;
        original.setModifierVectorMask(nodeId, w.id, source, numbers);
      }
    }
  }

  /**
   * An update's effect on the store, for the commands-first edits: each touched layer's
   * transform and props, and the document size, through the original actions, and a pixel
   * layer's new source with what Rust decided to go with it. A layer deleted (`gone`, the names
   * of the layer rows the update removed) and a new stack order go through the original
   * `removeNode` and `reorderNode`. Everything else (a layer added, text, paths) is left to the
   * reconcile.
   */
  function applyEcho(u: Update, gone: string[]): void {
    if (restoringNow) return;
    // POM labels what undo, redo and a cancelled gesture commit "Undo <step>", "Redo <step>"
    // and "Cancel <gesture>" (rhizome-core `Tree::undo`, `redo`, `cancel`). The rebuild that follows them goes through `restoreScene`, which
    // also swaps the decoded pixels of a replaced image, but only when the path on screen still
    // differs from the target's: echoing the source here first would leave it nothing to see.
    const stepped = /^(Undo|Redo|Cancel)\b/.test(u.label);
    const layers = mirror.byPath(LAYERS_PATH);
    if (!layers) return;
    // Not for undo, redo and cancel: the rebuild that follows them goes through `restoreScene`,
    // which needs the layer still in the store to evict what it held.
    if (!stepped) {
      for (const id of gone) if (nodeOf(id)) original.removeNode(id);
      const target = (layers.orders?.stack ?? []).flatMap(
        (rid) => mirror.rows.get(rid)?.name ?? [],
      );
      const current = scene().nodes.map((n) => n.id);
      for (const m of reorderMoves(current, target)) original.reorderNode(m.id, m.to);
    }
    // the layers whose modifiers this update touched: a modifier row, or the layer row itself
    const modified = new Set<string>();
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
        if (!stepped) modified.add(node.id);
      } else if (!stepped) {
        const owner = r.parent ? mirror.rows.get(r.parent) : undefined;
        if (owner?.parent === layers.id && r.type.startsWith('op.')) modified.add(owner.name);
      }
    }
    for (const id of modified) if (!localLayers.has(id)) applyModifierEcho(id);
  }

  function takeUpdate(u: Update): void {
    if (!live) return;
    // the layers this update deletes, named before the mirror forgets their rows
    const layersRow = mirror.byPath(LAYERS_PATH);
    const gone = u.removed.flatMap((rid) => {
      const row = mirror.rows.get(rid);
      return row && layersRow && row.parent === layersRow.id ? row.name : [];
    });
    const result = mirror.apply(u);
    if (result === 'gap') {
      void reload().catch(fail);
      return;
    }
    if (result === 'stale') return;
    applyEcho(u, gone);
    scheduleReconcile();
  }

  function announce(s: Status): void {
    lastStatus = s;
    for (const f of statusListeners) f(s);
  }

  function takeStatus(s: Status): void {
    announce(s); // the path first: relative sources resolve against it while the store is restored
    if (s.generation === seenGeneration) return;
    seenGeneration = s.generation;
    // The whole tree was replaced. The store is rebuilt when `document-opened` follows, not now.
    // Before the host is live the first view and the held open (`start`) account for it.
    if (live) opening += 1;
  }

  /** Re-reads the view into the mirror. A new generation is a replacement, handled on its own cue. */
  async function reload(): Promise<void> {
    if (opening > 0) return;
    const view = await backend.view();
    if (view.generation !== mirror.generation) return;
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
    if (!live || restoringNow || gesture || channel.pending > 0 || opening > 0) {
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

  /**
   * Rust undid or redid a step (Edit > Undo, from app-kit): its commit events have reached the
   * mirror, so the store is rebuilt from it whatever they said. A gesture still open here would
   * have kept Undo disabled, so there is none to close.
   */
  function takeStepped(): void {
    if (opening > 0) return; // the replacement's own rebuild reads the document as it is
    void rebuild().catch(fail);
  }

  // ---------------------------------------------------------------- files

  /**
   * Puts the document Rust replaced the old one with in the store. The status (path) is
   * announced first; the view is read straight from the backend, not queued behind the
   * webview's edits, because those were made against the document that is gone.
   */
  const adopt: Adopt = async (beforeRestore) => {
    gesture = null; // the old document's: nothing of it survives the replacement
    const status = await backend.status();
    announce(status);
    seenGeneration = status.generation;
    const view = await backend.view();
    mirror.load(view);
    acked = view.seq;
    pendingTransforms.clear();
    localLayers.clear();
    const target = mirror.scene();
    if (!target) return;
    await beforeRestore?.(target);
    await restoreFromMirror();
  };

  function takeOpened(opened: Opened): Promise<void> {
    if (!live) {
      earlyOpened = opened;
      return Promise.resolve();
    }
    return handleOpened(opened);
  }

  function handleOpened(opened: Opened): Promise<void> {
    const run = async () => {
      try {
        if (deps.events) await deps.events.opened(opened, adopt);
        else await adopt();
      } catch (e) {
        fail(e);
        // The project's side failed, perhaps before it adopted anything: the store still has to
        // follow the document Rust holds. Adopting twice is harmless.
        await adopt().catch(fail);
      } finally {
        opening = Math.max(0, opening - 1);
        scheduleReconcile();
      }
    };
    adopting = adopting.then(run, run);
    return adopting;
  }

  function takeSaved(saved: Saved): Promise<void> {
    return Promise.resolve(deps.events?.saved(saved)).catch(fail);
  }

  // ---------------------------------------------------------------- start

  function start(ops: unknown[]): Promise<void> {
    started ??= (async () => {
      const off: (() => void)[] = [];
      try {
        // Before `init`: a file held until the catalogue is opened inside it, and its
        // `document-opened` is emitted there.
        off.push(
          await backend.onUpdate(takeUpdate),
          await backend.onStatus(takeStatus),
          await backend.onHistoryStepped(takeStepped),
          await backend.onDocumentOpened(takeOpened),
          await backend.onDocumentSaved(takeSaved),
        );
        const appliedHeld = await backend.init(catalogue(ops));
        await backend.connect();
        const view = await backend.view();
        mirror.load(view);
        acked = view.seq;
        seenGeneration = view.generation;
        announce(await backend.status());
        // a new document's scene id is rhizome's; the store's is a random one nothing reads
        const target = mirror.scene();
        if (target && scene().id !== target.id) {
          store.setState((s) => ({ scene: { ...s.scene, id: target.id } }));
        }
        // The file held until now was opened during `init`: the mirror already has it, the store
        // does not. Counted as a replacement in flight, so the reconcile leaves the store alone
        // until its `document-opened` has been handled. That event may have come before this
        // point (kept in `earlyOpened`) or may still be on its way (`appliedHeld`): Tauri
        // doesn't order an event against a command's reply, so both are covered. Either way
        // it is counted once.
        const held = earlyOpened;
        earlyOpened = null;
        if (held || appliedHeld) opening += 1;
        live = true;
        channel.release();
        info(`ready, ${mirror.rows.size} rows`);
        if (held) await handleOpened(held);
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
    setTransactionBackend({
      begin: () => {
        endGesture(); // an unmatched earlier begin: close it first
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
    });
    return () => {
      undoRefusals();
      setTransactionBackend(null);
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
    latestTransform: (id) => pendingTransforms.get(id),
    isLive: () => live,
    status: () => lastStatus,
    onStatus: (f) => {
      statusListeners.add(f);
      return () => void statusListeners.delete(f);
    },
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
 * app. `events` is the project's side of opening and saving (`project/io.ts`): a file held until
 * the host is up (relaunch restore, a cold Finder open) reaches it through the same path as
 * any other open.
 */
export function installRhizome(options: { events?: DocumentEvents } = {}): void {
  if (instance || !inTauri()) return;
  const r = createRhizome({
    backend: tauriBackend,
    store: useSceneStore,
    notify,
    events: options.events,
  });
  instance = r;
  r.install();
  bindProjectMeta(r);
  const begin = (ops: unknown[]) => {
    if (ops.length > 0) void r.start(ops);
  };
  begin(useOpsCacheStore.getState().ops);
  useOpsCacheStore.subscribe((s) => begin(s.ops));
}
