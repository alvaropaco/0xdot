use rakazo_core::{ComputerPermissions, ComputerToolRuntime, ToolCall};
use std::sync::Arc;

#[cfg(target_os = "macos")]
pub fn execute(call: ToolCall) -> Result<serde_json::Value, String> {
    let backend = rakazo_host::native_backend();
    let runtime = ComputerToolRuntime::new(Arc::new(rakazo_core::ComputerRuntime::new(
        backend,
        ComputerPermissions::all(),
    )));
    runtime
        .execute(&call)
        .map(|result| serde_json::to_value(result).unwrap_or_else(|_| serde_json::json!({"success": false})))
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn execute(_call: ToolCall) -> Result<serde_json::Value, String> {
    Err("native computer automation is not implemented for this platform yet".into())
}
