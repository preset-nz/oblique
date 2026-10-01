//! IPC wrapper for the text engine. Kept outside `text/` so the engine stays Tauri-free.

use crate::{fonts, text};

#[tauri::command]
pub async fn text_outlines(spec: text::TextSpec) -> Result<text::TextGeometry, String> {
    tauri::async_runtime::spawn_blocking(move || text::layout(fonts::database(), &spec))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
