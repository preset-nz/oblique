/**
 * A fake document host for the tests: the commands moved so far (`layer.add`, `values.set`,
 * `text.set`, `document.set_size`, `layer.set_source`, undo and redo, gestures), applied to rows built with the
 * adapter's `rowsFromScene`, and emitted as updates before the command answers, as Tauri
 * does. A stand-in for src-tauri/src/document, whose own tests hold the real rules.
 *
 * Opening, saving and New are app-kit's, in Rust, so they are not commands the webview sends:
 * `openFile`, `newFile` and `saveFile` play what the document host does for them, in its order
 * (status events, then `document-opened` or `document-saved`).
 */
import { textLabel } from '@/scene/store';
import type { Scene, SceneNode } from '@/scene/types';
import { layerPath, layerRows, rowsFromScene, val } from './adapter';
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
      removed: [],
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
