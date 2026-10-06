//! The document host: the one open document as Tauri state, shaped like Shard's session so
//! that adopting app-kit later means implementing its `History` and `Document` traits on this
//! type, not rewriting it (guidance `21-rhizome/runs-on-rhizome.md`, Progress).
//!
//! It owns the shared `Arc<Pom<Oblique>>`. The transport's [`PomHost`] holds the same one, so
//! the `pom_*` commands the webview calls and Oblique's own Rust see one document.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};

use rhizome_pom::Pom;
use rhizome_pom_tauri::PomHost;

use super::Oblique;

type Hook = Box<dyn Fn() + Send + Sync>;

pub struct DocumentHost {
    pom: Arc<Pom<Oblique>>,
    /// Which "Untitled N" the document is, while it has no file. The first is 1.
    untitled_number: AtomicU32,
    /// Told after every change; the menu's Undo title and the window follow. Unset: nothing.
    changed: Arc<OnceLock<Hook>>,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "app-kit's History and Document use these (Epic 21, app-kit step)"
    )
)]
impl DocumentHost {
    /// Takes the document, attaches the change hook (`Pom::on_change` is a builder, so it
    /// must happen before the `Arc` is made), and returns this host with the transport's
    /// [`PomHost`] over the same document. Manage both.
    pub fn new(pom: Pom<Oblique>) -> (Self, PomHost) {
        let changed: Arc<OnceLock<Hook>> = Arc::default();
        let hook = changed.clone();
        // Runs with the document locked, on every commit (a drag frame included): it only
        // hands over to whoever set `on_change`, and that must not call back into the Pom.
        let pom = Arc::new(pom.on_change(move |_doc| {
            if let Some(f) = hook.get() {
                f();
            }
        }));
        let transport = PomHost::new(pom.clone());
        (
            Self {
                pom,
                untitled_number: AtomicU32::new(1),
                changed,
            },
            transport,
        )
    }

    /// The document, for Oblique's own Rust. Edits go through commands.
    pub fn pom(&self) -> &Arc<Pom<Oblique>> {
        &self.pom
    }

    /// Sets what is told after every change. Once; a second call is ignored.
    pub fn on_change(&self, f: impl Fn() + Send + Sync + 'static) {
        let _ = self.changed.set(Box::new(f));
    }

    /// The number of the untitled document now open.
    pub fn untitled_number(&self) -> u32 {
        self.untitled_number.load(Ordering::Relaxed)
    }

    /// A new untitled document replaces the open one: the next number, which it gets.
    pub fn next_untitled(&self) -> u32 {
        self.untitled_number.fetch_add(1, Ordering::Relaxed) + 1
    }
}
