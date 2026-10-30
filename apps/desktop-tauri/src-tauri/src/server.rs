//! The desktop runtime is local-first: with no saved origin the window keeps
//! the bundled assets and the embedded Rust runtime answers. A saved origin is
//! an explicit opt-in to remote mode — the webview then navigates to someone
//! else's 0xdot server. `local` (or empty) clears the override.

use std::{fs, path::PathBuf};
use tauri::Manager;

pub const LOCAL_MODE: &str = "local";

fn server_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data directory: {e}"))?;
    Ok(dir.join("server.txt"))
}

/// The saved remote origin, or None when the app runs on its local runtime.
pub fn server_origin(app: &tauri::AppHandle) -> Option<String> {
    let path = server_file(app).ok()?;
    let saved = fs::read_to_string(path).ok()?;
    let trimmed = saved.trim();
    if acceptable(trimmed) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn acceptable(origin: &str) -> bool {
    matches!(
        url::Url::parse(origin),
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some()
    )
}

#[tauri::command]
pub fn server_get(app: tauri::AppHandle) -> Option<String> {
    server_origin(&app)
}

#[tauri::command]
pub fn server_set(app: tauri::AppHandle, origin: String) -> Result<Option<String>, String> {
    let trimmed = origin.trim();
    let path = server_file(&app)?;
    if trimmed.is_empty() || trimmed == LOCAL_MODE {
        let _ = fs::remove_file(&path);
        return Ok(None);
    }
    if !acceptable(trimmed) {
        return Err("Only absolute http and https URLs are accepted".into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, trimmed).map_err(|e| e.to_string())?;
    Ok(Some(trimmed.to_string()))
}
