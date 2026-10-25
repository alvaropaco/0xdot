//! Native tool dispatch and workspace filesystem primitives.
//!
//! This module keeps concrete execution behind small traits so the agent core
//! can dispatch tools without knowing about MCP, Tauri or a particular OS.
//! The workspace filesystem adapter is intentionally capability-scoped: every
//! path is resolved beneath a canonical workspace root and traversal outside
//! that root is rejected.

use crate::{ToolCall, ToolExecutor, ToolResult};
use serde_json::json;
use std::{collections::HashMap, fs, path::{Path, PathBuf}, sync::Arc};
use thiserror::Error;

pub trait ToolHandler: Send + Sync {
    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolRuntimeError>;
}

#[derive(Debug, Error)]
pub enum ToolRuntimeError {
    #[error("handler not found: {0}")]
    HandlerNotFound(String),
    #[error("invalid tool arguments: {0}")]
    InvalidArguments(String),
    #[error("filesystem error: {0}")]
    Filesystem(String),
    #[error("path escapes workspace: {0}")]
    PathOutsideWorkspace(String),
    #[error("file exceeds limit: {0} bytes")]
    FileTooLarge(u64),
}

#[derive(Default)]
pub struct ToolRuntime {
    handlers: HashMap<String, Arc<dyn ToolHandler>>,
}

impl ToolRuntime {
    pub fn new() -> Self { Self::default() }

    pub fn register<H>(&mut self, name: impl Into<String>, handler: H)
    where H: ToolHandler + 'static {
        self.handlers.insert(name.into(), Arc::new(handler));
    }

    pub fn execute_call(&self, call: &ToolCall) -> Result<ToolResult, ToolRuntimeError> {
        self.handlers.get(&call.name)
            .ok_or_else(|| ToolRuntimeError::HandlerNotFound(call.name.clone()))?
            .execute(call)
    }
}

impl ToolExecutor for ToolRuntime {
    fn execute(&self, call: &ToolCall) -> Result<ToolResult, crate::ExecutorError> {
        self.execute_call(call).map_err(|e| crate::ExecutorError::Tool(e.to_string()))
    }
}

pub struct WorkspaceFs {
    root: PathBuf,
    max_read_bytes: u64,
    max_write_bytes: u64,
}

impl WorkspaceFs {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, ToolRuntimeError> {
        let root = fs::canonicalize(root.as_ref())
            .map_err(|e| ToolRuntimeError::Filesystem(e.to_string()))?;
        if !root.is_dir() {
            return Err(ToolRuntimeError::Filesystem("workspace root is not a directory".into()));
        }
        Ok(Self { root, max_read_bytes: 1_048_576, max_write_bytes: 4_194_304 })
    }

    pub fn with_limits(mut self, max_read_bytes: u64, max_write_bytes: u64) -> Self {
        self.max_read_bytes = max_read_bytes;
        self.max_write_bytes = max_write_bytes;
        self
    }

    pub fn root(&self) -> &Path { &self.root }

    fn resolve_existing(&self, raw: &str) -> Result<PathBuf, ToolRuntimeError> {
        let path = Path::new(raw);
        if path.is_absolute() { return Err(ToolRuntimeError::PathOutsideWorkspace(raw.into())); }
        let candidate = self.root.join(path);
        let canonical = fs::canonicalize(&candidate)
            .map_err(|e| ToolRuntimeError::Filesystem(e.to_string()))?;
        if !canonical.starts_with(&self.root) {
            return Err(ToolRuntimeError::PathOutsideWorkspace(raw.into()));
        }
        Ok(canonical)
    }

    fn resolve_for_write(&self, raw: &str) -> Result<PathBuf, ToolRuntimeError> {
        let path = Path::new(raw);
        if path.is_absolute() { return Err(ToolRuntimeError::PathOutsideWorkspace(raw.into())); }
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let parent = fs::canonicalize(self.root.join(parent))
            .map_err(|e| ToolRuntimeError::Filesystem(e.to_string()))?;
        if !parent.starts_with(&self.root) {
            return Err(ToolRuntimeError::PathOutsideWorkspace(raw.into()));
        }
        Ok(parent.join(path.file_name().ok_or_else(|| ToolRuntimeError::InvalidArguments("path must name a file".into()))?))
    }

    pub fn read_file(&self, path: &str) -> Result<String, ToolRuntimeError> {
        let path = self.resolve_existing(path)?;
        let meta = fs::metadata(&path).map_err(|e| ToolRuntimeError::Filesystem(e.to_string()))?;
        if meta.len() > self.max_read_bytes { return Err(ToolRuntimeError::FileTooLarge(meta.len())); }
        fs::read_to_string(path).map_err(|e| ToolRuntimeError::Filesystem(e.to_string()))
    }

    pub fn write_file(&self, path: &str, content: &str) -> Result<u64, ToolRuntimeError> {
        let bytes = content.as_bytes();
        if bytes.len() as u64 > self.max_write_bytes { return Err(ToolRuntimeError::FileTooLarge(bytes.len() as u64)); }
        let path = self.resolve_for_write(path)?;
        fs::write(path, bytes).map_err(|e| ToolRuntimeError::Filesystem(e.to_string()))?;
        Ok(bytes.len() as u64)
    }

    pub fn list_dir(&self, path: &str) -> Result<Vec<String>, ToolRuntimeError> {
        let path = self.resolve_existing(path)?;
        if !path.is_dir() { return Err(ToolRuntimeError::Filesystem("path is not a directory".into())); }
        let mut entries = fs::read_dir(path)
            .map_err(|e| ToolRuntimeError::Filesystem(e.to_string()))?
            .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()).map_err(|e| ToolRuntimeError::Filesystem(e.to_string())))
            .collect::<Result<Vec<_>, _>>()?;
        entries.sort();
        Ok(entries)
    }
}

pub struct ReadFileHandler { fs: Arc<WorkspaceFs> }
impl ReadFileHandler { pub fn new(fs: Arc<WorkspaceFs>) -> Self { Self { fs } } }
impl ToolHandler for ReadFileHandler {
    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolRuntimeError> {
        let path = call.arguments.get("path").and_then(|v| v.as_str()).ok_or_else(|| ToolRuntimeError::InvalidArguments("missing string argument: path".into()))?;
        Ok(ToolResult { success: true, output: json!({"path": path, "content": self.fs.read_file(path)?}) })
    }
}

pub struct WriteFileHandler { fs: Arc<WorkspaceFs> }
impl WriteFileHandler { pub fn new(fs: Arc<WorkspaceFs>) -> Self { Self { fs } } }
impl ToolHandler for WriteFileHandler {
    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolRuntimeError> {
        let path = call.arguments.get("path").and_then(|v| v.as_str()).ok_or_else(|| ToolRuntimeError::InvalidArguments("missing string argument: path".into()))?;
        let content = call.arguments.get("content").and_then(|v| v.as_str()).ok_or_else(|| ToolRuntimeError::InvalidArguments("missing string argument: content".into()))?;
        let bytes = self.fs.write_file(path, content)?;
        Ok(ToolResult { success: true, output: json!({"path": path, "bytes_written": bytes}) })
    }
}

pub struct ListDirHandler { fs: Arc<WorkspaceFs> }
impl ListDirHandler { pub fn new(fs: Arc<WorkspaceFs>) -> Self { Self { fs } } }
impl ToolHandler for ListDirHandler {
    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolRuntimeError> {
        let path = call.arguments.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        Ok(ToolResult { success: true, output: json!({"path": path, "entries": self.fs.list_dir(path)?}) })
    }
}

pub fn register_workspace_tools(runtime: &mut ToolRuntime, fs: Arc<WorkspaceFs>) {
    runtime.register("filesystem.read_file", ReadFileHandler::new(fs.clone()));
    runtime.register("filesystem.write_file", WriteFileHandler::new(fs.clone()));
    runtime.register("filesystem.list_dir", ListDirHandler::new(fs));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn reads_lists_and_writes_inside_workspace() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("hello.txt"), "hello").unwrap();
        let fs = Arc::new(WorkspaceFs::new(dir.path()).unwrap());
        let mut runtime = ToolRuntime::new();
        register_workspace_tools(&mut runtime, fs);

        let read = runtime.execute_call(&ToolCall { name: "filesystem.read_file".into(), arguments: json!({"path":"hello.txt"}) }).unwrap();
        assert_eq!(read.output["content"], "hello");
        let list = runtime.execute_call(&ToolCall { name: "filesystem.list_dir".into(), arguments: json!({"path":"."}) }).unwrap();
        assert_eq!(list.output["entries"][0], "hello.txt");
        let write = runtime.execute_call(&ToolCall { name: "filesystem.write_file".into(), arguments: json!({"path":"nested/out.txt", "content":"ok"}) });
        assert!(write.is_err(), "parent creation is intentionally not implicit");
        fs::create_dir(dir.path().join("nested")).unwrap();
        runtime.execute_call(&ToolCall { name: "filesystem.write_file".into(), arguments: json!({"path":"nested/out.txt", "content":"ok"}) }).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("nested/out.txt")).unwrap(), "ok");
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let dir = tempdir().unwrap();
        let fs = WorkspaceFs::new(dir.path()).unwrap();
        assert!(matches!(fs.read_file("../secret"), Err(ToolRuntimeError::Filesystem(_)) | Err(ToolRuntimeError::PathOutsideWorkspace(_))));
        assert!(matches!(fs.write_file("../secret", "x"), Err(ToolRuntimeError::PathOutsideWorkspace(_))));
        assert!(matches!(fs.write_file("/tmp/secret", "x"), Err(ToolRuntimeError::PathOutsideWorkspace(_))));
    }

    #[test]
    fn enforces_read_and_write_limits() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("big.txt"), "123456").unwrap();
        let fs = WorkspaceFs::new(dir.path()).unwrap().with_limits(5, 5);
        assert!(matches!(fs.read_file("big.txt"), Err(ToolRuntimeError::FileTooLarge(6))));
        assert!(matches!(fs.write_file("out.txt", "123456"), Err(ToolRuntimeError::FileTooLarge(6))));
    }

    #[test]
    #[cfg(unix)]
    fn rejects_symlink_escape() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        let fs = WorkspaceFs::new(root.path()).unwrap();
        assert!(matches!(fs.read_file("link/secret.txt"), Err(ToolRuntimeError::PathOutsideWorkspace(_))));
    }
}
