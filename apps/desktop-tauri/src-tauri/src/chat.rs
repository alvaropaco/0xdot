//! Local chat commands (migration plan M1/M2): the IPC surface the bundled web
//! UI drives instead of oRPC. Threads persist in SQLite; a turn runs the Rust
//! agent loop on the blocking pool and streams assistant text through
//! `chat://delta` events, while tool activity and approval requests land in the
//! transcript timeline. The workspace file tools auto-approve; host filesystem
//! writes and computer/shell tools block on the shared `ApprovalBroker` until
//! the UI decides (the M2 takeover path). No server involved.

use crate::{
    agent_bridge,
    approval::ApprovalBroker,
    chat_store::{Bot, ChatMessage, ChatStore, ChatThread, ScheduledRoutine, SearchHit, UsageTotals, KEY_API_KEY, KEY_BASE_URL, KEY_DEFAULT_MODEL},
    mcp_state::McpState,
};
#[cfg(target_os = "macos")]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rakazo_core::{
    ApprovalDecision, ApprovalGate, ExecutorError, MessageRole, ModelMessage, StreamCallback, TaskId,
    ToolCall, ToolResult,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc::UnboundedSender;

/// A timeline entry handed from the blocking agent loop to the async writer.
/// `kind` is `tool` or `approval`; `payload` is structured JSON the UI renders.
struct ActivityEvent {
    kind: String,
    content: String,
    payload: String,
}

pub const EVENT_DELTA: &str = "chat://delta";
pub const EVENT_DONE: &str = "chat://done";
pub const EVENT_ERROR: &str = "chat://error";
pub const EVENT_ACTIVITY: &str = "chat://activity";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatDelta {
    pub thread_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatDone {
    pub thread_id: String,
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatFailed {
    pub thread_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettings {
    pub base_url: String,
    pub default_model: String,
    /// The key itself never crosses the IPC boundary; the UI only learns
    /// whether one is stored.
    pub has_api_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SendAccepted {
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    /// `image/png` today; keeps the payload self-describing.
    pub mime: String,
    pub base64: String,
}

/// `ApprovalGate` that surfaces a mutating tool to the UI and blocks on the
/// shared broker. It records the request and the decision as timeline rows via
/// the activity channel, then delegates the blocking wait to `ApprovalBroker`,
/// which the `chat_decide` command resolves.
struct ChatApprovalGate {
    broker: ApprovalBroker,
    sender: UnboundedSender<ActivityEvent>,
}

impl ChatApprovalGate {
    fn new(broker: ApprovalBroker, sender: UnboundedSender<ActivityEvent>) -> Self {
        Self { broker, sender }
    }

    fn emit(&self, content: String, payload: serde_json::Value) {
        let _ = self.sender.send(ActivityEvent { kind: "approval".into(), content, payload: payload.to_string() });
    }
}

impl ApprovalGate for ChatApprovalGate {
    fn request(&self, task_id: TaskId, call: &ToolCall) -> Result<ApprovalDecision, ExecutorError> {
        self.emit(format!("Approval requested: {}", call.name), json!({ "status": "requested", "taskId": task_id.to_string(), "tool": call.name, "arguments": call.arguments }));
        let decision = self.broker.request(task_id, call)?;
        let status = match &decision {
            ApprovalDecision::Approved => "approved",
            ApprovalDecision::Rejected => "rejected",
        };
        self.emit(format!("Approval {status}: {}", call.name), json!({ "status": status, "taskId": task_id.to_string(), "tool": call.name }));
        Ok(decision)
    }
}

#[tauri::command]
#[specta::specta]
pub async fn chat_settings_get(store: State<'_, ChatStore>) -> Result<ChatSettings, String> {
    let base_url = store.setting(KEY_BASE_URL).await?.unwrap_or_default();
    let default_model = store.setting(KEY_DEFAULT_MODEL).await?.unwrap_or_default();
    let has_api_key = store.setting(KEY_API_KEY).await?.is_some_and(|value| !value.is_empty());
    Ok(ChatSettings { base_url, default_model, has_api_key })
}

#[tauri::command]
#[specta::specta]
pub async fn chat_settings_set(store: State<'_, ChatStore>, base_url: String, api_key: String, default_model: String) -> Result<(), String> {
    store.set_setting(KEY_BASE_URL, base_url.trim()).await?;
    if !api_key.is_empty() {
        store.set_setting(KEY_API_KEY, api_key.trim()).await?;
    }
    store.set_setting(KEY_DEFAULT_MODEL, default_model.trim()).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn chat_bots_list(store: State<'_, ChatStore>) -> Result<Vec<Bot>, String> {
    store.bots().await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_bot_create(store: State<'_, ChatStore>, name: String, system_prompt: String, model: String) -> Result<Bot, String> {
    if name.trim().is_empty() {
        return Err("bot name is required".into());
    }
    store.create_bot(name.trim(), system_prompt.trim(), model.trim()).await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_bot_remove(store: State<'_, ChatStore>, bot_id: String) -> Result<(), String> {
    store.delete_bot(&bot_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_threads_list(store: State<'_, ChatStore>, bot_id: String) -> Result<Vec<ChatThread>, String> {
    store.threads(&bot_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_thread_create(store: State<'_, ChatStore>, bot_id: String) -> Result<ChatThread, String> {
    store.bot(&bot_id).await?;
    store.create_thread(&bot_id, "").await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_messages_list(store: State<'_, ChatStore>, thread_id: String) -> Result<Vec<ChatMessage>, String> {
    store.messages(&thread_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_search(store: State<'_, ChatStore>, query: String, limit: Option<i32>) -> Result<Vec<SearchHit>, String> {
    store.search(&query, limit.unwrap_or(20).clamp(1, 50) as i64).await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_routines_list(store: State<'_, ChatStore>) -> Result<Vec<ScheduledRoutine>, String> {
    store.routines().await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_routine_create(store: State<'_, ChatStore>, bot_id: String, name: String, prompt: String, model: String, interval_seconds: i32) -> Result<ScheduledRoutine, String> {
    if name.trim().is_empty() || prompt.trim().is_empty() {
        return Err("routine name and prompt are required".into());
    }
    if interval_seconds < 1 {
        return Err("interval must be at least one second".into());
    }
    store.create_routine(&bot_id, name.trim(), prompt.trim(), model.trim(), interval_seconds).await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_routine_remove(store: State<'_, ChatStore>, routine_id: String) -> Result<bool, String> {
    store.remove_routine(&routine_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_routine_set_enabled(store: State<'_, ChatStore>, routine_id: String, enabled: bool) -> Result<(), String> {
    store.set_routine_enabled(&routine_id, enabled).await
}

#[tauri::command]
#[specta::specta]
pub async fn chat_usage(store: State<'_, ChatStore>) -> Result<UsageTotals, String> {
    store.usage_totals().await
}

/// A persisted MCP server joined with its live state. `env` values never
/// cross the IPC boundary - only their key names (M5).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerView {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    pub env_keys: Vec<String>,
    pub connected: bool,
    pub tools: Vec<String>,
}

fn mcp_view(server: &crate::chat_store::McpServerStored, mcp: &McpState) -> McpServerView {
    let connected = mcp.is_connected(&server.id);
    McpServerView {
        id: server.id.clone(),
        command: server.command.clone(),
        args: server.args.clone(),
        env_keys: server.env.keys().cloned().collect(),
        connected,
        tools: if connected { mcp.tool_names(&server.id) } else { Vec::new() },
    }
}

fn connect_server(mcp: &McpState, server: &crate::chat_store::McpServerStored) -> Result<(), String> {
    let config = rakazo_core::McpServerConfig { command: server.command.clone(), args: server.args.clone(), env: server.env.clone() };
    mcp.connect(crate::mcp_state::McpConnectRequest { id: server.id.clone(), config }).map(|_| ())
}

#[tauri::command]
#[specta::specta]
pub async fn chat_mcp_list(store: State<'_, ChatStore>, mcp: State<'_, McpState>) -> Result<Vec<McpServerView>, String> {
    let rows = store.mcp_server_rows().await?;
    Ok(rows.iter().map(|(_, server)| mcp_view(server, mcp.inner())).collect())
}

/// Saves the server definition first and connects second: an MCP server that
/// fails to start keeps its saved config and simply shows `connected: false`,
/// so the agent picks its tools up on a later launch.
#[tauri::command]
#[specta::specta]
pub async fn chat_mcp_connect(store: State<'_, ChatStore>, mcp: State<'_, McpState>, id: String, command: String, args: Vec<String>, env: HashMap<String, String>) -> Result<McpServerView, String> {
    let id = id.trim().to_string();
    if id.is_empty() || id.contains('/') || id.contains('\\') {
        return Err("server id must be a simple name".into());
    }
    if command.trim().is_empty() {
        return Err("server command is required".into());
    }
    store.save_mcp_server(&id, command.trim(), &json!(args).to_string(), &json!(env).to_string()).await?;
    let server = crate::chat_store::McpServerStored { id, command: command.trim().to_string(), args, env };
    let mcp_owned = mcp.inner().clone();
    let connect_server_owned = server.clone();
    // The handshake reads the child's stdout, so it runs off the async
    // runtime's worker threads with a short budget: a slow server keeps
    // connecting in the background and shows up connected on the next refresh.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), tauri::async_runtime::spawn_blocking(move || connect_server(&mcp_owned, &connect_server_owned))).await;
    Ok(mcp_view(&server, mcp.inner()))
}

#[tauri::command]
#[specta::specta]
pub async fn chat_mcp_remove(store: State<'_, ChatStore>, mcp: State<'_, McpState>, id: String) -> Result<bool, String> {
    let _ = mcp.disconnect(&id);
    store.remove_mcp_server(&id).await
}

/// Best-effort reconnect of every saved MCP server at startup. A server that
/// is broken today still shows up (unconnected) and its tools reappear once
/// it starts.
pub async fn reconnect_saved_servers(app: &AppHandle) {
    let store = app.state::<ChatStore>().inner().clone();
    let mcp = app.state::<McpState>().inner().clone();
    let Ok(rows) = store.mcp_server_rows().await else { return };
    for (_, server) in rows {
        let mcp = mcp.clone();
        // Each server connects on its own task: a broken one that never
        // answers the handshake must not delay the healthy ones.
        tauri::async_runtime::spawn(async move {
            let _ = tauri::async_runtime::spawn_blocking(move || connect_server(&mcp, &server)).await;
        });
    }
}

/// Lists the bot's workspace files (artifacts the agent wrote) recursively.
/// The bot id is validated as a uuid before it becomes a path segment, so no
/// caller can escape the workspaces directory.
#[tauri::command]
#[specta::specta]
pub async fn chat_workspace_files(app: AppHandle, bot_id: String) -> Result<Vec<String>, String> {
    let bot_uuid = uuid::Uuid::parse_str(&bot_id).map_err(|_| "invalid bot id".to_string())?;
    let root = crate::app_data_dir(&app)?.join("workspaces").join(bot_uuid.to_string());
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    collect_files(&root, &root, &mut files, 4, 300).map_err(|e| e.to_string())?;
    files.sort();
    Ok(files)
}

#[tauri::command]
#[specta::specta]
pub async fn chat_workspace_read(app: AppHandle, bot_id: String, path: String) -> Result<String, String> {
    let bot_uuid = uuid::Uuid::parse_str(&bot_id).map_err(|_| "invalid bot id".to_string())?;
    let root = crate::app_data_dir(&app)?.join("workspaces").join(bot_uuid.to_string());
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    rakazo_core::WorkspaceFs::new(root)
        .map_err(|e| e.to_string())?
        .read_file(&path)
        .map_err(|e| e.to_string())
}

fn collect_files(root: &std::path::Path, dir: &std::path::Path, files: &mut Vec<String>, depth: u32, cap: usize) -> std::io::Result<()> {
    if depth == 0 || files.len() >= cap {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_files(root, &entry.path(), files, depth - 1, cap)?;
        } else if let Ok(relative) = entry.path().strip_prefix(root) {
            files.push(relative.to_string_lossy().to_string());
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn chat_decide(task_id: String, approved: bool, approval: State<'_, ApprovalBroker>) -> Result<bool, String> {
    let id = uuid::Uuid::parse_str(&task_id).map_err(|e| format!("invalid task id: {e}"))?;
    Ok(approval.decide(id, if approved { ApprovalDecision::Approved } else { ApprovalDecision::Rejected }))
}

/// Captures the full screen for the UI's manual "what am I looking at" check.
/// User-initiated, so it does not go through the agent's approval gate.
#[tauri::command]
#[specta::specta]
pub async fn chat_screenshot() -> Result<Screenshot, String> {
    #[cfg(target_os = "macos")]
    {
        let file = std::env::temp_dir().join(format!("0xdot-shot-{}.png", uuid::Uuid::new_v4()));
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            let status = std::process::Command::new("/usr/sbin/screencapture").args(["-x", "-t", "png", &file.to_string_lossy()]).status();
            (file, status)
        })
        .await
        .map_err(|e| e.to_string())?;
        let (file, status) = outcome;
        if !status.map_err(|e| e.to_string())?.success() {
            return Err("screencapture failed; grant Screen Recording permission".into());
        }
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&file);
        Ok(Screenshot { mime: "image/png".into(), base64: BASE64.encode(bytes) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("screen capture is only available on macOS today".into())
    }
}

/// The tauri-specta surface for the chat commands; a test exports the
/// generated TypeScript bindings so the web adapter stays in lockstep with
/// Rust. Event payloads (`ChatDelta`/`ChatDone`/`ChatFailed` on the
/// `chat://*` topics, plus the `ChatMessage` on `chat://activity`) mirror
/// chat.rs by hand in the adapter — only the command surface is code-generated.
pub fn bindings() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new().commands(tauri_specta::collect_commands![
        chat_settings_get,
        chat_settings_set,
        chat_bots_list,
        chat_bot_create,
        chat_bot_remove,
        chat_threads_list,
        chat_thread_create,
        chat_messages_list,
        chat_search,
        chat_workspace_files,
        chat_workspace_read,
        chat_decide,
        chat_screenshot,
        chat_routines_list,
        chat_routine_create,
        chat_routine_remove,
        chat_routine_set_enabled,
        chat_usage,
        chat_mcp_list,
        chat_mcp_connect,
        chat_mcp_remove,
        chat_send
    ])
}

/// What the blocking agent loop hands back for the async tail: the reply text
/// plus the model/usage so the turn can record token totals.
struct TurnOutcome {
    content: String,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
}

/// Shared turn pipeline for `chat_send` and the routine scheduler: resolve the
/// thread's bot, persist the user message, run the agent loop on the blocking
/// pool streaming deltas + tool/approval activity, then store the assistant
/// reply and record usage. Returns once the turn is running (accepted).
async fn start_turn(app: AppHandle, store: ChatStore, mcp: McpState, broker: ApprovalBroker, thread_id: String, content: String, model_override: Option<String>) -> Result<SendAccepted, String> {
    if content.trim().is_empty() {
        return Err("message is empty".into());
    }
    let thread = store.thread(&thread_id).await?;
    let bot = store.bot(&thread.bot_id).await?;
    let (base_url, api_key) = store.connection().await?.ok_or_else(|| "no model connection configured".to_string())?;
    let model = match model_override.filter(|value| !value.trim().is_empty()) {
        Some(override_model) => override_model,
        None => store.resolve_model(&bot).await?,
    };
    // Memory is keyed by the bot id so what one conversation remembers is
    // available to every later thread with the same bot.
    let agent_id = uuid::Uuid::parse_str(&bot.id).map_err(|e| e.to_string())?;
    let bot_id = bot.id.clone();
    let history_rows = store.transcript(&thread_id).await?;
    let user = store.append_message(&thread_id, "user", &content, false).await?;
    let history: Vec<ModelMessage> = history_rows.iter().filter_map(|message| match message.role.as_str() {
        "user" => Some(ModelMessage { role: MessageRole::User, content: message.content.clone() }),
        "assistant" if !message.failed => Some(ModelMessage { role: MessageRole::Assistant, content: message.content.clone() }),
        _ => None,
    }).collect();
    let system_prompt = (!bot.system_prompt.trim().is_empty()).then(|| bot.system_prompt.clone());
    let app_data = crate::app_data_dir(&app)?;
    let workspace = app_data.join("workspaces").join(&bot.id);
    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    let memory_path = app_data.join("memory.json");

    // The blocking loop records tool/approval activity through this unbounded
    // channel; a runtime task persists it in order and mirrors it to the UI.
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<ActivityEvent>();
    let writer_thread = thread_id.clone();
    let writer_store = store.clone();
    let writer_app = app.clone();
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            if let Ok(message) = writer_store.record_event(&writer_thread, &event.kind, &event.content, &event.payload).await {
                let _ = writer_app.emit(EVENT_ACTIVITY, &message);
            }
        }
    });

    let stream: StreamCallback = {
        let app = app.clone();
        let thread_id = thread_id.clone();
        Arc::new(move |text: &str| {
            let _ = app.emit(EVENT_DELTA, ChatDelta { thread_id: thread_id.clone(), text: text.to_string() });
        })
    };
    let observer_tx = sender.clone();
    let observer: agent_bridge::ToolObserver = Arc::new(move |call: &ToolCall, result: &ToolResult| {
        let payload = json!({ "tool": call.name, "arguments": call.arguments, "success": result.success, "output": result.output });
        let _ = observer_tx.send(ActivityEvent { kind: "tool".into(), content: format!("Ran {}", call.name), payload: payload.to_string() });
    });
    let gate = Arc::new(ChatApprovalGate::new(broker, sender));

    let accepted = SendAccepted { message_id: user.id };
    let run = tauri::async_runtime::spawn_blocking(move || -> Result<TurnOutcome, String> {
        let provider = agent_bridge::provider_from_connection(&base_url, &api_key)?;
        let (runtime, _registered, task) = agent_bridge::new_runtime_task(content.clone())?;
        let task_id = task.id;
        runtime.enqueue_task(task).map_err(|e| e.to_string())?;
        let model_for_log = model.clone();
        let result = agent_bridge::execute_with_runtime(&provider, runtime, agent_id, task_id, model, content, system_prompt, None, None, gate, workspace, memory_path, mcp, history, Some(stream), false, Some(observer))?;
        Ok(TurnOutcome { content: result.content, model: model_for_log, input_tokens: result.input_tokens as i64, output_tokens: result.output_tokens as i64 })
    });
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = match run.await {
            Ok(inner) => inner,
            Err(join) => Err(format!("agent task panicked: {join}")),
        };
        // The blocking closure returned, so its gate/observer senders are dropped
        // and the writer has drained; wait for it before persisting the reply so
        // the assistant message lands after its tool/approval rows.
        let _ = writer.await;
        match outcome {
            Ok(turn) => match store.append_message(&thread_id, "assistant", &turn.content, false).await {
                Ok(message) => {
                    let _ = store.log_usage(&message.thread_id, &bot_id, &turn.model, turn.input_tokens, turn.output_tokens).await;
                    let _ = app_for_task.emit(EVENT_DONE, ChatDone { thread_id, message_id: message.id });
                }
                Err(error) => {
                    let _ = app_for_task.emit(EVENT_ERROR, ChatFailed { thread_id, message: error });
                }
            },
            Err(error) => {
                if store.append_message(&thread_id, "assistant", &error, true).await.is_ok() {
                    let _ = app_for_task.emit(EVENT_ERROR, ChatFailed { thread_id, message: error });
                }
            }
        }
    });
    Ok(accepted)
}

/// Persists the user message, accepts immediately, and drives the agent turn
/// in the background: deltas stream through events, tool and approval activity
/// is written to the timeline, and the assistant reply is stored when the run
/// finishes.
#[tauri::command]
#[specta::specta]
pub async fn chat_send(app: AppHandle, store: State<'_, ChatStore>, mcp: State<'_, McpState>, approval: State<'_, ApprovalBroker>, thread_id: String, content: String) -> Result<SendAccepted, String> {
    start_turn(app, store.inner().clone(), mcp.inner().clone(), approval.inner().clone(), thread_id, content, None).await
}

/// Fires one scheduled routine: opens a fresh thread on the routine's bot (the
/// transcript stays findable via search) and runs its prompt as a turn. The
/// native scheduler in `main.rs` calls this when a routine comes due.
pub async fn fire_routine(app: &AppHandle, routine: &ScheduledRoutine) -> Result<(), String> {
    let store = app.state::<ChatStore>().inner().clone();
    let mcp = app.state::<McpState>().inner().clone();
    let broker = app.state::<ApprovalBroker>().inner().clone();
    let thread = store.create_thread(&routine.bot_id, &routine.name).await?;
    let override_model = (!routine.model.trim().is_empty()).then(|| routine.model.clone());
    start_turn(app.clone(), store, mcp, broker, thread.id, routine.prompt.clone(), override_model).await.map(|_| ())
}

#[cfg(test)]
mod bindings_export {
    /// Deterministically regenerates the TypeScript command bindings the web
    /// UI imports (`apps/web/src/lib/tauri/bindings.ts`) from this module's
    /// `#[specta::specta]`-annotated commands. Run with
    /// `cargo test -p rakazo-desktop generate_typescript_bindings`.
    #[test]
    fn generate_typescript_bindings() {
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../web/src/lib/tauri/bindings.ts");
        std::fs::create_dir_all(out.parent().expect("bindings have a parent dir")).expect("create bindings dir");
        super::bindings()
            .export(
                specta_typescript::Typescript::default().header(
                    "// @ts-nocheck\n// Auto-generated from apps/desktop-tauri chat commands (tauri-specta).\n// Regenerate: cargo test -p rakazo-desktop generate_typescript_bindings. Do not edit by hand.\n",
                ),
                &out,
            )
            .expect("failed to write TypeScript bindings");
    }
}
