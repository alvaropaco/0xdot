#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::process::Command;
use tauri::{AppHandle, Manager, Window};
use rakazo_core::ToolCall;

mod computer_bridge;

#[derive(Debug, Serialize, Clone)]
struct UpdateState {
    phase: &'static str,
    #[serde(rename = "currentVersion")]
    current_version: String,
    #[serde(rename = "availableVersion")]
    available_version: Option<String>,
    percent: Option<f64>,
    message: Option<String>,
    #[serde(rename = "checkedAt")]
    checked_at: Option<String>,
}

#[tauri::command]
async fn window_close(window: Window) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
async fn window_minimize(window: Window) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
async fn window_toggle_maximize(window: Window) -> Result<(), String> {
    window.toggle_maximize().map_err(|error| error.to_string())
}

#[tauri::command]
async fn window_state(window: Window) -> Result<serde_json::Value, String> {
    let minimized = window.is_minimized().map_err(|error| error.to_string())?;
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    let full_screen = window.is_fullscreen().map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "minimized": minimized,
        "maximized": maximized,
        "fullScreen": full_screen,
    }))
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL".to_string())?;
    match parsed.scheme() {
        "https" | "http" | "mailto" => {}
        _ => return Err("Only http, https and mailto URLs can be opened externally".to_string()),
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn oauth_open(url: String) -> Result<(), String> {
    open_external(url).await
}

#[tauri::command]
async fn oauth_cancel(_url: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn update_state(app: AppHandle) -> Result<UpdateState, String> {
    let current_version = app.package_info().version.to_string();
    Ok(UpdateState {
        phase: "unsupported",
        current_version,
        available_version: None,
        percent: None,
        message: Some("Tauri updater is not enabled until the release signing key and update endpoint are configured.".to_string()),
        checked_at: None,
    })
}

#[tauri::command]
async fn update_check(app: AppHandle) -> Result<UpdateState, String> {
    update_state(app).await
}

#[tauri::command]
async fn update_download(app: AppHandle) -> Result<UpdateState, String> {
    update_state(app).await
}

#[tauri::command]
async fn update_install(app: AppHandle) -> Result<UpdateState, String> {
    update_state(app).await
}

#[tauri::command]
async fn computer_request_access() -> Result<bool, String> {
    Ok(true)
}

#[tauri::command]
async fn computer_execute(call: ToolCall) -> Result<serde_json::Value, String> {
    computer_bridge::execute(call)
}

#[tauri::command]
async fn computer_revoke_access() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn badge_set(_count: u32) -> Result<bool, String> {
    Ok(false)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            window_close,
            window_minimize,
            window_toggle_maximize,
            window_state,
            open_external,
            oauth_open,
            oauth_cancel,
            update_state,
            update_check,
            update_download,
            update_install,
            computer_request_access,
            computer_execute,
            computer_revoke_access,
            badge_set,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Rakazo Tauri application");
}
