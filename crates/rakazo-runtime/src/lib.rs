//! Native orchestration runtime.
//!
//! This layer owns lifecycle transitions and execution boundaries. It deliberately
//! does not know about PostgreSQL, HTTP, model providers, or operating-system APIs.
//! Those concerns are injected later through adapters.

use rakazo_core::{Agent, AgentId, AgentStatus, Event, EventBus, Task, TaskId, TaskStatus};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("agent not found: {0:?}")]
    AgentNotFound(AgentId),
    #[error("task not found: {0:?}")]
    TaskNotFound(TaskId),
    #[error("invalid lifecycle transition: {0}")]
    InvalidTransition(String),
    #[error("runtime state lock poisoned")]
    StatePoisoned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeSnapshot {
    pub agents: Vec<Agent>,
    pub tasks: Vec<Task>,
}

#[derive(Debug, Default)]
struct RuntimeState {
    agents: HashMap<AgentId, Agent>,
    tasks: HashMap<TaskId, Task>,
}

/// Thread-safe in-process agent runtime.
///
/// The runtime is intentionally deterministic and adapter-free. A future Tauri
/// application, CLI, or server worker can embed the same runtime instance.
pub struct AgentRuntime {
    state: Arc<Mutex<RuntimeState>>,
    events: EventBus,
}

impl Default for AgentRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentRuntime {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(RuntimeState::default())),
            events: EventBus::default(),
        }
    }

    pub fn events(&self) -> EventBus {
        self.events.clone()
    }

    pub fn register_agent(&self, agent: Agent) -> Result<AgentId, RuntimeError> {
        let id = agent.id.clone();
        let mut state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
        state.agents.insert(id.clone(), agent);
        drop(state);
        self.events.publish(Event::AgentRegistered { agent_id: id.clone() });
        Ok(id)
    }

    pub fn set_agent_status(
        &self,
        id: &AgentId,
        status: AgentStatus,
    ) -> Result<(), RuntimeError> {
        let mut state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
        let agent = state
            .agents
            .get_mut(id)
            .ok_or_else(|| RuntimeError::AgentNotFound(id.clone()))?;
        agent.status = status.clone();
        drop(state);
        self.events.publish(Event::AgentStatusChanged {
            agent_id: id.clone(),
            status,
        });
        Ok(())
    }

    pub fn enqueue_task(&self, task: Task) -> Result<TaskId, RuntimeError> {
        let id = task.id.clone();
        let mut state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
        state.tasks.insert(id.clone(), task);
        drop(state);
        self.events.publish(Event::TaskQueued { task_id: id.clone() });
        Ok(id)
    }

    pub fn set_task_status(
        &self,
        id: &TaskId,
        status: TaskStatus,
    ) -> Result<(), RuntimeError> {
        let mut state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
        let task = state
            .tasks
            .get_mut(id)
            .ok_or_else(|| RuntimeError::TaskNotFound(id.clone()))?;
        task.status = status.clone();
        drop(state);
        self.events.publish(Event::TaskStatusChanged {
            task_id: id.clone(),
            status,
        });
        Ok(())
    }

    pub fn snapshot(&self) -> Result<RuntimeSnapshot, RuntimeError> {
        let state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
        Ok(RuntimeSnapshot {
            agents: state.agents.values().cloned().collect(),
            tasks: state.tasks.values().cloned().collect(),
        })
    }
}
