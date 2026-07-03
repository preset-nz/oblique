import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { SidecarStatusEvent, SidecarTransport } from './transport';

/** The one Tauri-coupled implementation of `SidecarTransport`. */
export const tauriTransport: SidecarTransport = {
  async send(bytes) {
    await invoke('sidecar_send', { bytes: Array.from(bytes) });
  },

  onFrame(cb) {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<number[]>('sidecar-frame', (event) => cb(new Uint8Array(event.payload))).then((fn) => {
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
