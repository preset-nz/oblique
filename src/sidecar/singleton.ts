import { SidecarClient } from './client';
import { tauriTransport } from './tauriTransport';

/**
 * App-wide sidecar client instance, wired to the real Tauri transport.
 * A module-level singleton (not a `useEffect`) so React 19 StrictMode's
 * double-invoked effects can't register duplicate listeners or double
 * the initial handshake.
 */
export const sidecarClient = new SidecarClient(tauriTransport);
sidecarClient.start();
