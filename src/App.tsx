import { useEffect, useRef } from 'react';
import { loadAiSettings } from './ai/settings';
import { installProjectWindowIntegration } from './app/closeGuard';
import { Layout } from './app/Layout';
import { installMenu } from './app/menu';
import { installShortcuts } from './app/shortcuts';
import { useTextEditStore } from './canvas/text/textEditState';
import { useFontCatalogueStore } from './fonts/catalogue';
import { setTextStyleListener } from './panels/text/textScope';
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
  // AI backend settings (Epic 17 story 1) — loaded once at startup so the
  // Settings dialog shows the persisted endpoint the first time it opens,
  // per acceptance ("enter an endpoint, restart the app: same value").
  useEffect(() => void loadAiSettings(), []);
  // Installed-font catalogue (Epic 20 story 1) — idempotent, so StrictMode re-runs are safe.
  useEffect(() => void useFontCatalogueStore.getState().load(), []);

  // The text tool starts new text in the font/size last picked in the Text
  // inspector (Epic 20 story 4). panels/ can't import canvas/, so the app
  // shell connects the two.
  useEffect(() => {
    setTextStyleListener((patch) => useTextEditStore.getState().setLastUsed(patch));
    return () => setTextStyleListener(null);
  }, []);

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
