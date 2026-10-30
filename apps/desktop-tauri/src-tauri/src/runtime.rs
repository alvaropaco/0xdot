//! The identity of the embedded runtime the local UI talks to. Health is the
//! first command on the runtime IPC surface; the chat/threads commands join it
//! as the Rust milestones land (docs/rust-desktop-migration.md).

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct RuntimeHealth {
    /// `local` when the app serves its own runtime; `remote` while the webview
    /// is pointed at an external 0xdot server.
    pub mode: &'static str,
    pub version: String,
    /// The remote origin in remote mode; None locally.
    pub origin: Option<String>,
    /// True once the runtime exposes the chat commands (milestone M1). The UI
    /// keys its startup screen off this flag: local renders the native chat,
    /// remote keeps the oRPC surface.
    #[serde(rename = "rpcReady")]
    pub rpc_ready: bool,
}

#[tauri::command]
pub fn runtime_health(app: tauri::AppHandle) -> RuntimeHealth {
    let origin = crate::server::server_origin(&app);
    RuntimeHealth {
        mode: if origin.is_some() { "remote" } else { "local" },
        version: app.package_info().version.to_string(),
        origin,
        rpc_ready: true,
    }
}
