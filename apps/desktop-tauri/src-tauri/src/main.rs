#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rakazo_core::ToolCall;
use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{AppHandle, Manager, Window};

mod agent_bridge;
mod computer_bridge;

#[derive(Debug, Deserialize)]
struct AgentExecutionRequest {
    model: String,
    prompt: String,
    #[serde(rename = "systemPrompt")]
    system_prompt: Option<String>,
    temperature: Option<f32>,
    #[serde(rename = "maxTokens")]
    max_tokens: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
struct AgentExecutionResponse {
    #[serde(rename = "taskId")]
    task_id: String,
    content: String,
    #[serde(rename = "toolCalls")]
    tool_calls: usize,
    completed: bool,
}

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

#[derive(Debug, Serialize, Clone)]
struct ComputerPermissionState {
    #[serde(rename = "screenRecording")]
    screen_recording: bool,
    accessibility: bool,
}

#[tauri::command]
async fn window_close(window: Window) -> Result<(), String> { window.close().map_err(|error| error.to_string()) }
#[tauri::command]
async fn window_minimize(window: Window) -> Result<(), String> { window.minimize().map_err(|error| error.to_string()) }
#[tauri::command]
async fn window_toggle_maximize(window: Window) -> Result<(), String> { window.toggle_maximize().map_err(|error| error.to_string()) }
#[tauri::command]
async fn window_state(window: Window) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "minimized": window.is_minimized().map_err(|e| e.to_string())?,
        "maximized": window.is_maximized().map_err(|e| e.to_string())?,
        "fullScreen": window.is_fullscreen().map_err(|e| e.to_string())?,
    }))
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL".to_string())?;
    match parsed.scheme() { "https" | "http" | "mailto" => {}, _ => return Err("Only http, https and mailto URLs can be opened externally".to_string()) }
    #[cfg(target_os = "macos")]
    { Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?; }
    #[cfg(target_os = "windows")]
    { Command::new("cmd").args(["/C", "start", "", &url]).spawn().map_err(|e| e.to_string())?; }
    #[cfg(target_os = "linux")]
    { Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?; }
    Ok(())
}
#[tauri::command]
async fn oauth_open(url: String) -> Result<(), String> { open_external(url).await }
#[tauri::command]
async fn oauth_cancel(_url: String) -> Result<(), String> { Ok(()) }

#[tauri::command]
async fn update_state(app: AppHandle) -> Result<UpdateState, String> {
    Ok(UpdateState { phase: "unsupported", current_version: app.package_info().version.to_string(), available_version: None, percent: None, message: Some("Tauri updater is not enabled until the release signing key and update endpoint are configured.".to_string()), checked_at: None })
}
#[tauri::command]
async fn update_check(app: AppHandle) -> Result<UpdateState, String> { update_state(app).await }
#[tauri::command]
async fn update_download(app: AppHandle) -> Result<UpdateState, String> { update_state(app).await }
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<UpdateState, String> { update_state(app).await }

#[tauri::command]
async fn computer_permission_state() -> Result<ComputerPermissionState, String> {
    #[cfg(target_os = "macos")]
    { let state = rakazo_host::macos_permission_preflight(); return Ok(ComputerPermissionState { screen_recording: state.screen_recording, accessibility: state.accessibility }); }
    #[cfg(not(target_os = "macos"))]
    { Ok(ComputerPermissionState { screen_recording: false, accessibility: false }) }
}
#[tauri::command]
async fn computer_request_access() -> Result<bool, String> { let state = computer_permission_state().await?; Ok(state.screen_recording && state.accessibility) }
#[tauri::command]
async fn computer_execute(call: ToolCall) -> Result<serde_json::Value, String> { computer_bridge::execute(call) }

#[tauri::command]
async fn agent_execute(request: AgentExecutionRequest) -> Result<AgentExecutionResponse, String> {
    let result = tauri::async_runtime::spawn_blocking(move || agent_bridge::execute(request.model, request.prompt, request.system_prompt, request.temperature, request.max_tokens))
        .await.map_err(|e| e.to_string())??;
    Ok(AgentExecutionResponse { task_id: result.task_id.to_string(), content: result.content, tool_calls: result.tool_calls, completed: result.completed })
}

#[tauri::command]
async fn computer_revoke_access() -> Result<(), String> { Ok(()) }
#[tauri::command]
async fn badge_set(_count: u32) -> Result<bool, String> { Ok(false) }

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![window_close, window_minimize, window_toggle_maximize, window_state, open_external, oauth_open, oauth_cancel, update_state, update_check, update_download, update_install, computer_permission_state, computer_request_access, computer_execute, agent_execute, computer_revoke_access, badge_set])
        .setup(|app| { if let Some(window) = app.get_webview_window("main") { let _ = window.set_focus(); } Ok(()) })
        .run(tauri::generate_context!())
        .expect("error while running Rakazo Tauri application");
}
