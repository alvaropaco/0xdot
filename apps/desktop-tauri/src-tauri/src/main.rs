#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rakazo_core::{ApprovalDecision, Routine, RoutineId, ToolCall};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, process::Command};
use tauri::{AppHandle, Manager, State, Window};

mod agent_bridge;
mod agent_state;
mod approval;
mod computer_bridge;
mod deep_link;
mod events;
mod host_tools;
mod memory_store;
mod routine_state;

#[derive(Debug, Deserialize)] struct AgentExecutionRequest { model: String, prompt: String, #[serde(rename = "systemPrompt")] system_prompt: Option<String>, temperature: Option<f32>, #[serde(rename = "maxTokens")] max_tokens: Option<u32> }
#[derive(Debug, Serialize, Clone)] struct AgentExecutionResponse { #[serde(rename = "taskId")] task_id: String, content: String, #[serde(rename = "toolCalls")] tool_calls: usize, completed: bool }
#[derive(Debug, Serialize, Clone)] struct AgentStartResponse { #[serde(rename = "taskId")] task_id: String }
#[derive(Debug, Serialize, Clone)] struct UpdateState { phase: &'static str, #[serde(rename = "currentVersion")] current_version: String, #[serde(rename = "availableVersion")] available_version: Option<String>, percent: Option<f64>, message: Option<String>, #[serde(rename = "checkedAt")] checked_at: Option<String> }
#[derive(Debug, Serialize, Clone)] struct ComputerPermissionState { #[serde(rename = "screenRecording")] screen_recording: bool, accessibility: bool }

#[tauri::command] async fn window_close(window: Window) -> Result<(), String> { window.close().map_err(|e| e.to_string()) }
#[tauri::command] async fn window_minimize(window: Window) -> Result<(), String> { window.minimize().map_err(|e| e.to_string()) }
#[tauri::command] async fn window_toggle_maximize(window: Window) -> Result<(), String> { window.toggle_maximize().map_err(|e| e.to_string()) }
#[tauri::command] async fn window_state(window: Window) -> Result<serde_json::Value, String> { Ok(serde_json::json!({"minimized": window.is_minimized().map_err(|e| e.to_string())?, "maximized": window.is_maximized().map_err(|e| e.to_string())?, "fullScreen": window.is_fullscreen().map_err(|e| e.to_string())?})) }
#[tauri::command] async fn open_external(url: String) -> Result<(), String> { let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL".to_string())?; match parsed.scheme() { "https" | "http" | "mailto" => {}, _ => return Err("Only http, https and mailto URLs can be opened externally".to_string()) } #[cfg(target_os = "macos")] { Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?; } #[cfg(target_os = "windows")] { Command::new("cmd").args(["/C", "start", "", &url]).spawn().map_err(|e| e.to_string())?; } #[cfg(target_os = "linux")] { Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?; } Ok(()) }
#[tauri::command] async fn oauth_open(url: String) -> Result<(), String> { open_external(url).await }
#[tauri::command] async fn oauth_cancel(_url: String) -> Result<(), String> { Ok(()) }
#[tauri::command] async fn update_state(app: AppHandle) -> Result<UpdateState, String> { Ok(UpdateState { phase: "unsupported", current_version: app.package_info().version.to_string(), available_version: None, percent: None, message: Some("Tauri updater is not enabled until the release signing key and update endpoint are configured.".to_string()), checked_at: None }) }
#[tauri::command] async fn update_check(app: AppHandle) -> Result<UpdateState, String> { update_state(app).await }
#[tauri::command] async fn update_download(app: AppHandle) -> Result<UpdateState, String> { update_state(app).await }
#[tauri::command] async fn update_install(app: AppHandle) -> Result<UpdateState, String> { update_state(app).await }
#[tauri::command] async fn computer_permission_state() -> Result<ComputerPermissionState, String> { #[cfg(target_os = "macos")] { let state = rakazo_host::macos_permission_preflight(); return Ok(ComputerPermissionState { screen_recording: state.screen_recording, accessibility: state.accessibility }); } #[cfg(not(target_os = "macos"))] { Ok(ComputerPermissionState { screen_recording: false, accessibility: false }) } }
#[tauri::command] async fn computer_request_access() -> Result<bool, String> { let state = computer_permission_state().await?; Ok(state.screen_recording && state.accessibility) }
#[tauri::command] async fn computer_execute(call: ToolCall) -> Result<serde_json::Value, String> { computer_bridge::execute(call) }

fn workspace_root(app: &AppHandle, agent_id: uuid::Uuid) -> Result<PathBuf, String> { let root = app.path().app_data_dir().map_err(|e| format!("failed to resolve app data directory: {e}"))?.join("workspaces").join(agent_id.to_string()); fs::create_dir_all(&root).map_err(|e| format!("failed to create workspace: {e}"))?; Ok(root) }
fn memory_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(app.path().app_data_dir().map_err(|e| format!("failed to resolve app data directory: {e}"))?.join("memory.json")) }
fn routine_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(app.path().app_data_dir().map_err(|e| format!("failed to resolve app data directory: {e}"))?.join("routines.json")) }

fn spawn_agent(app: AppHandle, request: AgentExecutionRequest, broker: approval::ApprovalBroker) -> Result<uuid::Uuid, String> {
    let (runtime, agent_id, task) = agent_bridge::new_runtime_task(request.prompt.clone())?;
    let task_id = task.id;
    let root = workspace_root(&app, agent_id)?;
    let memory = memory_path(&app)?;
    runtime.enqueue_task(task).map_err(|e| e.to_string())?;
    events::forward(app.clone(), runtime.events().subscribe());
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> Result<_, String> {
            let provider = agent_bridge::provider_from_env()?;
            agent_bridge::execute_with_runtime(&provider, runtime, agent_id, task_id, request.model, request.prompt, request.system_prompt, request.temperature, request.max_tokens, broker, root, memory)
        })();
        if let Ok(result) = result { let _ = persist_execution(&app, &result); }
    });
    Ok(task_id)
}

#[tauri::command] async fn agent_execute(app: AppHandle, request: AgentExecutionRequest) -> Result<AgentExecutionResponse, String> {
    let (runtime, agent_id, task) = agent_bridge::new_runtime_task(request.prompt.clone())?;
    let root = workspace_root(&app, agent_id)?; let memory = memory_path(&app)?;
    runtime.enqueue_task(task.clone()).map_err(|e| e.to_string())?;
    events::forward(app.clone(), runtime.events().subscribe());
    let result = tauri::async_runtime::spawn_blocking(move || { let provider = agent_bridge::provider_from_env()?; agent_bridge::execute_with_runtime(&provider, runtime, agent_id, task.id, request.model, request.prompt, request.system_prompt, request.temperature, request.max_tokens, approval::ApprovalBroker::default(), root, memory) }).await.map_err(|e| e.to_string())??;
    persist_execution(&app, &result)?;
    Ok(AgentExecutionResponse { task_id: result.task_id.to_string(), content: result.content, tool_calls: result.tool_calls, completed: result.completed })
}

#[tauri::command] async fn agent_start(app: AppHandle, request: AgentExecutionRequest, approval: State<'_, approval::ApprovalBroker>) -> Result<AgentStartResponse, String> { let task_id = spawn_agent(app, request, approval.inner().clone())?; Ok(AgentStartResponse { task_id: task_id.to_string() }) }
#[tauri::command] fn agent_approve(task_id: String, approved: bool, approval: State<'_, approval::ApprovalBroker>) -> Result<bool, String> { let id = uuid::Uuid::parse_str(&task_id).map_err(|e| format!("invalid task id: {e}"))?; Ok(approval.decide(id, if approved { ApprovalDecision::Approved } else { ApprovalDecision::Rejected })) }
#[tauri::command] fn agent_pending_approvals(approval: State<'_, approval::ApprovalBroker>) -> Vec<String> { approval.pending().into_iter().map(|id| id.to_string()).collect() }
fn persist_execution(app: &AppHandle, result: &agent_bridge::AgentExecutionResult) -> Result<(), String> { let app_data_dir = app.path().app_data_dir().map_err(|e| format!("failed to resolve app data directory: {e}"))?; let store = agent_state::AgentStateStore::new(app_data_dir)?; store.record(result.snapshot.clone(), agent_state::ExecutionRecord { task_id: result.task_id.to_string(), content: result.content.clone(), tool_calls: result.tool_calls, completed: result.completed })?; Ok(()) }
#[tauri::command] async fn agent_state(app: AppHandle) -> Result<agent_state::PersistedAgentState, String> { let app_data_dir = app.path().app_data_dir().map_err(|e| format!("failed to resolve app data directory: {e}"))?; agent_state::AgentStateStore::new(app_data_dir)?.load() }
#[tauri::command] async fn routine_list(app: AppHandle) -> Result<Vec<Routine>, String> { routine_state::RoutineStore::open(routine_path(&app)?)?.list() }
#[tauri::command] async fn routine_upsert(app: AppHandle, routine: Routine) -> Result<(), String> { routine_state::RoutineStore::open(routine_path(&app)?)?.upsert(routine) }
#[tauri::command] async fn routine_remove(app: AppHandle, routine_id: String) -> Result<bool, String> { let id = RoutineId::parse_str(&routine_id).map_err(|e| format!("invalid routine id: {e}"))?; routine_state::RoutineStore::open(routine_path(&app)?)?.remove(id) }
#[tauri::command] async fn routine_tick(app: AppHandle) -> Result<Vec<Routine>, String> { routine_state::RoutineStore::open(routine_path(&app)?)?.tick() }
#[tauri::command] async fn computer_revoke_access() -> Result<(), String> { Ok(()) }
#[tauri::command] async fn badge_set(_count: u32) -> Result<bool, String> { Ok(false) }

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(approval::ApprovalBroker::default())
        .invoke_handler(tauri::generate_handler![window_close, window_minimize, window_toggle_maximize, window_state, open_external, oauth_open, oauth_cancel, update_state, update_check, update_download, update_install, computer_permission_state, computer_request_access, computer_execute, agent_execute, agent_start, agent_approve, agent_pending_approvals, agent_state, routine_list, routine_upsert, routine_remove, routine_tick, computer_revoke_access, badge_set])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.set_focus(); }
            deep_link::setup(app.handle())?;
            let handle = app.handle().clone();
            let broker = app.state::<approval::ApprovalBroker>().inner().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let Ok(store) = routine_state::RoutineStore::open(routine_path(&handle).unwrap_or_else(|_| PathBuf::from("routines.json"))) else { continue; };
                    let Ok(due) = store.tick() else { continue; };
                    for routine in due {
                        let _ = spawn_agent(handle.clone(), AgentExecutionRequest { model: routine.model, prompt: routine.prompt, system_prompt: None, temperature: None, max_tokens: None }, broker.clone());
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Rakazo Tauri application");
}
