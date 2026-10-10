mod document;
mod fonts;
mod menu;
mod sidecar;
mod text;
mod text_cmd;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .manage(sidecar::SidecarState::default())
        // The close guard: an unsaved document asks before the window goes (app-kit's).
        .on_window_event(preset_app_kit::on_window_event)
        .invoke_handler(tauri::generate_handler![
            greet,
            fonts::list_fonts,
            text_cmd::text_outlines,
            sidecar::sidecar_send,
            sidecar::sidecar_subscribe,
            document::document_init,
            document::document_log,
            rhizome_pom_tauri::commands::pom_status,
            rhizome_pom_tauri::commands::pom_view,
            rhizome_pom_tauri::commands::pom_commands,
            rhizome_pom_tauri::commands::pom_run,
            rhizome_pom_tauri::commands::pom_begin,
            rhizome_pom_tauri::commands::pom_end,
            rhizome_pom_tauri::commands::pom_cancel,
            // Not `pom_new`, `pom_open` or `pom_save_as`: app-kit replaces and saves the
            // document, and the webview hears of it through `document-opened` and
            // `document-saved`. A replacement made any other way would reach it unannounced.
            rhizome_pom_tauri::commands::pom_connect,
            preset_app_kit::app_kit_commands,
            preset_app_kit::app_kit_menu_state,
            preset_app_kit::app_kit_document,
            preset_app_kit::app_kit_document_note,
            preset_app_kit::app_kit_history,
            preset_app_kit::app_kit_undo,
            preset_app_kit::app_kit_redo,
            preset_app_kit::app_kit_text_menu
        ])
        .setup(|app| {
            use tauri::Manager;
            // The host exists from launch (app-kit finds it with `app.state`); its document
            // arrives with `document_init`, once the sidecar's op catalogue is in.
            let document = document::DocumentHost::new();
            document.refresh_on_change(app.handle().clone());
            app.manage(document);
            sidecar::start(app.handle().clone());
            // The menu bar, File, the close guard, relaunch restore and Finder opens are
            // app-kit's, with Oblique's commands on its table (`menu.rs`). `install` brings
            // the dialog plugin, so there is none above. Installing after the host is managed
            // matters: app-kit reads its document straight away. The host has no `Pom` yet;
            // an open asked for before the catalogue arrives is held (`document/host.rs`).
            let name = app.package_info().name.clone();
            preset_app_kit::AppKit::<tauri::Wry>::new(&name)
                .menu_config(menu::MENU_CONFIG)
                .file_type(&format!("{name} project"), document::EXTENSION)
                .commands(menu::commands())
                .install::<document::DocumentHost>(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The last document at launch, a document from the Finder or `open`, and the
            // close guard on quit: app-kit's.
            preset_app_kit::on_run_event(app, &event);
        });
}
