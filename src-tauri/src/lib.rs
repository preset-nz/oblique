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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(sidecar::SidecarState::default())
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
            rhizome_pom_tauri::commands::pom_connect,
            rhizome_pom_tauri::commands::pom_new,
            rhizome_pom_tauri::commands::pom_open,
            rhizome_pom_tauri::commands::pom_save_as,
            preset_app_kit::app_kit_commands,
            preset_app_kit::app_kit_menu_state,
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
            // The menu bar is app-kit's, with Oblique's commands on its table (`menu.rs`). It is
            // installed as a history only, not a document (`install_history`): Undo and Redo and
            // their titles are the host's, and File stays Oblique's own until slice c. Installing
            // after the host is managed matters: app-kit reads its history straight away.
            preset_app_kit::AppKit::<tauri::Wry>::new(&app.package_info().name)
                .menu_config(menu::MENU_CONFIG)
                .commands(menu::commands())
                .install_history::<document::DocumentHost>(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // A document macOS asks us to open (`open -a`, the Dock). It reaches the webview
            // through `pom_connect` at launch or `pom://open-document` while running.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                use tauri::Manager;
                // The host exists once the sidecar's op catalogue is in (`document_init`).
                // A path asked for before that has nowhere to wait yet.
                // deferred: Epic 21 story 2 (or app-kit) holds it until then.
                if app.try_state::<rhizome_pom_tauri::PomHost>().is_some() {
                    rhizome_pom_tauri::opened(app, urls);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
