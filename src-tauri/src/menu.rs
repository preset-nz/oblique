//! Native macOS menu bar (roadmap gap "Native app menu + New command",
//! 2026-07-04): App submenu (About/Services/Hide/Quit — standard macOS
//! chrome), File (New/Open/Import/Save/Save As/Export PNG), Edit (Undo/Redo
//! plus the OS-level Cut/Copy/Paste/Select All text-editing predefined
//! items).
//!
//! Open (Cmd+O) vs Import (Cmd+I) (roadmap "Cmd+O is overloaded — split
//! Open vs Import", 2026-07-05): genuinely different flows, not one dialog
//! routed by extension. Open replaces the whole project (`.oblique` only);
//! Import adds image node(s) to the current project and never touches the
//! project file.
//!
//! Rust stays plumbing per architecture.md: build the menu, forward menu
//! events to the webview as plain events. All the actual behaviour (new
//! project, open dialog, save, undo/redo…) lives in TypeScript and is
//! reused unchanged from `src/app/shortcuts.ts`'s handlers via
//! `src/app/menu.ts`.
//!
//! Edit→Copy/Paste of *app* content (nodes/modifiers/pixels) is explicitly
//! out of scope (roadmap: needs a clipboard design decision first). The
//! `PredefinedMenuItem::{cut,copy,paste,select_all}` items below are the
//! OS text-editing commands for the focused responder (e.g. a layer-name
//! text field) — orthogonal to that deferred feature, and required so
//! replacing Tauri's `Menu::default()` doesn't regress Cmd+C/V/X/A in
//! ordinary text inputs.
//!
//! Double-firing note (also see `shortcuts.ts`): on macOS, a menu item's
//! accelerator is a native key equivalent handled by `NSMenu` /
//! `performKeyEquivalent:` before the key event reaches the WKWebView, so
//! the accelerator is consumed here and the webview's `keydown` listener
//! never sees it. This is the standard mainstream behaviour (and matches
//! "native menu is the source of truth" for the shortcuts it owns) but
//! could not be exercised headlessly in this environment — verify with a
//! real click/keypress test (see report).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

const EVT_FILE_NEW: &str = "menu://file/new";
const EVT_FILE_OPEN: &str = "menu://file/open";
const EVT_FILE_IMPORT: &str = "menu://file/import";
const EVT_FILE_SAVE: &str = "menu://file/save";
const EVT_FILE_SAVE_AS: &str = "menu://file/save-as";
const EVT_FILE_EXPORT_PNG: &str = "menu://file/export-png";
const EVT_EDIT_UNDO: &str = "menu://edit/undo";
const EVT_EDIT_REDO: &str = "menu://edit/redo";

/// Builds and installs the app menu bar, wiring menu-item activation to
/// webview events. Called once from `run`'s `.setup()`.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let pkg_name = app.package_info().name.clone();

    let app_submenu = Submenu::with_items(
        app,
        &pkg_name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_new = MenuItem::with_id(app, "file-new", "New", true, Some("CmdOrCtrl+N"))?;
    let file_open = MenuItem::with_id(app, "file-open", "Open…", true, Some("CmdOrCtrl+O"))?;
    let file_import = MenuItem::with_id(app, "file-import", "Import…", true, Some("CmdOrCtrl+I"))?;
    let file_save = MenuItem::with_id(app, "file-save", "Save", true, Some("CmdOrCtrl+S"))?;
    let file_save_as = MenuItem::with_id(
        app,
        "file-save-as",
        "Save As…",
        true,
        Some("Shift+CmdOrCtrl+S"),
    )?;
    let file_export_png = MenuItem::with_id(
        app,
        "file-export-png",
        "Export PNG…",
        true,
        Some("Shift+CmdOrCtrl+E"),
    )?;

    let file_submenu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &file_new,
            &file_open,
            &file_import,
            &PredefinedMenuItem::separator(app)?,
            &file_save,
            &file_save_as,
            &PredefinedMenuItem::separator(app)?,
            &file_export_png,
        ],
    )?;

    // Custom Undo/Redo (not PredefinedMenuItem::undo/redo, which target
    // NSResponder's text-field undo manager, not our scene-history store)
    // alongside the OS text-editing predefined items.
    let edit_undo = MenuItem::with_id(app, "edit-undo", "Undo", true, Some("CmdOrCtrl+Z"))?;
    let edit_redo = MenuItem::with_id(
        app,
        "edit-redo",
        "Redo",
        true,
        Some("Shift+CmdOrCtrl+Z"),
    )?;

    let edit_submenu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &edit_undo,
            &edit_redo,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_submenu, &file_submenu, &edit_submenu])?;
    app.set_menu(menu)?;

    app.on_menu_event(|app_handle, event| {
        let evt = match event.id().0.as_str() {
            "file-new" => EVT_FILE_NEW,
            "file-open" => EVT_FILE_OPEN,
            "file-import" => EVT_FILE_IMPORT,
            "file-save" => EVT_FILE_SAVE,
            "file-save-as" => EVT_FILE_SAVE_AS,
            "file-export-png" => EVT_FILE_EXPORT_PNG,
            "edit-undo" => EVT_EDIT_UNDO,
            "edit-redo" => EVT_EDIT_REDO,
            _ => return,
        };
        let _ = app_handle.emit(evt, ());
    });

    Ok(())
}
