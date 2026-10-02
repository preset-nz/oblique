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
            rhizome_pom_tauri::commands::pom_save_as
        ])
        .setup(|app| {
            sidecar::start(app.handle().clone());
            menu::install(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
