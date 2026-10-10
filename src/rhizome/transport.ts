/**
 * The one module that talks to rhizome-pom-tauri (Epic 21 story 1): the `pom_*` commands, the
 * `pom://commit` and `pom://status` events, Oblique's own `document_init` / `document_log`, and
 * the document host's `history-stepped`, `document-opened` and `document-saved` (Epic 22).
 * Opening, saving and starting a new document are app-kit's, in Rust: this side only hears.
 * Commands only (rhizome decision 46): there is no way to send a raw edit.
 *
 * Two layers:
 * - `RhizomeBackend`, the raw calls. `tauriBackend` is the Tauri implementation; tests pass a
 *   fake.
 * - `createChannel`, the ordering on top of it. Every call goes through one promise chain, so
 *   commands reach Rust in the order they were made and a gesture's `end` finds its token. The
 *   chain is held shut until the document host exists (`release()`), which is how edits made
 *   before the sidecar's op catalogue arrives wait in the queue.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type NodeId = string;

/** One node as plain data (rhizome-core `Row`). */
export interface Row {
  id: NodeId;
  path: string;
  name: string;
  type: string;
  role: 'root' | 'category' | 'group' | 'node' | 'opaque';
  parent: NodeId | null;
  values?: Record<string, unknown>;
  set?: string[];
  refs?: Record<string, { file?: string; node?: NodeId }>;
  bindings?: {
    on: { slot?: string; value?: string };
    source: NodeId;
    values?: Record<string, unknown>;
  }[];
  orders?: Record<string, NodeId[]>;
  members?: NodeId[];
}

export interface View {
  seq: number;
  generation: number;
  schema: unknown;
  rows: Row[];
}

export interface Update {
  seq: number;
  label: string;
  changes: unknown[];
  rows: Row[];
  removed: NodeId[];
  generation: number;
}

export interface Status {
  title: string;
  path: string | null;
  unsaved: boolean;
  undo: string | null;
  redo: string | null;
  gesture: boolean;
  generation: number;
}

/** What an undo or redo did (the host's `history-stepped`): the step's own name, without the verb. */
export interface Stepped {
  undid: boolean;
  label: string;
}

/** One thing a load couldn't take as written (rhizome-pom `Issue`). */
export interface Issue {
  path: string;
  message: string;
}

/**
 * The document was replaced from Rust (File > Open, Open Recent, Revert, a Finder open, relaunch
 * restore, New): the host's `document-opened`. `path` is the file, `null` for a new document.
 */
export interface Opened {
  issues: Issue[];
  path: string | null;
}

/** The document was written to `path` (the host's `document-saved`); `previous` is its file before. */
export interface Saved {
  previous: string | null;
  path: string;
}

/** What `pom_run` answers (rhizome-pom `Ran`, snake_case). */
export type Ran = 'nothing' | { committed: { seq: number; label: string } } | { text: string };

export type Unlisten = () => void;

/** The raw calls to the document host. */
export interface RhizomeBackend {
  /**
   * Makes the host from the sidecar's op catalogue; a second call is a no-op. Answers whether it
   * opened a file held until now (relaunch restore, a cold Finder open): that file's
   * `document-opened` is on its way, and may land before or after this answer.
   */
  init(ops: unknown[]): Promise<boolean>;
  /** The front end is listening: ends any gesture a reloaded page left open, and sends the status. */
  connect(): Promise<void>;
  view(): Promise<View>;
  status(): Promise<Status>;
  run(id: string, payload?: unknown, coalesce?: string): Promise<Ran>;
  begin(label: string): Promise<number>;
  end(token: number): Promise<void>;
  cancel(token: number): Promise<void>;
  /** To the terminal running the app; never queued behind edits. */
  log(message: string): Promise<void>;
  onUpdate(f: (u: Update) => void): Promise<Unlisten>;
  onStatus(f: (s: Status) => void): Promise<Unlisten>;
  /**
   * Rust stepped the history (Edit > Undo or Redo, app-kit's): its commit and status events
   * have been sent already, so the mirror is current when this fires.
   */
  onHistoryStepped(f: (s: Stepped) => void): Promise<Unlisten>;
  /**
   * Rust replaced the document. Its status events (a new generation) have been sent already;
   * this is the cue to rebuild the store, and the only one. The listener's promise is awaited
   * by a test host and by nothing in the app.
   */
  onDocumentOpened(f: (o: Opened) => void | Promise<void>): Promise<Unlisten>;
  /** Rust saved the document; its status events have been sent already. */
  onDocumentSaved(f: (s: Saved) => void | Promise<void>): Promise<Unlisten>;
}

/** Only inside the Tauri app: the web build and the tests run Oblique as it is. */
export const inTauri = (): boolean => isTauri();

export const tauriBackend: RhizomeBackend = {
  init: (ops) => invoke<boolean>('document_init', { ops }),
  connect: async () => {
    await invoke<string | null>('pom_connect');
  },
  view: () => invoke<View>('pom_view'),
  status: () => invoke<Status>('pom_status'),
  run: (id, payload = {}, coalesce) => invoke<Ran>('pom_run', { id, payload, coalesce }),
  begin: (label) => invoke<number>('pom_begin', { label }),
  end: (token) => invoke<void>('pom_end', { token }),
  cancel: (token) => invoke<void>('pom_cancel', { token }),
  log: (message) => invoke<void>('document_log', { message }).catch(() => undefined),
  onUpdate: (f) => listen<Update>('pom://commit', (e) => f(e.payload)),
  onStatus: (f) => listen<Status>('pom://status', (e) => f(e.payload)),
  onHistoryStepped: (f) => listen<Stepped>('history-stepped', (e) => f(e.payload)),
  onDocumentOpened: (f) => listen<Opened>('document-opened', (e) => void f(e.payload)),
  onDocumentSaved: (f) => listen<Saved>('document-saved', (e) => void f(e.payload)),
};

// ---------------------------------------------------------------- the ordered channel

export interface ChannelOptions {
  /** Resolves after the next paint; a drag's next command waits for it. */
  nextFrame?: () => Promise<void>;
}

const defaultNextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });

interface Waiting {
  id: string;
  payload: unknown;
  coalesce?: string;
  done: Promise<Ran>;
}

export interface Channel {
  /** Calls made and not yet answered, drags that replaced a waiting move not counted. */
  readonly pending: number;
  /** Lets the queued calls through: the document host exists. */
  release(): void;
  /** Called whenever the queue empties. */
  onIdle(f: () => void): void;
  run(id: string, payload?: unknown, coalesce?: string): Promise<Ran>;
  /**
   * A drag's command: latest wins. While one is on its way, a newer move with the same key
   * replaces the one waiting instead of queueing behind it, and the next is sent only after a
   * frame, once the last update could be applied and painted. Without this a slow composite
   * builds a backlog and the layer trails the pointer.
   */
  drag(key: string, id: string, payload: unknown, coalesce?: string): Promise<Ran>;
  /** Opens a gesture; its token is what `end` and `cancel` take. */
  begin(label: string): Promise<number>;
  /** Takes the token's promise, so it is queued behind everything the gesture ran. */
  end(token: Promise<number>): Promise<void>;
  cancel(token: Promise<number>): Promise<void>;
  view(): Promise<View>;
  status(): Promise<Status>;
}

export function createChannel(backend: RhizomeBackend, options: ChannelOptions = {}): Channel {
  const nextFrame = options.nextFrame ?? defaultNextFrame;
  let release: () => void = () => undefined;
  let chain: Promise<unknown> = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending = 0;
  let idle: () => void = () => undefined;

  /** Runs `f` after every call made before it, and after the gate opens. */
  function queued<T>(f: () => Promise<T>): Promise<T> {
    pending += 1;
    const next = chain.then(f, f);
    chain = next.catch(() => undefined);
    const settle = () => {
      pending -= 1;
      if (pending === 0) idle();
    };
    next.then(settle, settle);
    return next;
  }

  const waiting = new Map<string, Waiting>();

  return {
    get pending() {
      return pending;
    },
    release: () => release(),
    onIdle: (f) => {
      idle = f;
    },
    run: (id, payload = {}, coalesce) => queued(() => backend.run(id, payload, coalesce)),
    drag(key, id, payload, coalesce) {
      const w = waiting.get(key);
      if (w) {
        w.id = id;
        w.payload = payload;
        w.coalesce = coalesce;
        return w.done;
      }
      const entry = { id, payload, coalesce } as Waiting;
      waiting.set(key, entry);
      entry.done = queued(async () => {
        waiting.delete(key);
        try {
          return await backend.run(entry.id, entry.payload, entry.coalesce);
        } finally {
          await nextFrame();
        }
      });
      return entry.done;
    },
    begin: (label) => queued(() => backend.begin(label)),
    end: (token) =>
      queued(async () => {
        const t = await token.catch(() => null);
        if (t !== null) await backend.end(t);
      }),
    cancel: (token) =>
      queued(async () => {
        const t = await token.catch(() => null);
        if (t !== null) await backend.cancel(t);
      }),
    view: () => queued(() => backend.view()),
    status: () => queued(() => backend.status()),
  };
}
