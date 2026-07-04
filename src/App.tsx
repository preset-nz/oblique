import { useEffect, useRef } from 'react';
import { installProjectWindowIntegration } from './app/closeGuard';
import { Layout } from './app/Layout';
import { installShortcuts } from './app/shortcuts';
// Side-effecting import: wires up the app-wide cook scheduler singleton
// (store subscriptions + debounce/idle timers) the first time this module
// loads. Safe to import more than once — it's a singleton.
import './cook/singleton';

function App() {
  useEffect(() => {
    // Set dark theme on html element
    document.documentElement.classList.add('dark');
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
