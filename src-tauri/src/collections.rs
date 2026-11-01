//! The API workspace (groups, sub-groups, requests, sockets, labels) is one
//! JSON document owned by the frontend, and so are the flows. Rust only keeps
//! them on disk, in the app data dir, writing through a temp file so a crash
//! never leaves half a file.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const FILE: &str = "workspace.json";

fn path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(file))
}

/// A JSON document the frontend owns, or `None` before it's first saved.
pub(crate) fn load_doc(app: &AppHandle, file: &str) -> Result<Option<serde_json::Value>, String> {
    let path = path(app, file)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))
}

pub(crate) fn save_doc(app: &AppHandle, file: &str, doc: &serde_json::Value) -> Result<(), String> {
    let path = path(app, file)?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Returns the saved workspace, or `null` on first run.
#[tauri::command]
pub fn workspace_load(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    load_doc(&app, FILE)
}

#[tauri::command]
pub fn workspace_save(app: AppHandle, workspace: serde_json::Value) -> Result<(), String> {
    save_doc(&app, FILE, &workspace)
}

#[tauri::command]
pub fn workspace_path(app: AppHandle) -> Result<String, String> {
    path(&app, FILE).map(|p| p.display().to_string())
}
