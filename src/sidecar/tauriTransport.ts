import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { SidecarStatusEvent, SidecarTransport } from './transport';

/**
 * The one Tauri-coupled implementation of `SidecarTransport`.
 *
 * Frame bytes cross the bridge RAW in both directions (Tauri 2 raw invoke
 * body out, raw IPC channel back) — never as JSON number arrays. Measured
 * 2026-07-04: the JSON path cost ~120 ms per 0.1 MP cook, ~10x the ops
 * themselves. Status events stay ordinary JSON events (tiny payloads).
 */

/**
 * Resolves once the frame channel is registered Rust-side — `send` awaits
 * it so an early request can't have its response dropped.
 */
let subscribed: Promise<void> | undefined;

function toBytes(message: unknown): Uint8Array {
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (message instanceof Uint8Array) return message;
  return new Uint8Array(message as number[]); // defensive: JSON fallback shape
}

export const tauriTransport: SidecarTransport = {
  async send(bytes) {
    if (subscribed) await subscribed;
    // Raw-body form of invoke: bytes go across the bridge untouched.
    await invoke('sidecar_send', bytes);
  },

  onFrame(cb) {
    let active = true;
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (message) => {
      if (active) cb(toBytes(message));
    };
    subscribed = invoke('sidecar_subscribe', { channel }).then(() => undefined);
    return () => {
      active = false;
    };
  },

  onStatus(cb) {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<SidecarStatusEvent>('sidecar-status', (event) => cb(event.payload)).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },
};
