//! The document host: the one open document as Tauri state, and app-kit's `History` and
//! `Document` for it (Epic 22, slice a). Edit > Undo and Redo, File > New, Open, Save, the
//! unsaved mark and the close guard all run against this type once app-kit is installed on it.
//!
//! **It exists from launch; the document does not.** app-kit finds the host with
//! `app.state::<DocumentHost>()` at `RunEvent::Ready`, on a Finder open and on every menu
//! command, and Tauri panics on unmanaged state. The [`Pom`] can't be made until the sidecar's
//! op catalogue arrives, because the catalogue defines the modifier kinds (rhizome decision
//! 52), and Rust never fetches it (architecture.md). So the `Pom` sits behind a `OnceLock`
//! that [`DocumentHost::init`] fills:
//!
//! - Before init the document reads as `Untitled-1`, saved, with nothing to undo or redo.
//! - An `open` asked for before init (restore, Finder) is held; [`DocumentHost::apply_held`]
//!   applies it after init, and it emits as any open does. A second held path replaces the
//!   first, since the newer request is the one the person meant.
//! - `save` and `new_document` before init answer an error ([`NOT_READY`]).
//!
//! The host owns the shared `Arc<Pom<Oblique>>`; the transport's [`PomHost`] holds the same
//! one, so the `pom_*` commands the webview calls and Oblique's own Rust see one document.
//!
//! **Events.** Whatever replaces or steps the document under the webview says so, because the
//! webview's scene is a projection it must rebuild:
//!
//! - rhizome's own `pom://commit` / `pom://status`, through `rhizome_pom_tauri::emit`, for
//!   every call that changes the document: the webview's mirror needs them to stay current.
//! - [`HISTORY_STEPPED`] after an undo or redo that changed something, after the commit
//!   events: `{undid, label}` ([`Stepped`]), `label` being the step's own name ("Move").
//! - [`DOCUMENT_OPENED`] after open and new, after the status events: `{issues}`
//!   ([`DocumentOpened`]), what the load could not take as written.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use preset_app_kit::{Document, History};
use rhizome_pom::{Error, Host, Issue, Pom, Ran};
use rhizome_pom_tauri::{emit, PomHost};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Runtime};

use super::Oblique;

/// An undo or redo changed the document; the payload is a [`Stepped`].
pub const HISTORY_STEPPED: &str = "history-stepped";
/// The document was replaced by a file or a new one; the payload is a [`DocumentOpened`].
pub const DOCUMENT_OPENED: &str = "document-opened";

/// What save and new answer before the op catalogue has arrived.
pub const NOT_READY: &str = "The document isn't ready yet.";

/// What an undo or redo did.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Stepped {
    pub undid: bool,
    /// The step's own name, without "Undo " or "Redo ".
    pub label: String,
}

/// A file or a new document replaced the open one.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct DocumentOpened {
    /// What the load couldn't take as written; the document opened anyway. Empty for new.
    pub issues: Vec<Issue>,
}

type Hook = Box<dyn Fn() + Send + Sync>;

pub struct DocumentHost {
    /// Set once, when the op catalogue is in.
    pom: OnceLock<Arc<Pom<Oblique>>>,
    /// An `open` asked for before the `Pom` existed. Checked and filled together with `pom`
    /// (see `init` and `open`): a path must not fall between the two.
    held: Mutex<Option<PathBuf>>,
    /// Which "Untitled N" the document is, while it has no file. app-kit counts and tells us;
    /// the first is 1.
    untitled_number: AtomicU32,
    /// Told after every change, under the document's lock. Unset: nothing.
    changed: Arc<OnceLock<Hook>>,
}

impl Default for DocumentHost {
    fn default() -> Self {
        Self::new()
    }
}

impl DocumentHost {
    /// A host with no document yet. Manage it at launch.
    pub fn new() -> Self {
        Self {
            pom: OnceLock::new(),
            held: Mutex::new(None),
            untitled_number: AtomicU32::new(1),
            changed: Arc::default(),
        }
    }

    /// Whether the document exists (the op catalogue has arrived).
    pub fn is_ready(&self) -> bool {
        self.pom.get().is_some()
    }

    /// Takes the document, attaches the change hook (`Pom::on_change` is a builder, so it must
    /// happen before the `Arc` is made), and returns the transport's [`PomHost`] over the same
    /// document, to manage. `None` if the host already has its document (a reloaded webview
    /// asking again): the argument is dropped.
    ///
    /// A path held by `open` is not applied here: call [`apply_held`](Self::apply_held) once
    /// the [`PomHost`] is managed, because applying it emits.
    pub fn init(&self, pom: Pom<Oblique>) -> Option<PomHost> {
        let hook = self.changed.clone();
        // Runs with the document locked, on every commit (a drag frame included): it only
        // hands over to whoever set `on_change`, and that must not call back into the Pom.
        let pom = Arc::new(pom.on_change(move |_doc| {
            if let Some(f) = hook.get() {
                f();
            }
        }));
        let transport = PomHost::new(pom.clone());
        // Under `held`'s lock, so an `open` either sees the Pom or leaves its path for
        // `apply_held`.
        let _held = self.held.lock().expect("document host poisoned");
        self.pom.set(pom).ok()?;
        Some(transport)
    }

    /// Opens the path an `open` held before init, if there is one: `Ok(true)` when it did.
    /// Emits as any open does. Call after [`init`](Self::init) and after managing its
    /// [`PomHost`]. A path that fails to open leaves the document as it was (untitled).
    pub fn apply_held<R: Runtime>(&self, app: &AppHandle<R>) -> Result<bool, String> {
        let held = self.held.lock().expect("document host poisoned").take();
        match held {
            Some(path) => self.open(app, &path).map(|()| true),
            None => Ok(false),
        }
    }

    /// Sets what is told after every change. Once; a second call is ignored. Runs under the
    /// document's lock: it must not touch the `Pom`.
    pub fn on_change(&self, f: impl Fn() + Send + Sync + 'static) {
        let _ = self.changed.set(Box::new(f));
    }

    /// After every change, re-reads the history for app-kit's menu and window title
    /// (`preset_app_kit::refresh_history`), on the main thread.
    ///
    /// The change hook runs with the document locked, and `refresh_history` reads it, so it
    /// is only ever scheduled, never called. `run_on_main_thread` runs its closure *inline*
    /// when already on the main thread (tauri-runtime-wry's `send_user_message`), and a sync
    /// command or a menu undo is on the main thread: that would lock the `Pom` again from
    /// inside its own lock. So the request is sent from a short-lived thread, which always
    /// queues. A burst of drag ticks coalesces into one refresh.
    ///
    /// Until app-kit is installed `refresh_history` finds no state and does nothing.
    pub fn refresh_on_change<R: Runtime>(&self, app: AppHandle<R>) {
        let pending = Arc::new(AtomicBool::new(false));
        self.on_change(move || {
            if pending.swap(true, Ordering::SeqCst) {
                return;
            }
            let (app, pending) = (app.clone(), pending.clone());
            std::thread::spawn(move || {
                let inner = app.clone();
                let sent = app.run_on_main_thread(move || {
                    pending.store(false, Ordering::SeqCst);
                    preset_app_kit::refresh_history(&inner);
                });
                // The loop is gone (quitting): nothing will run it, and nothing needs to.
                let _ = sent;
            });
        });
    }

    /// Runs `edit.undo` or `edit.redo` through the host, so the commit reaches the webview's
    /// mirror, then says it was stepped. Nothing to step (or no document yet) is not an error.
    fn step<R: Runtime>(&self, app: &AppHandle<R>, undid: bool) -> Result<(), String> {
        let Some(pom) = self.pom.get() else {
            return Ok(());
        };
        let (id, prefix) = if undid {
            ("edit.undo", "Undo ")
        } else {
            ("edit.redo", "Redo ")
        };
        match pom.run(id, &json!({}), None) {
            Ok((ran, events)) => {
                emit(app, events);
                if let Ran::Committed(c) = ran {
                    let label = c.label.strip_prefix(prefix).unwrap_or(&c.label).to_string();
                    let _ = app.emit(HISTORY_STEPPED, Stepped { undid, label });
                }
                Ok(())
            }
            // nothing to step, or a gesture is open (a drag in progress)
            Err(Error::Disabled(_)) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn replaced<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        events: Vec<rhizome_pom::Event>,
        opened: DocumentOpened,
    ) {
        emit(app, events);
        let _ = app.emit(DOCUMENT_OPENED, opened);
    }
}

impl History for DocumentHost {
    // What `Status` reports is what app-kit shows: it is `None` while a gesture is open, so
    // Undo greys out during a drag. app-kit adds the verb.
    fn undo_label(&self) -> Option<String> {
        self.pom.get().and_then(|p| p.status().undo)
    }

    fn redo_label(&self) -> Option<String> {
        self.pom.get().and_then(|p| p.status().redo)
    }

    fn undo_labels(&self) -> Vec<String> {
        self.pom.get().map_or_else(Vec::new, |p| {
            p.read(|d| d.tree().undo_labels().map(String::from).collect())
        })
    }

    fn redo_labels(&self) -> Vec<String> {
        self.pom.get().map_or_else(Vec::new, |p| {
            p.read(|d| d.tree().redo_labels().map(String::from).collect())
        })
    }

    fn undo<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        self.step(app, true)
    }

    fn redo<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        self.step(app, false)
    }
}

impl Document for DocumentHost {
    /// Derived from the tree (`Tree::is_unsaved`), so undoing back to the saved state clears it.
    fn is_unsaved(&self) -> bool {
        self.pom.get().is_some_and(|p| p.status().unsaved)
    }

    fn path(&self) -> Option<PathBuf> {
        self.pom
            .get()
            .and_then(|p| p.read(|d| d.path().map(Path::to_path_buf)))
    }

    fn untitled_number(&self) -> u32 {
        self.untitled_number.load(Ordering::Relaxed)
    }

    fn save<R: Runtime>(&self, app: &AppHandle<R>, path: &Path) -> Result<(), String> {
        let pom = self.pom.get().ok_or(NOT_READY)?;
        emit(app, pom.save_as(path).map_err(|e| e.to_string())?);
        Ok(())
    }

    /// Before init the path is held, and this is `Ok`: it opens once the catalogue is in.
    fn open<R: Runtime>(&self, app: &AppHandle<R>, path: &Path) -> Result<(), String> {
        let pom = {
            let mut held = self.held.lock().expect("document host poisoned");
            match self.pom.get() {
                Some(pom) => pom,
                None => {
                    *held = Some(path.to_path_buf());
                    return Ok(());
                }
            }
        };
        let (issues, events) = pom.open(path).map_err(|e| e.to_string())?;
        self.replaced(app, events, DocumentOpened { issues });
        Ok(())
    }

    fn new_document<R: Runtime>(&self, app: &AppHandle<R>, untitled: u32) -> Result<(), String> {
        let pom = self.pom.get().ok_or(NOT_READY)?;
        // before the swap, so the window title the change schedules is already Untitled-N
        let before = self.untitled_number.swap(untitled, Ordering::Relaxed);
        match pom.new_document() {
            Ok(events) => {
                self.replaced(app, events, DocumentOpened::default());
                Ok(())
            }
            Err(e) => {
                self.untitled_number.store(before, Ordering::Relaxed);
                Err(e.to_string())
            }
        }
    }
}
