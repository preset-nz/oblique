import { useEffect, useRef } from 'react';
import { loadAiSettings } from './ai/settings';
import { installProjectWindowIntegration } from './app/closeGuard';
import { Layout } from './app/Layout';
import { installMenu } from './app/menu';
import { installShortcuts } from './app/shortcuts';
import { useFontCatalogueStore } from './fonts/catalogue';
import { loadFontPreferences } from './fonts/preferences';
import { attachDocumentOpening } from './project/io';
import { installRhizome } from './rhizome/rhizome';
// Side-effecting import: wires up the app-wide cook scheduler singleton
// (store subscriptions + debounce/idle timers) the first time this module
// loads. Safe to import more than once — it's a singleton.
import './cook/singleton';
// Side-effecting import: starts the undo/history scene-store subscription
// (Epic 13) the first time this module loads. Safe to import more than
// once — the subscribe call is idempotent module-scope state.
import './scene/history';

function App() {
  useEffect(() => {
    // Set dark theme on html element
    document.documentElement.classList.add('dark');
  }, []);

  useEffect(() => {
    // Dogfood fix (Epic 04 stack-rows): suppress the native webview
    // context menu app-wide (canvas + all panels) — right-click is
    // reserved for future tool vocabulary, not the OS/webview default menu.
    const suppressContextMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('contextmenu', suppressContextMenu);
    return () => window.removeEventListener('contextmenu', suppressContextMenu);
  }, []);

  useEffect(() => installShortcuts(), []);
  useEffect(() => installMenu(), []);
  // The document lives in rhizome inside the Tauri app (Epic 21 story 1); idempotent, a no-op in the web build.
  // Once it is up, a file macOS launched the app with opens through the same path as Cmd+O.
  useEffect(() => installRhizome({ onLive: (r) => void attachDocumentOpening(r) }), []);
  // AI backend settings (Epic 17 story 1) — loaded once at startup so the
  // Settings dialog shows the persisted endpoint the first time it opens,
  // per acceptance ("enter an endpoint, restart the app: same value").
  useEffect(() => void loadAiSettings(), []);
  // Installed-font catalogue (Epic 20 story 1) — idempotent, so StrictMode re-runs are safe.
  useEffect(() => void useFontCatalogueStore.getState().load(), []);
  // Picker favourites and recents (font-picker-curation.md) — app-data JSON, loaded beside the catalogue.
  useEffect(() => void loadFontPreferences(), []);

  // Once per app, not per StrictMode re-run: window listeners have no
  // teardown API worth building for a singleton window.
  const windowIntegrationDone = useRef(false);
  useEffect(() => {
    if (windowIntegrationDone.current) return;
    windowIntegrationDone.current = true;
    installProjectWindowIntegration();
  }, []);

  return <Layout />;
}

export default App;
