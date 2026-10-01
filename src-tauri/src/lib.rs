mod fonts;
mod menu;
mod sidecar;

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
            sidecar::sidecar_send,
            sidecar::sidecar_subscribe
        ])
        .setup(|app| {
            sidecar::start(app.handle().clone());
            menu::install(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
