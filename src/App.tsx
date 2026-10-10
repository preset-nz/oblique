import { useDocumentNotes } from '@preset.nz/app-kit/core';
import { notify } from '@preset.nz/ux-kit';
import { useEffect } from 'react';
import { loadAiSettings } from './ai/settings';
import { Layout } from './app/Layout';
import { useMenuCommands } from './app/menu';
import { installShortcuts } from './app/shortcuts';
import { useFontCatalogueStore } from './fonts/catalogue';
import { loadFontPreferences } from './fonts/preferences';
import { projectDocumentEvents } from './project/io';
import { installRhizome } from './rhizome/rhizome';
// Side-effecting import: wires up the app-wide cook scheduler singleton
// (store subscriptions + debounce/idle timers) the first time this module
// loads. Safe to import more than once — it's a singleton.
import './cook/singleton';

/**
 * The native menu bar is app-kit's (Epic 22 slice b): this binds each command id to what it
 * does, keeps Undo and Redo titled from the document host's history, and routes Cmd+Z in a text
 * field. A component of its own, rendering nothing, because those hooks re-render on every
 * history, selection and text-focus change (every drag frame, for the history): they must not
 * take the whole layout with them.
 */
function NativeMenu() {
  useMenuCommands();
  // A last document that wouldn't reopen at launch, or a held file that failed to open: app-kit
  // hands over a sentence, shown as a passing message, never a dialog.
  useDocumentNotes((message) => notify({ message }));
  return null;
}

function App() {
  useEffect(() => {
    // Set dark theme on html element
    document.documentElement.classList.add('dark');
  }, []);

  useEffect(() => installShortcuts(), []);
  // The document lives in rhizome inside the Tauri app (Epic 21 story 1); idempotent. Opening and
  // saving are app-kit's, in Rust; `projectDocumentEvents` is the project's side of both,
  // including a file held until the host is up (relaunch restore, a cold Finder open).
  useEffect(() => installRhizome({ events: projectDocumentEvents() }), []);
  // AI backend settings (Epic 17 story 1) — loaded once at startup so the
  // Settings dialog shows the persisted endpoint the first time it opens,
  // per acceptance ("enter an endpoint, restart the app: same value").
  useEffect(() => void loadAiSettings(), []);
  // Installed-font catalogue (Epic 20 story 1) — idempotent, so StrictMode re-runs are safe.
  useEffect(() => void useFontCatalogueStore.getState().load(), []);
  // Picker favourites and recents (font-picker-curation.md) — app-data JSON, loaded beside the catalogue.
  useEffect(() => void loadFontPreferences(), []);

  return (
    <>
      <Layout />
      <NativeMenu />
    </>
  );
}

export default App;
