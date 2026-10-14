import { create } from 'zustand';
import { encodeFrame, FrameReassembler } from './frame';
import { type OpCategory, type OpDescriptor, useOpsCacheStore } from './opsCache';
import type { SidecarStatusEvent, SidecarTransport } from './transport';

export type SidecarConnStatus = 'up' | 'down';

interface SidecarStatusState {
  status: SidecarConnStatus;
  lastError?: string;
  setStatus: (status: SidecarConnStatus, error?: string) => void;
}

/** `status` drives the `SidecarStatusDot`; `lastError` feeds its tooltip. */
export const useSidecarStatusStore = create<SidecarStatusState>((set) => ({
  status: 'down',
  lastError: undefined,
  setStatus: (status, error) => set({ status, lastError: error }),
}));

export interface SidecarResponse {
  header: Record<string, unknown>;
  payload: Uint8Array;
}

const REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (value: SidecarResponse) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Promise-per-id request API over a `SidecarTransport`. Tauri-free by
 * design (transport is injected) so this logic is testable without a
 * webview — see `tauriTransport.ts` for the real IPC wiring and
 * `singleton.ts` for the app-wide instance.
 */
export class SidecarClient {
  private readonly transport: SidecarTransport;
  private readonly reassembler = new FrameReassembler();
  private readonly pending = new Map<string, PendingRequest>();
  private unlistenFrame?: () => void;
  private unlistenStatus?: () => void;

  constructor(transport: SidecarTransport) {
    this.transport = transport;
  }

  /** Wire up transport listeners and probe initial status. Call once. */
  start(): void {
    this.unlistenFrame = this.transport.onFrame((chunk) => this.handleChunk(chunk));
    this.unlistenStatus = this.transport.onStatus((status) => this.handleStatus(status));
    // Rust may emit the first `sidecar-status: up` before this listener
    // is registered (fire-and-forget `emit` during `setup()`), so don't
    // rely on catching it — probe with a ping to establish initial state.
    // Subsequent status changes (restarts, crashes) still come via events.
    void this.probeInitialStatus();
  }

  stop(): void {
    this.unlistenFrame?.();
    this.unlistenStatus?.();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('sidecar client stopped'));
      this.pending.delete(id);
    }
  }

  private async probeInitialStatus(): Promise<void> {
    try {
      await this.request({ op: 'ping' });
      this.handleStatus({ up: true });
    } catch {
      // Left 'down'; the sidecar-status event fired once spawn finishes
      // will bring it up and trigger the ops-cache refresh.
    }
  }

  private handleChunk(chunk: Uint8Array): void {
    for (const frame of this.reassembler.push(chunk)) {
      this.handleFrame(frame.header, frame.payload);
    }
  }

  private handleFrame(header: Record<string, unknown>, payload: Uint8Array): void {
    const id = header.id;
    if (typeof id !== 'string') return;
    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);
    clearTimeout(pending.timeout);

    if (header.ok === false) {
      const message = typeof header.error === 'string' ? header.error : 'sidecar request failed';
      pending.reject(new Error(message));
      return;
    }
    pending.resolve({ header, payload });
  }

  private handleStatus(status: SidecarStatusEvent): void {
    useSidecarStatusStore.getState().setStatus(status.up ? 'up' : 'down', status.error);
    if (status.up) {
      void this.refreshOpsCache();
    }
  }

  private async refreshOpsCache(): Promise<void> {
    try {
      const { header } = await this.request({ op: 'list_ops' });
      const ops = Array.isArray(header.ops) ? (header.ops as OpDescriptor[]) : [];
      const categories = Array.isArray(header.categories)
        ? (header.categories as OpCategory[])
        : [];
      useOpsCacheStore.getState().setOps(ops, categories);
    } catch {
      // Sidecar may have flapped again before list_ops landed; the next
      // 'up' event retries.
    }
  }

  /**
   * Send a request frame; resolves with the matching response frame.
   * `timeoutMs` defaults to `REQUEST_TIMEOUT_MS` — overridable per call for
   * the rare request whose real work can honestly exceed it (Epic 17's
   * `segment`: the first call downloads ~40 MB of weights synchronously
   * inside the sidecar, no progress frames, so the client-side timeout has
   * to cover that download, not just an ordinary cook).
   */
  request(
    header: Record<string, unknown>,
    payload: Uint8Array = new Uint8Array(0),
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<SidecarResponse> {
    const id = crypto.randomUUID();
    const fullHeader = { ...header, id };
    const frame = encodeFrame(fullHeader, payload);

    return new Promise<SidecarResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar request '${String(header.op)}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      this.transport.send(frame).catch((err: unknown) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }
}
