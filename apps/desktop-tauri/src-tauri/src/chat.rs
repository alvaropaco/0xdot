//! Local chat commands (migration plan M1): the IPC surface the bundled web
//! UI drives instead of oRPC. Threads persist in SQLite; a turn runs the Rust
//! agent loop on the blocking pool and streams assistant text back through
//! `chat://delta` events, so the transcript survives a restart.

use crate::{agent_bridge, chat_store::{Bot, ChatMessage, ChatStore, ChatThread, KEY_API_KEY, KEY_BASE_URL, KEY_DEFAULT_MODEL}, mcp_state::McpState};
use rakazo_core::{ApprovalDecision, ApprovalGate, ExecutorError, MessageRole, ModelMessage, StreamCallback, TaskId, ToolCall};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// The chat workspace lives under the app's own data directory, so the slice
/// can auto-approve file writes today; the approval UI arrives with M2.
pub struct AutoApprove;
impl ApprovalGate for AutoApprove {
    fn request(&self, _task_id: TaskId, _call: &ToolCall) -> Result<ApprovalDecision, ExecutorError> {
        Ok(ApprovalDecision::Approved)
    }
}

pub const EVENT_DELTA: &str = "chat://delta";
pub const EVENT_DONE: &str = "chat://done";
pub const EVENT_ERROR: &str = "chat://error";

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

/// The tauri-specta surface for the chat commands; a test exports the
/// generated TypeScript bindings so the web adapter stays in lockstep with
/// Rust. Event payloads (`ChatDelta`/`ChatDone`/`ChatFailed` on the
/// `chat://*` topics) mirror chat.rs by hand in the adapter — only the
/// command surface is code-generated today.
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
        chat_send
    ])
}

/// Persists the user message, accepts immediately, and drives the agent turn
/// in the background: deltas stream through events and the assistant reply is
/// written when the run finishes.
#[tauri::command]
#[specta::specta]
pub async fn chat_send(app: AppHandle, store: State<'_, ChatStore>, mcp: State<'_, McpState>, thread_id: String, content: String) -> Result<SendAccepted, String> {
    let store = store.inner().clone();
    let mcp = mcp.inner().clone();
    let thread = store.thread(&thread_id).await?;
    let bot = store.bot(&thread.bot_id).await?;
    if content.trim().is_empty() {
        return Err("message is empty".into());
    }
    let (base_url, api_key) = store.connection().await?.ok_or_else(|| "no model connection configured".to_string())?;
    let model = store.resolve_model(&bot).await?;
    // Memory is keyed by the bot id so what one conversation remembers is
    // available to every later thread with the same bot.
    let agent_id = uuid::Uuid::parse_str(&bot.id).map_err(|e| e.to_string())?;
    let prior = store.messages(&thread_id).await?;
    let user = store.append_message(&thread_id, "user", &content, false).await?;
    let history: Vec<ModelMessage> = prior.iter().filter_map(|message| match message.role.as_str() {
        "user" => Some(ModelMessage { role: MessageRole::User, content: message.content.clone() }),
        "assistant" if !message.failed => Some(ModelMessage { role: MessageRole::Assistant, content: message.content.clone() }),
        _ => None,
    }).collect();
    let system_prompt = (!bot.system_prompt.trim().is_empty()).then(|| bot.system_prompt.clone());
    let app_data = crate::app_data_dir(&app)?;
    let workspace = app_data.join("workspaces").join(&bot.id);
    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    let memory_path = app_data.join("memory.json");

    let stream: StreamCallback = {
        let app = app.clone();
        let thread_id = thread_id.clone();
        Arc::new(move |text: &str| {
            let _ = app.emit(EVENT_DELTA, ChatDelta { thread_id: thread_id.clone(), text: text.to_string() });
        })
    };
    let accepted = SendAccepted { message_id: user.id };
    let run = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let provider = agent_bridge::provider_from_connection(&base_url, &api_key)?;
        let (runtime, _registered, task) = agent_bridge::new_runtime_task(content.clone())?;
        let task_id = task.id;
        runtime.enqueue_task(task).map_err(|e| e.to_string())?;
        agent_bridge::execute_with_runtime(&provider, runtime, agent_id, task_id, model, content, system_prompt, None, None, Arc::new(AutoApprove), workspace, memory_path, mcp, history, Some(stream), false).map(|result| result.content)
    });
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = match run.await {
            Ok(inner) => inner,
            Err(join) => Err(format!("agent task panicked: {join}")),
        };
        match outcome {
            Ok(text) => {
                match store.append_message(&thread_id, "assistant", &text, false).await {
                    Ok(message) => {
                        let _ = app_for_task.emit(EVENT_DONE, ChatDone { thread_id, message_id: message.id });
                    }
                    Err(error) => {
                        let _ = app_for_task.emit(EVENT_ERROR, ChatFailed { thread_id, message: error });
                    }
                }
            }
            Err(error) => {
                if store.append_message(&thread_id, "assistant", &error, true).await.is_ok() {
                    let _ = app_for_task.emit(EVENT_ERROR, ChatFailed { thread_id, message: error });
                }
            }
        }
    });
    Ok(accepted)
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
