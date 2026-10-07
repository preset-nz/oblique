//! Oblique's own commands, for app-kit's command table (Epic 22, slice b).
//!
//! app-kit builds the menu bar around them: the App menu with Settings…, Undo and Redo named
//! after what they would do (from the document host's history), Cut, Copy, Paste, the Window
//! menu. Every activation reaches the webview as app-kit's `command` event carrying the id,
//! and what each command does lives in TypeScript (`src/app/menu.ts`), in the same functions
//! the keyboard paths call. Rust stays plumbing (architecture.md).
//!
//! **A menu accelerator is consumed by `NSMenu` before the key reaches the webview,** so a
//! command's chord is written here and nowhere else (`SHORTCUTS`), and held unique by a test.
//!
//! **File.** New, Open…, Save and Save As… are still Oblique's own commands on their old ids,
//! because app-kit's versions need a `Document` installed (`AppKit::install`), which also brings
//! the close guard, relaunch restore and Finder opens: that is slice c. Until then
//! `menu.toml` turns app-kit's File slots off and the webview flows behind these ids are
//! unchanged.
//!
//! **Open vs Import.** Open replaces the whole project (`.oblique` only); Import adds image
//! nodes to the current one and never touches the project file.

use preset_app_kit::{shortcut, Command, MenuName};

/// app-kit's switches for its built-in items: every document slot off until slice c.
pub const MENU_CONFIG: &str = include_str!("../menu.toml");

/// Every accelerator Oblique binds, by command id: written here and nowhere else, in one
/// canonical order (`CmdOrCtrl`, `Ctrl`, `Alt`, `Shift`, then the key), and held unique by a
/// test against what app-kit and macOS bind themselves.
pub const SHORTCUTS: &[(&str, &str)] = &[
    ("file-new", "CmdOrCtrl+N"),
    ("file-open", "CmdOrCtrl+O"),
    ("file-import", shortcut::IMPORT),
    ("file-save", "CmdOrCtrl+S"),
    ("file-save-as", "CmdOrCtrl+Shift+S"),
    ("file-export-png", "CmdOrCtrl+Shift+E"),
    ("file-export-proof", "CmdOrCtrl+Alt+Shift+E"),
    ("edit-duplicate", "CmdOrCtrl+D"),
    // View > Zoom (view-menu-zoom.md): Cmd+= rather than Cmd+Shift+= so Zoom In needs no Shift.
    ("view-zoom-in", shortcut::ZOOM_IN),
    ("view-zoom-out", shortcut::ZOOM_OUT),
    // The family reserves Cmd+0 for zoom; here it fits the canvas, Cmd+1 is 100%.
    ("view-fit", "CmdOrCtrl+0"),
    ("view-actual", "CmdOrCtrl+1"),
    ("view-snap-layers", "CmdOrCtrl+;"),
    // Layer order (drag-reorder.md). `Cmd+[` and `Cmd+]` mean Back and Forward in the family's
    // menu standard (decision 3); Oblique keeps them for now, as the slice asks.
    ("layer-forward", "CmdOrCtrl+]"),
    ("layer-backward", "CmdOrCtrl+["),
    ("layer-front", "CmdOrCtrl+Shift+]"),
    ("layer-back", "CmdOrCtrl+Shift+["),
    // InDesign's chord (Epic 20 story 7).
    ("type-convert-outlines", "CmdOrCtrl+Shift+O"),
];

/// A command with its accelerator from `SHORTCUTS`, if it has one.
fn item(id: &str, label: &str) -> Command {
    let c = Command::item(id, label);
    match SHORTCUTS.iter().find(|(i, _)| *i == id) {
        Some((_, accelerator)) => c.accelerator(accelerator),
        None => c,
    }
}

/// View > Snap to Layers (snapping.md): a check item, on to start with. The webview's store
/// mirrors it, and the menu is told its state back (`useMenuSync`).
fn toggle(id: &str, label: &str) -> Command {
    let c = Command::toggle(id, label);
    match SHORTCUTS.iter().find(|(i, _)| *i == id) {
        Some((_, accelerator)) => c.accelerator(accelerator),
        None => c,
    }
}

/// Every command Oblique adds to app-kit's, in menu order.
pub fn commands() -> Vec<Command> {
    let file = |id, label, section| item(id, label).menu(MenuName::File).section(section);
    let view = |id, label, section| item(id, label).menu(MenuName::View).section(section);
    let layer = |id, label, section| item(id, label).domain("Layer").section(section);
    let text = |id, label| item(id, label).domain("Type").section(0);
    vec![
        file("file-new", "New", 0),
        file("file-open", "Open…", 0),
        file("file-import", "Import…", 0),
        file("file-save", "Save", 1),
        file("file-save-as", "Save As…", 1),
        file("file-export-png", "Export PNG…", 2),
        file("file-export-proof", "Export Proof…", 2),
        // After Undo and Redo, before Cut, Copy and Paste.
        item("edit-duplicate", "Duplicate")
            .menu(MenuName::Edit)
            .section(1),
        view("view-zoom-in", "Zoom In", 0),
        view("view-zoom-out", "Zoom Out", 0),
        view("view-fit", "Fit in Window", 1),
        view("view-actual", "Actual Size", 1),
        toggle("view-snap-layers", "Snap to Layers")
            .menu(MenuName::View)
            .section(2),
        layer("layer-forward", "Bring Forward", 0),
        layer("layer-backward", "Send Backward", 0),
        layer("layer-front", "Bring to Front", 1),
        layer("layer-back", "Send to Back", 1),
        // Image-source.md: an infrequent action, no accelerator. Enabled only while an
        // unlocked image layer is selected; the webview says when (`useMenuSync`).
        layer("layer-replace-image", "Replace Image…", 2).disabled(),
        // Epic 20: Replace Font… (story 6) and Convert to Outlines (story 7).
        text("type-replace-font", "Replace Font…"),
        text("type-convert-outlines", "Convert to Outlines"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_menu_config_parses_and_leaves_no_document_slot_on() {
        let config = preset_app_kit::MenuConfig::parse(MENU_CONFIG).expect("menu.toml is valid");
        // `install_history` refuses a config with any of these on; slice c installs the
        // document and turns them back on.
        assert!(config.file.document_slots_on().is_empty());
        assert!(config.app.settings);
    }

    /// A chord with its modifiers in one order and `Option` spelt `Alt`, so two spellings of the
    /// same chord compare equal.
    fn canonical(chord: &str) -> String {
        let mut parts: Vec<String> = chord
            .split('+')
            .map(|p| match p {
                "Option" | "Opt" => "Alt".to_string(),
                "Cmd" | "Command" | "Super" => "CmdOrCtrl".to_string(),
                other => other.to_string(),
            })
            .collect();
        let key = parts.pop().expect("a chord has a key");
        let rank = |m: &str| {
            ["CmdOrCtrl", "Ctrl", "Alt", "Shift"]
                .iter()
                .position(|x| *x == m)
        };
        parts.sort_by_key(|m| rank(m).unwrap_or(usize::MAX));
        parts.push(key);
        parts.join("+")
    }

    #[test]
    fn a_chord_is_the_same_whatever_order_it_is_written_in() {
        assert_eq!(canonical("Alt+Shift+CmdOrCtrl+E"), "CmdOrCtrl+Alt+Shift+E");
        assert_eq!(
            canonical("Shift+CmdOrCtrl+S"),
            canonical("CmdOrCtrl+Shift+S")
        );
        assert_eq!(
            canonical("CmdOrCtrl+Option+P"),
            canonical("CmdOrCtrl+Alt+P")
        );
    }

    /// What app-kit and macOS bind in the menu bar before Oblique adds anything: Undo, Redo,
    /// Settings…, Quit, Hide, Hide Others, Minimise, Close Window (File > Close is off, so
    /// Window carries it), Full Screen, Cut, Copy, Paste and Select All.
    const BUILT_IN: [&str; 13] = [
        "CmdOrCtrl+Z",
        "CmdOrCtrl+Shift+Z",
        "CmdOrCtrl+,",
        "CmdOrCtrl+Q",
        "CmdOrCtrl+H",
        "CmdOrCtrl+Alt+H",
        "CmdOrCtrl+M",
        "CmdOrCtrl+W",
        "CmdOrCtrl+Ctrl+F",
        "CmdOrCtrl+X",
        "CmdOrCtrl+C",
        "CmdOrCtrl+V",
        "CmdOrCtrl+A",
    ];

    #[test]
    fn no_two_commands_share_an_accelerator_or_an_id() {
        let table = commands();
        let ids: Vec<&str> = table.iter().map(|c| c.id()).collect();
        for (n, id) in ids.iter().enumerate() {
            assert!(!ids[n + 1..].contains(id), "{id} twice");
        }
        let mut taken: Vec<String> = BUILT_IN.iter().map(|c| canonical(c)).collect();
        for (id, accelerator) in SHORTCUTS {
            assert!(ids.contains(id), "{id} has a shortcut but no command");
            let chord = canonical(accelerator);
            assert!(
                !taken.contains(&chord),
                "{id} takes {accelerator}, which is taken"
            );
            taken.push(chord);
        }
    }

    #[test]
    fn import_is_shift_cmd_i_and_cmd_i_is_free() {
        let import = SHORTCUTS.iter().find(|(id, _)| *id == "file-import");
        assert_eq!(import.map(|(_, a)| *a), Some("CmdOrCtrl+Shift+I"));
        assert!(SHORTCUTS.iter().all(|(_, a)| canonical(a) != "CmdOrCtrl+I"));
    }

    #[test]
    fn every_old_id_is_still_on_the_table() {
        let table = commands();
        let ids: Vec<&str> = table.iter().map(|c| c.id()).collect();
        for id in [
            "file-new",
            "file-open",
            "file-import",
            "file-save",
            "file-save-as",
            "file-export-png",
            "file-export-proof",
            "edit-duplicate",
            "view-zoom-in",
            "view-zoom-out",
            "view-fit",
            "view-actual",
            "view-snap-layers",
            "layer-forward",
            "layer-backward",
            "layer-front",
            "layer-back",
            "layer-replace-image",
            "type-replace-font",
            "type-convert-outlines",
        ] {
            assert!(ids.contains(&id), "{id} is gone");
        }
    }
}
