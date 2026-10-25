//! Native Rakazo agent runtime primitives.
//!
//! This crate contains domain state and deterministic runtime behavior only.
//! OS integrations, networking, persistence and model providers belong in
//! adapter crates so the same core can run in Tauri, server and CLI environments.

pub mod agent;
pub mod event;
pub mod runtime;
pub mod task;

pub use agent::{Agent, AgentId, AgentStatus};
pub use event::{Event, EventBus};
pub use runtime::{AgentRuntime, RuntimeError, RuntimeSnapshot};
pub use task::{Task, TaskId, TaskStatus};

#[cfg(test)]
mod tests;
