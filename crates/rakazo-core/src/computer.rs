//! Capability-scoped computer primitives for the native Rakazo runtime.

use crate::{ToolCall, ToolDefinition, ToolExecutor, ToolRegistry, ToolResult, ToolRisk};
use serde_json::json;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
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
    #[error("command timed out after {0} ms")]
    Timeout(u128),
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
    pub fn new(
        workspace: impl AsRef<Path>,
        policy: CommandPolicy,
    ) -> Result<Self, ComputerRuntimeError> {
        let workspace = std::fs::canonicalize(workspace.as_ref())
            .map_err(|e| ComputerRuntimeError::Filesystem(e.to_string()))?;
        if !workspace.is_dir() {
            return Err(ComputerRuntimeError::Filesystem(
                "workspace is not a directory".into(),
            ));
        }
        Ok(Self { workspace, policy })
    }

    fn resolve_workdir(&self, raw: Option<&str>) -> Result<PathBuf, ComputerRuntimeError> {
        let raw = raw.unwrap_or(".");
        let path = Path::new(raw);
        if path.is_absolute() {
            return Err(ComputerRuntimeError::PathOutsideWorkspace(raw.into()));
        }
        let canonical = std::fs::canonicalize(self.workspace.join(path))
            .map_err(|e| ComputerRuntimeError::Filesystem(e.to_string()))?;
        if !canonical.starts_with(&self.workspace) || !canonical.is_dir() {
            return Err(ComputerRuntimeError::PathOutsideWorkspace(raw.into()));
        }
        Ok(canonical)
    }

    pub fn run(&self, call: &ToolCall) -> Result<ToolResult, ComputerRuntimeError> {
        let program = call
            .arguments
            .get("program")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                ComputerRuntimeError::InvalidArguments("missing string argument: program".into())
            })?;
        if !self.policy.allows(program) {
            return Err(ComputerRuntimeError::CommandNotAllowed(program.into()));
        }
        let args = match call.arguments.get("args") {
            None => Vec::new(),
            Some(value) => value
                .as_array()
                .ok_or_else(|| {
                    ComputerRuntimeError::InvalidArguments(
                        "argument 'args' must be an array of strings".into(),
                    )
                })?
                .iter()
                .map(|v| {
                    v.as_str().ok_or_else(|| {
                        ComputerRuntimeError::InvalidArguments(
                            "argument 'args' must contain only strings".into(),
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
        };
        let workdir =
            self.resolve_workdir(call.arguments.get("workdir").and_then(|v| v.as_str()))?;

        let mut child = Command::new(program)
            .args(args)
            .current_dir(workdir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| ComputerRuntimeError::Execution(e.to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ComputerRuntimeError::Execution("failed to capture stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ComputerRuntimeError::Execution("failed to capture stderr".into()))?;
        let stdout_buffer = Arc::new(Mutex::new(Vec::new()));
        let stderr_buffer = Arc::new(Mutex::new(Vec::new()));
        let out_target = Arc::clone(&stdout_buffer);
        let err_target = Arc::clone(&stderr_buffer);
        let max = self.policy.max_output_bytes;
        let out_thread = thread::spawn(move || read_capped(stdout, out_target, max));
        let err_thread = thread::spawn(move || read_capped(stderr, err_target, max));

        let started = Instant::now();
        let status = loop {
            match child
                .try_wait()
                .map_err(|e| ComputerRuntimeError::Execution(e.to_string()))?
            {
                Some(status) => break status,
                None if started.elapsed() >= self.policy.timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_thread.join();
                    let _ = err_thread.join();
                    return Err(ComputerRuntimeError::Timeout(
                        self.policy.timeout.as_millis(),
                    ));
                }
                None => thread::sleep(Duration::from_millis(10)),
            }
        };
        out_thread
            .join()
            .map_err(|_| ComputerRuntimeError::Execution("stdout reader panicked".into()))?
            .map_err(|e| ComputerRuntimeError::Execution(format!("stdout read failed: {e}")))?;
        err_thread
            .join()
            .map_err(|_| ComputerRuntimeError::Execution("stderr reader panicked".into()))?
            .map_err(|e| ComputerRuntimeError::Execution(format!("stderr read failed: {e}")))?;
        let stdout = stdout_buffer
            .lock()
            .map_err(|_| ComputerRuntimeError::Execution("stdout buffer poisoned".into()))?
            .clone();
        let stderr = stderr_buffer
            .lock()
            .map_err(|_| ComputerRuntimeError::Execution("stderr buffer poisoned".into()))?
            .clone();
        Ok(ToolResult {
            success: status.success(),
            output: json!({"exit_code": status.code(), "stdout": String::from_utf8_lossy(&stdout), "stderr": String::from_utf8_lossy(&stderr), "truncated": stdout.len() >= max || stderr.len() >= max}),
        })
    }
}

fn read_capped<R: Read>(
    mut reader: R,
    target: Arc<Mutex<Vec<u8>>>,
    max: usize,
) -> Result<(), std::io::Error> {
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let mut target = target
            .lock()
            .map_err(|_| std::io::Error::other("buffer poisoned"))?;
        let remaining = max.saturating_sub(target.len());
        if remaining > 0 {
            target.extend_from_slice(&buffer[..count.min(remaining)]);
        }
    }
    Ok(())
}

pub struct ProcessHandler {
    runtime: Arc<ProcessRuntime>,
}
impl ProcessHandler {
    pub fn new(runtime: Arc<ProcessRuntime>) -> Self {
        Self { runtime }
    }
}
impl crate::tool_runtime::ToolHandler for ProcessHandler {
    fn execute(
        &self,
        call: &ToolCall,
    ) -> Result<ToolResult, crate::tool_runtime::ToolRuntimeError> {
        self.runtime
            .run(call)
            .map_err(|e| crate::tool_runtime::ToolRuntimeError::Filesystem(e.to_string()))
    }
}

pub fn register_computer_tools(
    runtime: &mut crate::tool_runtime::ToolRuntime,
    process: Arc<ProcessRuntime>,
) {
    runtime.register("computer.run", ProcessHandler::new(process));
}

pub fn register_computer_definitions(
    registry: &mut ToolRegistry,
) -> Result<(), crate::ToolRegistryError> {
    registry.register(ToolDefinition {
        name: "computer.run".into(),
        description: "Run an allowlisted executable inside the agent workspace.".into(),
        risk: ToolRisk::Mutating,
        requires_approval: true,
    })
}

impl ToolExecutor for ProcessRuntime {
    fn execute(&self, call: &ToolCall) -> Result<ToolResult, crate::ExecutorError> {
        self.run(call)
            .map_err(|e| crate::ExecutorError::Tool(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_non_allowlisted_programs() {
        let dir = tempdir().unwrap();
        let runtime = ProcessRuntime::new(dir.path(), CommandPolicy::new(["rustc"])).unwrap();
        let denied = runtime.run(&ToolCall {
            name: "computer.run".into(),
            arguments: json!({"program":"sh","args":["-c","echo nope"]}),
        });
        assert!(matches!(
            denied,
            Err(ComputerRuntimeError::CommandNotAllowed(_))
        ));
    }

    #[test]
    fn rejects_absolute_and_escaping_workdirs() {
        let dir = tempdir().unwrap();
        let runtime = ProcessRuntime::new(dir.path(), CommandPolicy::new(["rustc"])).unwrap();
        assert!(matches!(
            runtime.run(&ToolCall {
                name: "computer.run".into(),
                arguments: json!({"program":"rustc","workdir":"/tmp"})
            }),
            Err(ComputerRuntimeError::PathOutsideWorkspace(_))
        ));
        assert!(matches!(
            runtime.run(&ToolCall {
                name: "computer.run".into(),
                arguments: json!({"program":"rustc","workdir":"../"})
            }),
            Err(ComputerRuntimeError::PathOutsideWorkspace(_))
        ));
    }

    #[test]
    fn rejects_malformed_arguments() {
        let dir = tempdir().unwrap();
        let runtime = ProcessRuntime::new(dir.path(), CommandPolicy::new(["rustc"])).unwrap();
        assert!(matches!(
            runtime.run(&ToolCall {
                name: "computer.run".into(),
                arguments: json!({"program":"rustc","args":"bad"})
            }),
            Err(ComputerRuntimeError::InvalidArguments(_))
        ));
    }

    #[test]
    fn times_out_long_running_process() {
        let dir = tempdir().unwrap();
        let program = if cfg!(windows) { "ping" } else { "sleep" };
        let args = if cfg!(windows) {
            vec!["127.0.0.1", "2"]
        } else {
            vec!["2"]
        };
        let runtime = ProcessRuntime::new(
            dir.path(),
            CommandPolicy::new([program]).with_limits(1024, Duration::from_millis(50)),
        )
        .unwrap();
        let result = runtime.run(&ToolCall {
            name: "computer.run".into(),
            arguments: json!({"program":program,"args":args}),
        });
        assert!(matches!(result, Err(ComputerRuntimeError::Timeout(_))));
    }
}
