/**
 * Transport boundary between the sidecar client's protocol logic and
 * Tauri IPC. `client.ts` is Tauri-free and testable with a mock
 * transport; `tauriTransport.ts` is the only file that touches
 * `@tauri-apps/api`.
 */

export interface SidecarStatusEvent {
  up: boolean;
  error?: string;
}

export interface SidecarTransport {
  /** Send raw bytes to the sidecar's stdin (already frame-encoded). */
  send(bytes: Uint8Array): Promise<void>;
  /** Subscribe to raw stdout chunks relayed from the sidecar. Returns an unsubscribe fn. */
  onFrame(cb: (chunk: Uint8Array) => void): () => void;
  /** Subscribe to sidecar up/down status events. Returns an unsubscribe fn. */
  onStatus(cb: (status: SidecarStatusEvent) => void): () => void;
}
