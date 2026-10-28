//! The renderer is the server-hosted 0xdot web application, so the shell must
//! point the webview at a working http(s) origin. Until the local-first runtime
//! exposes a web API, the embedded dist is only a pre-navigation splash, and
//! the origin is resolved from a persisted override falling back to the cloud.

use std::{fs, path::PathBuf};
use tauri::Manager;

pub const DEFAULT_SERVER_ORIGIN: &str = "https://app.rakazo.com";

fn server_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data directory: {e}"))?;
    Ok(dir.join("server.txt"))
}

pub fn server_origin(app: &tauri::AppHandle) -> String {
    let Ok(path) = server_file(app) else {
        return DEFAULT_SERVER_ORIGIN.into();
    };
    let Ok(saved) = fs::read_to_string(path) else {
        return DEFAULT_SERVER_ORIGIN.into();
    };
    let trimmed = saved.trim();
    if acceptable(trimmed) {
        trimmed.to_string()
    } else {
        DEFAULT_SERVER_ORIGIN.into()
    }
}

fn acceptable(origin: &str) -> bool {
    matches!(
        url::Url::parse(origin),
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some()
    )
}

#[tauri::command]
pub fn server_get(app: tauri::AppHandle) -> String {
    server_origin(&app)
}

#[tauri::command]
pub fn server_set(app: tauri::AppHandle, origin: String) -> Result<(), String> {
    let trimmed = origin.trim();
    if !acceptable(trimmed) {
        return Err("Only absolute http and https URLs are accepted".into());
    }
    let path = server_file(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, trimmed).map_err(|e| e.to_string())
}
