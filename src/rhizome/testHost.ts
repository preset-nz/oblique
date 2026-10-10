/**
 * A fake document host for the tests: the commands moved so far (`layer.add`, `layer.remove`,
 * `layer.reorder`, `layer.duplicate`, `values.set`, `text.set`, `document.set_size`,
 * `layer.set_source`, `modifier.*`, `mask.*`, undo and redo, gestures), applied to rows built with the
 * adapter's `rowsFromScene`, and emitted as updates before the command answers, as Tauri
 * does. A stand-in for src-tauri/src/document, whose own tests hold the real rules.
 *
 * Opening, saving and New are app-kit's, in Rust, so they are not commands the webview sends:
 * `openFile`, `newFile` and `saveFile` play what the document host does for them, in its order
 * (status events, then `document-opened` or `document-saved`).
 */
import { DUPLICATE_OFFSET_PX, textLabel } from '@/scene/store';
import type { Scene, SceneNode } from '@/scene/types';
import { layerPath, layerRows, modifierPath, PARAM_PREFIX, rowsFromScene, val } from './adapter';
import type {
  Opened,
  Ran,
  RhizomeBackend,
  Row,
  Saved,
  Status,
  Stepped,
  Unlisten,
  Update,
  View,
} from './transport';

const clone = <T>(x: T): T => structuredClone(x);

const EMPTY_SCENE: Scene = {
  id: 'new',
  nodes: [],
  cameras: [],
  defaultCameraId: null,
  resolution: 'working',
  documentSize: [0, 0],
};

/** What a saved fake document starts with: anything else (an old JSON project) is refused. */
const MARK = 'fake-rhizome';

export class FakeHost implements RhizomeBackend {
  rows: Map<string, Row>;
  seq = 1;
  generation = 0;
  /** Every call, in the order it reached the host. */
  trace: string[] = [];
  /** The commands run, with their payloads. */
  runs: { id: string; payload: unknown; coalesce?: string }[] = [];
  inited: unknown[] | null = null;
  /** The op catalogue `init` was given: where `modifier.add` takes its defaults, as Rust does. */
  catalogue: { name: string; params?: { name: string; default?: unknown }[] }[] = [];
  messages: string[] = [];
  /** The files, by path: what `saveAs` writes and `open` reads. Shared between hosts in a test. */
  disk = new Map<string, string>();
  /** The document's file and whether it has changes since it was saved or made. */
  path: string | null = null;
  unsaved = false;
  /**
   * A file held until the catalogue arrives (relaunch restore, a cold Finder open): Rust opens
   * it inside `init`, before the webview's `init` call returns.
   */
  heldOpen: string | null = null;
  /**
   * Rust emits a held file's events after `init` has answered rather than inside it (Tauri
   * orders an event against a command's reply no more than this): `delay` ms after.
   */
  lateHeldEvents: number | null = null;
  /** What the next `openFile` reports the load couldn't take as written. */
  issues: Opened['issues'] = [];
  /** Held until released: lets a test keep a command in flight. */
  hold: Promise<void> | null = null;
  /** Command ids that fail. */
  reject = new Set<string>();
  /**
   * What Rust decides besides the path and size when `layer.set_source` brings a different
   * size (the fit and the mask refits, which only the Rust tests hold the rules for): a test
   * supplies the outcome it wants the webview to apply.
   */
  decided: ((layer: Row, rows: Map<string, Row>, size: [number, number]) => void) | null = null;

  private onCommit: ((u: Update) => void)[] = [];
  private onState: ((s: Status) => void)[] = [];
  private onStep: ((s: Stepped) => void)[] = [];
  private onOpened: ((o: Opened) => void | Promise<void>)[] = [];
  private onSaved: ((s: Saved) => void | Promise<void>)[] = [];
  private sentStatus: string | null = null;
  private undos: Map<string, Row>[] = [];
  private redos: Map<string, Row>[] = [];
  private gesture: { token: number; saved: boolean } | null = null;
  private tokens = 0;

  constructor(readonly scene: Scene) {
    this.rows = rowsFromScene(scene);
  }

  /** A saved document holding `scene`, as `saveAs` would write it. */
  static fileOf(scene: Scene): string {
    return JSON.stringify({ rhizome: MARK, rows: [...rowsFromScene(scene).values()] });
  }

  // ---------------------------------------------------------------- the host

  async init(ops: unknown[]): Promise<boolean> {
    this.trace.push('init');
    this.inited = ops;
    this.catalogue = ops as { name: string; params?: { name: string; default?: unknown }[] }[];
    const held = this.heldOpen;
    this.heldOpen = null;
    if (!held) return false;
    if (this.lateHeldEvents === null) {
      await this.openFile(held);
    } else {
      void this.openFile(held, true);
    }
    return true;
  }
  async connect(): Promise<void> {
    this.trace.push('connect');
    this.emitStatus();
  }
  async view(): Promise<View> {
    this.trace.push('view');
    return {
      seq: this.seq,
      generation: this.generation,
      schema: null,
      rows: clone([...this.rows.values()]),
    };
  }
  async status(): Promise<Status> {
    return this.statusNow();
  }
  private statusNow(): Status {
    return {
      title: this.path ?? 'Untitled',
      path: this.path,
      unsaved: this.unsaved,
      undo: this.undos.length > 0 ? 'Undo' : null,
      redo: this.redos.length > 0 ? 'Redo' : null,
      gesture: this.gesture !== null,
      generation: this.generation,
    };
  }
  async begin(label: string): Promise<number> {
    this.trace.push(`begin:${label}`);
    this.gesture = { token: ++this.tokens, saved: false };
    return this.gesture.token;
  }
  async end(token: number): Promise<void> {
    this.trace.push(`end:${token}`);
    this.gesture = null;
  }
  async cancel(token: number): Promise<void> {
    this.trace.push(`cancel:${token}`);
    if (this.gesture?.saved) this.restore(this.undos.pop());
    this.gesture = null;
  }
  /**
   * File > Open, Open Recent, Revert, a Finder open: app-kit asks the document host to open
   * `path`. A file that isn't a rhizome document throws, with the open document untouched and
   * nothing emitted (app-kit shows the error). Otherwise the status events go first, then
   * `document-opened`, and the listeners are awaited (Tauri doesn't; a test needs to know the
   * webview is done).
   */
  async openFile(path: string, late = false): Promise<void> {
    this.trace.push(`open:${path}`);
    const text = this.disk.get(path);
    if (text === undefined) throw `${path}: no such file`;
    let doc: { rhizome?: string; rows?: Row[] } | null = null;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = null;
    }
    if (doc?.rhizome !== MARK || !doc.rows) throw `${path}: not a rhizome document`;
    if (late) {
      // the document is replaced now; what the webview is told comes later
      const quiet = this.onState;
      this.onState = [];
      this.replaceWith(new Map(doc.rows.map((r) => [r.id, r])), path);
      this.onState = quiet;
      setTimeout(() => {
        this.sentStatus = null;
        this.emitStatus();
        for (const f of this.onOpened) void f({ issues: this.issues, path });
      }, this.lateHeldEvents ?? 0);
      return;
    }
    this.replaceWith(new Map(doc.rows.map((r) => [r.id, r])), path);
    await Promise.all(this.onOpened.map((f) => f({ issues: this.issues, path })));
  }
  /** File > New. */
  async newFile(): Promise<void> {
    this.trace.push('new');
    this.replaceWith(rowsFromScene({ ...EMPTY_SCENE, id: `new-${this.generation + 1}` }), null);
    await Promise.all(this.onOpened.map((f) => f({ issues: [], path: null })));
  }
  /**
   * File > Save and Save As…: app-kit asks the host to write `path` (it has added the extension).
   * The status events go first, then `document-saved` with the file the document had before.
   */
  async saveFile(path: string): Promise<void> {
    this.trace.push(`save:${path}`);
    const previous = this.path;
    this.write(path);
    await Promise.all(this.onSaved.map((f) => f({ previous, path })));
  }
  private write(path: string): void {
    this.disk.set(path, JSON.stringify({ rhizome: MARK, rows: [...this.rows.values()] }));
    this.path = path;
    this.unsaved = false;
    this.emitStatus();
  }
  private replaceWith(rows: Map<string, Row>, path: string | null): void {
    this.rows = clone(rows);
    this.seq = 0;
    this.generation += 1;
    this.undos = [];
    this.redos = [];
    this.gesture = null;
    this.path = path;
    this.unsaved = false;
    this.emitStatus();
  }
  /** Status events as Pom sends them: only when it differs from what was last sent. */
  private emitStatus(): void {
    const s = this.statusNow();
    const key = JSON.stringify(s);
    if (key === this.sentStatus) return;
    this.sentStatus = key;
    for (const f of this.onState) f(s);
  }
  async log(message: string): Promise<void> {
    this.messages.push(message);
  }
  async onUpdate(f: (u: Update) => void): Promise<Unlisten> {
    this.onCommit.push(f);
    return () => undefined;
  }
  async onStatus(f: (s: Status) => void): Promise<Unlisten> {
    this.onState.push(f);
    return () => undefined;
  }
  async onHistoryStepped(f: (s: Stepped) => void): Promise<Unlisten> {
    this.onStep.push(f);
    return () => undefined;
  }
  async onDocumentOpened(f: (o: Opened) => void | Promise<void>): Promise<Unlisten> {
    this.onOpened.push(f);
    return () => undefined;
  }
  async onDocumentSaved(f: (s: Saved) => void | Promise<void>): Promise<Unlisten> {
    this.onSaved.push(f);
    return () => undefined;
  }

  /**
   * Edit > Undo or Redo, as Rust does it: the host steps (nothing while a gesture is open, which
   * keeps Undo disabled), the commit events go out, then `history-stepped`. Not queued behind the
   * webview's edits: the menu never goes through the channel.
   */
  async step(undid: boolean): Promise<void> {
    if (this.gesture) return;
    const ran = await this.run(undid ? 'edit.undo' : 'edit.redo');
    if (typeof ran === 'object' && 'committed' in ran) {
      for (const f of this.onStep) f({ undid, label: '' });
    }
  }

  async run(id: string, payload: unknown = {}, coalesce?: string): Promise<Ran> {
    this.trace.push(`run:${id}`);
    this.runs.push({ id, payload, coalesce });
    if (this.hold) await this.hold;
    if (this.reject.has(id)) throw new Error(`${id} refused`);
    const p = payload as Record<string, unknown>;
    switch (id) {
      case 'layer.add':
        return this.commit('New Layer', () => this.addLayer(p.node as SceneNode));
      case 'values.set':
        return this.commit('Set Values', () => {
          for (const c of p.changes as { at: string; key: string; value: unknown }[]) {
            const row = this.at(c.at);
            if (c.key.startsWith('transform2d.') && val(row, 'state') === 'locked') {
              throw new Error(`${c.at} is locked`);
            }
            this.setValue(row, c.key, c.value);
          }
        });
      case 'text.set':
        return this.commit('Edit Text', () => {
          const row = this.at(p.at as string);
          if (val(row, 'state') === 'locked') throw new Error(`${p.at} is locked`);
          const patch = p.patch as Record<string, unknown>;
          const label = val(row, 'label');
          const before = textLabel(val(row, 'content') as string);
          for (const [k, v] of Object.entries(patch)) this.setValue(row, k, v);
          if (typeof patch.content === 'string' && label === before) {
            this.setValue(row, 'label', textLabel(patch.content));
          }
        });
      case 'layer.set_source':
        return this.commit('Replace Image', () => {
          const row = this.at(p.at as string);
          if (row.type !== 'pixel') throw new Error(`${p.at} isn't a pixel layer`);
          if (val(row, 'state') === 'locked') throw new Error(`${p.at} is locked`);
          row.refs = { ...row.refs, source: { file: p.sourcePath as string } };
          const size = p.sourceSize as [number, number] | undefined;
          const have = val(row, 'sourceSize') as [number, number];
          if (size && (size[0] !== have[0] || size[1] !== have[1])) {
            this.setValue(row, 'sourceSize', size);
            this.decided?.(row, this.rows, size);
          }
        });
      case 'layer.remove':
        return this.commit('Delete Layer', () => this.removeLayer(p.at as string));
      case 'layer.reorder': {
        const stack = this.layerStack(p.at as string);
        const to = Math.min(Math.max(p.to as number, 0), stack.length - 1);
        const row = this.at(p.at as string);
        if (stack.indexOf(row.id) === to) return 'nothing';
        return this.commit('Move Layer', () => {
          stack.splice(stack.indexOf(row.id), 1);
          stack.splice(to, 0, row.id);
          this.at('/layers').orders = { stack };
        });
      }
      case 'layer.duplicate':
        return this.commit('Duplicate Layer', () =>
          this.duplicateLayer(
            p.at as string,
            p.id as string,
            p.modifierIds as string[],
            p.maskIds as (string | null)[],
          ),
        );
      case 'modifier.add':
        return this.commit('Add Modifier', () =>
          this.addModifier(p.at as string, p.id as string, p.type as string, p.params),
        );
      case 'modifier.remove':
        return this.commit('Remove Modifier', () => {
          const { row, layer } = this.modifier(p.at as string);
          this.unlocked(layer);
          this.rows.delete(row.id);
          this.setOrder(
            layer,
            this.modifierOrder(layer).filter((id) => id !== row.id),
          );
        });
      case 'modifier.reorder': {
        const { row, layer } = this.modifier(p.at as string);
        this.unlocked(layer);
        const order = this.modifierOrder(layer);
        const to = Math.min(Math.max(p.to as number, 0), order.length - 1);
        if (order.indexOf(row.id) === to) return 'nothing';
        return this.commit('Move Modifier', () => {
          order.splice(order.indexOf(row.id), 1);
          order.splice(to, 0, row.id);
          this.setOrder(layer, order);
        });
      }
      case 'modifier.set':
        return this.commit('Set Modifier', () => {
          const { row, layer } = this.modifier(p.at as string);
          this.unlocked(layer);
          const key = p.key as string;
          if (key !== 'enabled' && !key.startsWith(PARAM_PREFIX)) {
            throw new Error(`${key} isn't a modifier value`);
          }
          if (key === 'enabled' && typeof p.value !== 'boolean') throw new Error('not a bool');
          this.setValue(row, key, p.value);
        });
      case 'mask.attach':
        return this.commit('Attach Mask', () => {
          const { row, layer } = this.modifier(p.at as string);
          this.unlocked(layer);
          const source = this.at(p.source as string);
          if (source.parent !== 'row:layers' || !['vector', 'text'].includes(source.type)) {
            throw new Error(`${p.source} can't be a mask`);
          }
          this.bindMask(row, source, [p.featherPx, p.expand, p.invert] as never, {
            space: p.space as string | undefined,
            attach: p.attachTransform,
          });
        });
      case 'mask.detach':
        return this.commit('Remove Mask', () => {
          const { row, layer } = this.modifier(p.at as string);
          this.unlocked(layer);
          if (!row.bindings?.length) throw new Error(`${p.at} has no mask`);
          delete row.bindings;
        });
      case 'mask.set_space': {
        const { row, layer } = this.modifier(p.at as string);
        this.unlocked(layer);
        const b = row.bindings?.[0];
        if (!b) throw new Error(`${p.at} has no mask`);
        if ((b.values?.space === 'node') === (p.space === 'node')) return 'nothing';
        return this.commit('Mask Follows Layer', () => {
          const source = this.rows.get(b.source) as Row;
          const v = b.values ?? {};
          this.bindMask(row, source, [v.featherPx, v.expand, v.invert] as never, {
            space: p.space === 'node' ? 'node' : undefined,
            attach: p.space === 'node' ? this.transformOf(layer) : undefined,
          });
        });
      }
      case 'mask.from_marquee':
        return this.commit('Mask from Selection', () => this.maskFromMarquee(p));
      case 'document.set_size':
        return this.commit('Document Size', () => {
          this.setValue(this.at('/document/document'), 'documentSize', p.size);
        });
      case 'edit.undo':
      case 'edit.redo': {
        const from = id === 'edit.undo' ? this.undos : this.redos;
        const to = id === 'edit.undo' ? this.redos : this.undos;
        const target = from.pop();
        if (!target) return 'nothing';
        to.push(clone(this.rows));
        this.restore(target);
        this.unsaved = true;
        this.emitStatus();
        return { committed: { seq: this.seq, label: id } };
      }
      default:
        throw new Error(`the fake host has no ${id}`);
    }
  }

  // ---------------------------------------------------------------- the rules

  private at(path: string): Row {
    const row = [...this.rows.values()].find((r) => r.path === path);
    if (!row) throw new Error(`${path} not found`);
    return row;
  }

  private setValue(row: Row, key: string, value: unknown): void {
    row.values = { ...row.values, [key]: value };
    if (!row.set?.includes(key)) row.set = [...(row.set ?? []), key];
  }

  private addLayer(node: SceneNode): void {
    if ([...this.rows.values()].some((r) => r.path === layerPath(node.id))) {
      throw new Error(`${node.id} already exists`);
    }
    const rows = layerRows(node, { maskRefs: {} } as Scene);
    for (const r of rows) this.rows.set(r.id, r);
    const layers = this.at('/layers');
    layers.orders = { stack: [rows[0].id, ...(layers.orders?.stack ?? [])] };
  }

  /** The row at `path`, which must be a layer; and the stack it sits in (a copy). */
  private layerStack(path: string): string[] {
    const row = this.at(path);
    if (row.parent !== 'row:layers') throw new Error(`${path} isn't a layer`);
    return [...(this.at('/layers').orders?.stack ?? [])];
  }

  /** `layer.remove`: the layer, its modifiers, and every binding sourced from it. */
  private removeLayer(path: string): void {
    const layer = this.at(path);
    this.layerStack(path);
    const gone = new Set([layer.id]);
    for (const r of this.rows.values()) if (r.parent === layer.id) gone.add(r.id);
    for (const id of gone) this.rows.delete(id);
    for (const r of this.rows.values()) {
      if (!r.bindings) continue;
      const kept = r.bindings.filter((b) => !gone.has(b.source));
      if (kept.length === r.bindings.length) continue;
      if (kept.length > 0) r.bindings = kept;
      else delete r.bindings;
    }
    const layers = this.at('/layers');
    layers.orders = { stack: (layers.orders?.stack ?? []).filter((id) => !gone.has(id)) };
  }

  /**
   * `layer.duplicate`, from the original's rows and the ids in the payload (copyNode's rules,
   * as Rust applies them): "<label> copy", active, offset, fresh modifier and mask ids, directly
   * above the original.
   */
  private duplicateLayer(
    path: string,
    id: string,
    modifierIds: string[],
    maskIds: (string | null)[],
  ): void {
    const src = this.at(path);
    const stack = this.layerStack(path);
    const mods = (src.orders?.modifiers ?? []).map((mid) => this.rows.get(mid) as Row);
    if (modifierIds.length !== mods.length || maskIds.length !== mods.length) {
      throw new Error('ids and modifiers differ');
    }
    if (this.rows.has(`row:layer:${id}`)) throw new Error(`${id} already exists`);
    const copyId = `row:layer:${id}`;
    const copy = clone(src);
    copy.id = copyId;
    copy.path = layerPath(id);
    copy.name = id;
    this.setValue(copy, 'label', `${val(src, 'label')} copy`);
    this.setValue(copy, 'state', 'active');
    const position = (val(src, 'transform2d.position') as [number, number] | undefined) ?? [0, 0];
    const scale = (val(src, 'transform2d.scale') as [number, number] | undefined) ?? [1, 1];
    const rotation = (val(src, 'transform2d.rotation') as number | undefined) ?? 0;
    this.setValue(copy, 'transform2d.position', [
      position[0] + DUPLICATE_OFFSET_PX,
      position[1] + DUPLICATE_OFFSET_PX,
    ]);
    this.setValue(copy, 'transform2d.scale', scale);
    this.setValue(copy, 'transform2d.rotation', rotation);
    const copies = mods.map((m, i) => {
      const mc = clone(m);
      mc.name = modifierIds[i];
      mc.id = `row:modifier:${id}:${modifierIds[i]}`;
      mc.path = `${copy.path}/${modifierIds[i]}`;
      mc.parent = copyId;
      if (mc.bindings) {
        const fresh = maskIds[i];
        if (!fresh) throw new Error(`${m.path}: a masked modifier came with no mask id`);
        mc.bindings = mc.bindings.map((b) => ({ ...b, values: { ...b.values, refId: fresh } }));
      }
      return mc;
    });
    if (copies.length > 0) copy.orders = { modifiers: copies.map((m) => m.id) };
    this.rows.set(copy.id, copy);
    for (const m of copies) this.rows.set(m.id, m);
    stack.splice(stack.indexOf(src.id), 0, copyId);
    this.at('/layers').orders = { stack };
  }

  /** The modifier row at `path` and the layer it belongs to. */
  private modifier(path: string): { row: Row; layer: Row } {
    const row = this.at(path);
    const layer = row.parent ? this.rows.get(row.parent) : undefined;
    if (layer?.parent !== 'row:layers' || !row.type.startsWith('op.')) {
      throw new Error(`${path} isn't a modifier`);
    }
    return { row, layer };
  }

  private unlocked(layer: Row): void {
    if (val(layer, 'state') === 'locked') throw new Error(`${layer.path} is locked`);
  }

  private modifierOrder(layer: Row): string[] {
    return [...(layer.orders?.modifiers ?? [])];
  }

  private setOrder(layer: Row, order: string[]): void {
    if (order.length > 0) layer.orders = { ...layer.orders, modifiers: order };
    else if (layer.orders) {
      const { modifiers: _gone, ...rest } = layer.orders;
      layer.orders = Object.keys(rest).length > 0 ? rest : undefined;
    }
  }

  /** `modifier.add`: last in the order, every param written: the catalogue's default or `own`. */
  private addModifier(path: string, id: string, type: string, own: unknown): void {
    const layer = this.at(path);
    if (layer.parent !== 'row:layers') throw new Error(`${path} isn't a layer`);
    this.unlocked(layer);
    const op = this.catalogue.find((o) => o.name === type);
    if (!op) throw new Error(`no op ${type}`);
    const row: Row = {
      id: `row:modifier:${layer.name}:${id}`,
      path: modifierPath(layer.name, id),
      name: id,
      type: `op.${type}`,
      role: 'node',
      parent: layer.id,
    };
    if (this.rows.has(row.id)) throw new Error(`${id} already exists`);
    this.setValue(row, 'enabled', true);
    for (const p of op.params ?? []) this.setValue(row, `${PARAM_PREFIX}${p.name}`, p.default);
    for (const [name, v] of Object.entries((own ?? {}) as Record<string, unknown>)) {
      if (!(op.params ?? []).some((p) => p.name === name)) throw new Error(`no param ${name}`);
      this.setValue(row, `${PARAM_PREFIX}${name}`, v);
    }
    this.rows.set(row.id, row);
    this.setOrder(layer, [...this.modifierOrder(layer), row.id]);
  }

  /** A layer's transform as a mask snapshots it: unmoved reads as the identity. */
  private transformOf(layer: Row): unknown {
    const [x, y] = (val(layer, 'transform2d.position') as [number, number] | undefined) ?? [0, 0];
    const [scaleX, scaleY] = (val(layer, 'transform2d.scale') as [number, number] | undefined) ?? [
      1, 1,
    ];
    const rotation = (val(layer, 'transform2d.rotation') as number | undefined) ?? 0;
    return { x, y, scaleX, scaleY, rotation };
  }

  /** The mask slot bound from `source`: it keeps its `refId`, else takes the modifier's id. */
  private bindMask(
    modifier: Row,
    source: Row,
    [featherPx, expand, invert]: [number, number, boolean],
    { space, attach }: { space?: string; attach?: unknown },
  ): void {
    const refId = (modifier.bindings?.[0]?.values?.refId as string | undefined) || modifier.name;
    modifier.bindings = [
      {
        on: { slot: 'mask' },
        source: source.id,
        values: {
          refId,
          featherPx,
          expand,
          invert,
          ...(space ? { space } : {}),
          ...(attach ? { attachTransform: attach } : {}),
        },
      },
    ];
  }

  /** `mask.from_marquee`: the hidden layer on top, the node-pinned binding, the replace rule. */
  private maskFromMarquee(p: Record<string, unknown>): void {
    const { row, layer } = this.modifier(p.at as string);
    this.unlocked(layer);
    const previous = row.bindings?.[0]?.source;
    const id = p.vectorId as string;
    if (this.rows.has(`row:layer:${id}`)) throw new Error(`${id} already exists`);
    const node = {
      id,
      type: 'vector',
      label: p.label,
      state: 'active',
      output: 'image',
      visible: false,
      blendMode: 'normal',
      opacity: 1,
      cameraId: null,
      modifiers: [],
      paths: p.paths,
      fillRule: p.fillRule,
    } as unknown as SceneNode;
    const [vector] = layerRows(node, { maskRefs: {} } as Scene);
    this.rows.set(vector.id, vector);
    const layers = this.at('/layers');
    layers.orders = { stack: [vector.id, ...(layers.orders?.stack ?? [])] };
    this.bindMask(row, vector, [p.featherPx, p.expand, p.invert] as never, {
      space: 'node',
      attach: this.transformOf(layer),
    });
    const old = previous ? this.rows.get(previous) : undefined;
    if (!old || old.id === vector.id || old.id === layer.id) return;
    const used = [...this.rows.values()].some((r) => r.bindings?.some((b) => b.source === old.id));
    if (!used && String(val(old, 'label')).startsWith('Selection (')) this.removeLayer(old.path);
  }

  /** One commit: the edit, the undo snapshot (one per gesture), and the update. */
  private commit(label: string, edit: () => void): Ran {
    const before = clone(this.rows);
    try {
      edit();
    } catch (e) {
      this.rows = before;
      throw e;
    }
    if (!this.gesture?.saved) this.undos.push(before);
    if (this.gesture) this.gesture.saved = true;
    this.redos = [];
    this.seq += 1;
    const update: Update = {
      seq: this.seq,
      label,
      changes: [],
      rows: clone([...this.rows.values()]),
      removed: [...before.keys()].filter((rid) => !this.rows.has(rid)),
      generation: this.generation,
    };
    for (const f of this.onCommit) f(update);
    this.unsaved = true;
    this.emitStatus();
    return { committed: { seq: this.seq, label } };
  }

  private restore(rows: Map<string, Row> | undefined): void {
    if (!rows) return;
    const removed = [...this.rows.keys()].filter((id) => !rows.has(id));
    this.rows = clone(rows);
    this.seq += 1;
    const update: Update = {
      seq: this.seq,
      label: 'Undo',
      changes: [],
      rows: clone([...this.rows.values()]),
      removed,
      generation: this.generation,
    };
    for (const f of this.onCommit) f(update);
  }
}
