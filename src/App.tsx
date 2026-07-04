import { useEffect, useRef } from 'react';
import { installProjectWindowIntegration } from './app/closeGuard';
import { Layout } from './app/Layout';
import { installShortcuts } from './app/shortcuts';
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
