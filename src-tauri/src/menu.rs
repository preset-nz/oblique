//! Native macOS menu bar (roadmap gap "Native app menu + New command",
//! 2026-07-04): App submenu (About/Services/Hide/Quit — standard macOS
//! chrome), File (New/Open/Import/Save/Save As/Export PNG/Export Proof), Edit (Undo/Redo
//! plus the OS-level Cut/Copy/Paste/Select All text-editing predefined
//! items), View (Zoom In/Out, Fit in Window, Actual Size — view-menu-zoom.md;
//! Snap to Layers check item — snapping.md),
//! Layer (Bring Forward/Send Backward/Bring to Front/Send to Back —
//! drag-reorder.md; Replace Image… — image-source.md), Type.
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

use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Listener, Runtime};

/// Bug-report contact shown in the native About panel (macOS supports
/// `credits`, not `website`/`comments`) and the friends-build README.
/// Epic 14 (friends build) — free, pre-release, no support SLA implied.
const CONTACT_EMAIL: &str = "georg@preset.nz";

const EVT_APP_SETTINGS: &str = "menu://app/settings";
const EVT_FILE_NEW: &str = "menu://file/new";
const EVT_FILE_OPEN: &str = "menu://file/open";
const EVT_FILE_IMPORT: &str = "menu://file/import";
const EVT_FILE_SAVE: &str = "menu://file/save";
const EVT_FILE_SAVE_AS: &str = "menu://file/save-as";
const EVT_FILE_EXPORT_PNG: &str = "menu://file/export-png";
const EVT_FILE_EXPORT_PROOF: &str = "menu://file/export-proof";
const EVT_EDIT_UNDO: &str = "menu://edit/undo";
const EVT_EDIT_REDO: &str = "menu://edit/redo";
const EVT_EDIT_DUPLICATE: &str = "menu://edit/duplicate";
const EVT_VIEW_ZOOM_IN: &str = "menu://view/zoom-in";
const EVT_VIEW_ZOOM_OUT: &str = "menu://view/zoom-out";
const EVT_VIEW_FIT: &str = "menu://view/fit";
const EVT_VIEW_ACTUAL_SIZE: &str = "menu://view/actual-size";
/// Payload: `bool`, the item's new checked state (see the `view-snap-layers` arm below).
const EVT_VIEW_SNAP_LAYERS: &str = "menu://view/snap-to-layers";
const EVT_LAYER_FORWARD: &str = "menu://layer/forward";
const EVT_LAYER_BACKWARD: &str = "menu://layer/backward";
const EVT_LAYER_FRONT: &str = "menu://layer/front";
const EVT_LAYER_BACK: &str = "menu://layer/back";
const EVT_LAYER_REPLACE_IMAGE: &str = "menu://layer/replace-image";
/// Webview -> Rust (not a menu click): payload `bool`, whether Layer -> Replace
/// Image… should be enabled (a pixel node is selected). Sent through the
/// window's `emit` rather than an `invoke` so the frame-IPC dependency gate
/// stays untouched; Rust owns the item handle and flips it.
const EVT_LAYER_REPLACE_IMAGE_ENABLED: &str = "menu://layer/replace-image-enabled";
const EVT_TYPE_REPLACE_FONT: &str = "menu://type/replace-font";
const EVT_TYPE_CONVERT_OUTLINES: &str = "menu://type/convert-outlines";

/// Builds and installs the app menu bar, wiring menu-item activation to
/// webview events. Called once from `run`'s `.setup()`.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let pkg_name = app.package_info().name.clone();
    let pkg_version = app.package_info().version.to_string();

    let about_metadata = AboutMetadata {
        name: Some(pkg_name.clone()),
        version: Some(pkg_version),
        copyright: Some("Free, pre-release build — no warranty.".into()),
        credits: Some(format!("Bugs & feedback: {CONTACT_EMAIL}")),
        ..Default::default()
    };

    let app_settings =
        MenuItem::with_id(app, "app-settings", "Settings…", true, Some("CmdOrCtrl+,"))?;

    let app_submenu = Submenu::with_items(
        app,
        &pkg_name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &app_settings,
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
    let file_export_proof = MenuItem::with_id(
        app,
        "file-export-proof",
        "Export Proof…",
        true,
        Some("Alt+Shift+CmdOrCtrl+E"),
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
            &file_export_proof,
        ],
    )?;

    // Custom Undo/Redo (not PredefinedMenuItem::undo/redo, which target
    // NSResponder's text-field undo manager, not our scene-history store)
    // alongside the OS text-editing predefined items.
    let edit_undo = MenuItem::with_id(app, "edit-undo", "Undo", true, Some("CmdOrCtrl+Z"))?;
    let edit_redo = MenuItem::with_id(app, "edit-redo", "Redo", true, Some("Shift+CmdOrCtrl+Z"))?;

    let edit_duplicate = MenuItem::with_id(
        app,
        "edit-duplicate",
        "Duplicate",
        true,
        Some("CmdOrCtrl+D"),
    )?;

    let edit_submenu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &edit_undo,
            &edit_redo,
            &PredefinedMenuItem::separator(app)?,
            &edit_duplicate,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // View menu (view-menu-zoom.md): zoom commands. Cmd+= rather than
    // Cmd+Shift+= so Zoom In needs no Shift, as in every Mac editor.
    let view_zoom_in =
        MenuItem::with_id(app, "view-zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let view_zoom_out =
        MenuItem::with_id(app, "view-zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let view_fit = MenuItem::with_id(app, "view-fit", "Fit in Window", true, Some("CmdOrCtrl+0"))?;
    let view_actual =
        MenuItem::with_id(app, "view-actual", "Actual Size", true, Some("CmdOrCtrl+1"))?;
    // Snap to Layers (snapping.md): a check item, default on. muda toggles a
    // CheckMenuItem natively on click *before* emitting the menu event, so the
    // menu is the source of truth and the event below carries the new state.
    let view_snap_layers = CheckMenuItem::with_id(
        app,
        "view-snap-layers",
        "Snap to Layers",
        true,
        true,
        Some("CmdOrCtrl+;"),
    )?;

    let view_submenu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &view_zoom_in,
            &view_zoom_out,
            &PredefinedMenuItem::separator(app)?,
            &view_fit,
            &view_actual,
            &PredefinedMenuItem::separator(app)?,
            &view_snap_layers,
        ],
    )?;

    // Layer menu (drag-reorder.md): stacking order of the selected node, the
    // keyboard path for the layer-row drag grip. Photoshop/Figma chords: Cmd+]
    // forward, Cmd+[ backward, +Shift to the ends.
    let layer_forward = MenuItem::with_id(
        app,
        "layer-forward",
        "Bring Forward",
        true,
        Some("CmdOrCtrl+]"),
    )?;
    let layer_backward = MenuItem::with_id(
        app,
        "layer-backward",
        "Send Backward",
        true,
        Some("CmdOrCtrl+["),
    )?;
    let layer_front = MenuItem::with_id(
        app,
        "layer-front",
        "Bring to Front",
        true,
        Some("Shift+CmdOrCtrl+]"),
    )?;
    let layer_back = MenuItem::with_id(
        app,
        "layer-back",
        "Send to Back",
        true,
        Some("Shift+CmdOrCtrl+["),
    )?;

    // Replace Image… (image-source.md, no accelerator — an infrequent action):
    // enabled only while a pixel node is selected, so it starts disabled and the
    // webview tells us when that changes (listener below).
    let layer_replace_image = MenuItem::with_id(
        app,
        "layer-replace-image",
        "Replace Image…",
        false,
        None::<&str>,
    )?;

    let layer_replace_image_enabled = layer_replace_image.clone();

    let layer_submenu = Submenu::with_items(
        app,
        "Layer",
        true,
        &[
            &layer_forward,
            &layer_backward,
            &PredefinedMenuItem::separator(app)?,
            &layer_front,
            &layer_back,
            &PredefinedMenuItem::separator(app)?,
            &layer_replace_image,
        ],
    )?;

    // Type menu (Epic 20): Replace Font… (story 6, no accelerator) and Convert to
    // Outlines (story 7, InDesign's Shift+Cmd+O).
    let type_replace_font = MenuItem::with_id(
        app,
        "type-replace-font",
        "Replace Font…",
        true,
        None::<&str>,
    )?;
    let type_convert_outlines = MenuItem::with_id(
        app,
        "type-convert-outlines",
        "Convert to Outlines",
        true,
        Some("Shift+CmdOrCtrl+O"),
    )?;
    let type_submenu = Submenu::with_items(
        app,
        "Type",
        true,
        &[&type_replace_font, &type_convert_outlines],
    )?;

    let menu = Menu::with_items(
        app,
        &[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &layer_submenu,
            &type_submenu,
        ],
    )?;
    app.set_menu(menu)?;

    app.listen_any(EVT_LAYER_REPLACE_IMAGE_ENABLED, move |event| {
        if let Ok(enabled) = serde_json::from_str::<bool>(event.payload()) {
            let _ = layer_replace_image_enabled.set_enabled(enabled);
        }
    });

    app.on_menu_event(move |app_handle, event| {
        let evt = match event.id().0.as_str() {
            "app-settings" => EVT_APP_SETTINGS,
            "file-new" => EVT_FILE_NEW,
            "file-open" => EVT_FILE_OPEN,
            "file-import" => EVT_FILE_IMPORT,
            "file-save" => EVT_FILE_SAVE,
            "file-save-as" => EVT_FILE_SAVE_AS,
            "file-export-png" => EVT_FILE_EXPORT_PNG,
            "file-export-proof" => EVT_FILE_EXPORT_PROOF,
            "edit-undo" => EVT_EDIT_UNDO,
            "edit-redo" => EVT_EDIT_REDO,
            "edit-duplicate" => EVT_EDIT_DUPLICATE,
            "view-zoom-in" => EVT_VIEW_ZOOM_IN,
            "view-zoom-out" => EVT_VIEW_ZOOM_OUT,
            "view-fit" => EVT_VIEW_FIT,
            "view-actual" => EVT_VIEW_ACTUAL_SIZE,
            "view-snap-layers" => {
                // Already toggled by muda; the webview mirrors this state.
                let checked = view_snap_layers.is_checked().unwrap_or(true);
                let _ = app_handle.emit(EVT_VIEW_SNAP_LAYERS, checked);
                return;
            }
            "layer-forward" => EVT_LAYER_FORWARD,
            "layer-backward" => EVT_LAYER_BACKWARD,
            "layer-front" => EVT_LAYER_FRONT,
            "layer-back" => EVT_LAYER_BACK,
            "layer-replace-image" => EVT_LAYER_REPLACE_IMAGE,
            "type-replace-font" => EVT_TYPE_REPLACE_FONT,
            "type-convert-outlines" => EVT_TYPE_CONVERT_OUTLINES,
            _ => return,
        };
        let _ = app_handle.emit(evt, ());
    });

    Ok(())
}
