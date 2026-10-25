//! Capability-scoped computer primitives for the native Rakazo runtime.
//!
//! This module deliberately stops at a policy boundary: it models safe
//! process execution and working-directory access, but does not expose a
//! generic shell. OS/UI automation can be layered on top later.

use crate::{ToolCall, ToolExecutor, ToolResult};
use serde_json::json;
use std::{path::{Path, PathBuf}, process::Command, sync::Arc, time::Duration};
use thiserror::Error;

const DEFAULT_MAX_OUTPUT_BYTES: usize = 64 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Error)]
pub enum ComputerRuntimeError {
    #[error("invalid tool arguments: {0}")]
    InvalidArguments(String),
    #[error("working directory escapes workspace: {0}")]
    PathOutsideWorkspace(String),
    #[error("filesystem error: {0}")]
    Filesystem(String),
    #[error("command is not allowed: {0}")]
    CommandNotAllowed(String),
    #[error("command execution failed: {0}")]
    Execution(String),
}

#[derive(Clone, Debug)]
pub struct CommandPolicy {
    allowed_programs: Arc<Vec<String>>,
    max_output_bytes: usize,
    timeout: Duration,
}

impl CommandPolicy {
    pub fn new(allowed_programs: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            allowed_programs: Arc::new(allowed_programs.into_iter().map(Into::into).collect()),
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub fn with_limits(mut self, max_output_bytes: usize, timeout: Duration) -> Self {
        self.max_output_bytes = max_output_bytes;
        self.timeout = timeout;
        self
    }

    fn allows(&self, program: &str) -> bool {
        self.allowed_programs.iter().any(|item| item == program)
    }
}

pub struct ProcessRuntime {
    workspace: PathBuf,
    policy: CommandPolicy,
}

impl ProcessRuntime {
    pub fn new(workspace: impl AsRef<Path>, policy: CommandPolicy) -> Result<Self, ComputerRuntimeError> {
        let workspace = std::fs::canonicalize(workspace.as_ref())
            .map_err(|e| ComputerRuntimeError::Filesystem(e.to_string()))?;
        if !workspace.is_dir() {
            return Err(ComputerRuntimeError::Filesystem("workspace is not a directory".into()));
        }
        Ok(Self { workspace, policy })
    }

    fn resolve_workdir(&self, raw: Option<&str>) -> Result<PathBuf, ComputerRuntimeError> {
        let raw = raw.unwrap_or(".");
        let path = Path::new(raw);
        if path.is_absolute() {
            return Err(ComputerRuntimeError::PathOutsideWorkspace(raw.into()));
        }
        let candidate = self.workspace.join(path);
        let canonical = std::fs::canonicalize(&candidate)
            .map_err(|e| ComputerRuntimeError::Filesystem(e.to_string()))?;
        if !canonical.starts_with(&self.workspace) || !canonical.is_dir() {
            return Err(ComputerRuntimeError::PathOutsideWorkspace(raw.into()));
        }
        Ok(canonical)
    }

    pub fn run(&self, call: &ToolCall) -> Result<ToolResult, ComputerRuntimeError> {
        let program = call.arguments.get("program").and_then(|v| v.as_str())
            .ok_or_else(|| ComputerRuntimeError::InvalidArguments("missing string argument: program".into()))?;
        if !self.policy.allows(program) {
            return Err(ComputerRuntimeError::CommandNotAllowed(program.into()));
        }
        let args = call.arguments.get("args").and_then(|v| v.as_array())
            .map(|values| values.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
            .unwrap_or_default();
        let workdir = self.resolve_workdir(call.arguments.get("workdir").and_then(|v| v.as_str()))?;

        // std::process::Command does not provide a portable timeout primitive.
        // The policy timeout is retained in the runtime contract; the current
        // synchronous implementation relies on the caller to enforce the
        // outer execution deadline. This avoids introducing an async runtime
        // into the core tool boundary.
        let _timeout = self.policy.timeout;
        let output = Command::new(program)
            .args(args)
            .current_dir(workdir)
            .output()
            .map_err(|e| ComputerRuntimeError::Execution(e.to_string()))?;

        let mut stdout = output.stdout;
        let mut stderr = output.stderr;
        stdout.truncate(self.policy.max_output_bytes);
        stderr.truncate(self.policy.max_output_bytes);
        Ok(ToolResult {
            success: output.status.success(),
            output: json!({
                "exit_code": output.status.code(),
                "stdout": String::from_utf8_lossy(&stdout),
                "stderr": String::from_utf8_lossy(&stderr),
                "truncated": output.stdout.len() > self.policy.max_output_bytes || output.stderr.len() > self.policy.max_output_bytes,
            }),
        })
    }
}

impl ToolExecutor for ProcessRuntime {
    fn execute(&self, call: &ToolCall) -> Result<ToolResult, crate::ExecutorError> {
        self.run(call).map_err(|e| crate::ExecutorError::Tool(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn executes_only_allowlisted_programs() {
        let dir = tempdir().unwrap();
        let policy = CommandPolicy::new(["rustc"]);
        let runtime = ProcessRuntime::new(dir.path(), policy).unwrap();
        let denied = runtime.run(&ToolCall { name: "computer.run".into(), arguments: json!({"program":"sh","args":["-c","echo nope"]}) });
        assert!(matches!(denied, Err(ComputerRuntimeError::CommandNotAllowed(_))));
    }

    #[test]
    fn rejects_absolute_and_escaping_workdirs() {
        let dir = tempdir().unwrap();
        let runtime = ProcessRuntime::new(dir.path(), CommandPolicy::new(["rustc"])).unwrap();
        assert!(matches!(runtime.run(&ToolCall { name: "computer.run".into(), arguments: json!({"program":"rustc","workdir":"/tmp"}) }), Err(ComputerRuntimeError::PathOutsideWorkspace(_))));
        assert!(matches!(runtime.run(&ToolCall { name: "computer.run".into(), arguments: json!({"program":"rustc","workdir":"../"}) }), Err(ComputerRuntimeError::PathOutsideWorkspace(_))));
    }
}
