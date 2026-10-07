/**
 * A fake document host for the tests: the commands moved so far (`layer.add`, `values.set`,
 * `text.set`, `document.set_size`, `layer.set_source`, undo and redo, gestures), applied to rows built with the
 * adapter's `rowsFromScene`, and emitted as updates before the command answers, as Tauri
 * does. A stand-in for src-tauri/src/document, whose own tests hold the real rules.
 */
import { textLabel } from '@/scene/store';
import type { Scene, SceneNode } from '@/scene/types';
import { layerPath, layerRows, rowsFromScene, val } from './adapter';
import type { Issue, Ran, RhizomeBackend, Row, Status, Unlisten, Update, View } from './transport';

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
  /** A path macOS asked to open before the front end listened. */
  launchPath: string | null = null;
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
  private onOpen: ((path: string) => void)[] = [];
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

  async init(ops: unknown[]): Promise<void> {
    this.trace.push('init');
    this.inited = ops;
  }
  async connect(): Promise<string | null> {
    this.trace.push('connect');
    const launched = this.launchPath;
    this.launchPath = null;
    this.emitStatus();
    return launched;
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
  async newDocument(): Promise<void> {
    this.trace.push('new');
    this.replaceWith(rowsFromScene({ ...EMPTY_SCENE, id: `new-${this.generation + 1}` }), null);
  }
  async open(path: string): Promise<Issue[]> {
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
    this.replaceWith(new Map(doc.rows.map((r) => [r.id, r])), path);
    return [];
  }
  async saveAs(path: string): Promise<void> {
    this.trace.push(`save-as:${path}`);
    this.write(/\.[^/.]+$/.test(path) ? path : `${path}.oblique`);
  }
  /** macOS opens a document while the app is running. */
  offerOpen(path: string): void {
    for (const f of this.onOpen) f(path);
  }
  async onOpenDocument(f: (path: string) => void): Promise<Unlisten> {
    this.onOpen.push(f);
    return () => undefined;
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

  async run(id: string, payload: unknown = {}, coalesce?: string): Promise<Ran> {
    this.trace.push(`run:${id}`);
    this.runs.push({ id, payload, coalesce });
    if (this.hold) await this.hold;
    if (this.reject.has(id)) throw new Error(`${id} refused`);
    const p = payload as Record<string, unknown>;
    switch (id) {
      case 'layer.add':
        return this.commit('New Layer', () => this.addLayer(p.node as SceneNode));
      case 'file.save':
        if (!this.path) throw 'the document has no file path';
        this.write(this.path);
        return 'nothing';
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
    if (!this.gesture || !this.gesture.saved) this.undos.push(before);
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
