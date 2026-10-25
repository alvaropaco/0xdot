//! Native Rakazo agent runtime primitives.
//!
//! This crate contains domain state and deterministic runtime behavior only.
//! OS integrations, networking, persistence and model providers belong in
//! adapter crates so the same core can run in Tauri, server and CLI environments.

pub mod agent;
pub mod computer;
pub mod computer_automation;
pub mod computer_tools;
pub mod event;
pub mod executor;
pub mod memory;
pub mod model;
pub mod runtime;
pub mod task;
pub mod tool;
pub mod tool_runtime;

pub use agent::{Agent, AgentId, AgentStatus};
pub use computer::{register_computer_definitions, register_computer_tools, CommandPolicy, ComputerRuntimeError, ProcessHandler, ProcessRuntime};
pub use computer_automation::{ComputerAutomationError, ComputerBackend, ComputerCapability, ComputerPermissions, ComputerRuntime, KeyboardAction, MouseAction, MouseButton, ScreenCapture, WindowInfo};
pub use computer_tools::{register_computer_automation_definitions, ComputerToolError, ComputerToolRuntime};
pub use event::{Event, EventBus};
pub use executor::{AgentExecutor, ApprovalDecision, ApprovalGate, ExecutionInput, ExecutionOutput, ExecutorError, ToolExecutor};
pub use memory::{MemoryError, MemoryId, MemoryMatch, MemoryQuery, MemoryRecord, MemoryStore};
pub use model::{MessageRole, ModelError, ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelUsage};
pub use runtime::{AgentRuntime, RuntimeError, RuntimeSnapshot};
pub use task::{Task, TaskId, TaskStatus};
pub use tool::{ToolCall, ToolDefinition, ToolRegistry, ToolRegistryError, ToolResult, ToolRisk};
pub use tool_runtime::{register_workspace_tools, ListDirHandler, ReadFileHandler, ToolHandler, ToolRuntime, ToolRuntimeError, WorkspaceFs, WriteFileHandler};

#[cfg(test)]
mod tests;
