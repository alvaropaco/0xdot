//! In-process orchestration runtime for the native Rakazo core.
//!
//! The runtime owns lifecycle transitions and emits domain events. Persistence,
//! model providers, MCP, networking and OS integrations remain outside this
//! crate so the same runtime can be embedded by Tauri, CLI and server workers.

use crate::{Agent, AgentId, AgentStatus, Event, EventBus, Task, TaskId, TaskStatus};
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
    #[error("runtime state lock poisoned")]
    StatePoisoned,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeSnapshot {
    pub agents: Vec<Agent>,
    pub tasks: Vec<Task>,
}

#[derive(Debug, Default)]
struct RuntimeState {
    agents: HashMap<AgentId, Agent>,
    tasks: HashMap<TaskId, Task>,
}

#[derive(Clone)]
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
            events: EventBus::new(1024),
        }
    }

    pub fn events(&self) -> EventBus {
        self.events.clone()
    }

    pub fn register_agent(&self, agent: Agent) -> Result<AgentId, RuntimeError> {
        let id = agent.id;
        let mut state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
        state.agents.insert(id, agent);
        drop(state);
        let _ = self.events.publish(Event::AgentCreated { agent_id: id });
        Ok(id)
    }

    pub fn set_agent_status(&self, id: AgentId, status: AgentStatus) -> Result<(), RuntimeError> {
        let mut state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
        let agent = state
            .agents
            .get_mut(&id)
            .ok_or(RuntimeError::AgentNotFound(id))?;
        agent.status = status;
        drop(state);
        let _ = self.events.publish(match status {
            AgentStatus::Running => Event::AgentStarted { agent_id: id },
            AgentStatus::Paused => Event::AgentPaused { agent_id: id },
            _ => Event::AgentStatusChanged {
                agent_id: id,
                status,
            },
        });
        Ok(())
    }

    pub fn enqueue_task(&self, task: Task) -> Result<TaskId, RuntimeError> {
        let id = task.id;
        let agent_id = task.agent_id;
        let mut state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
        if !state.agents.contains_key(&agent_id) {
            return Err(RuntimeError::AgentNotFound(agent_id));
        }
        state.tasks.insert(id, task);
        drop(state);
        let _ = self.events.publish(Event::TaskCreated {
            task_id: id,
            agent_id,
        });
        Ok(id)
    }

    pub fn set_task_status(&self, id: TaskId, status: TaskStatus) -> Result<(), RuntimeError> {
        let mut state = self.state.lock().map_err(|_| RuntimeError::StatePoisoned)?;
        let task = state
            .tasks
            .get_mut(&id)
            .ok_or(RuntimeError::TaskNotFound(id))?;
        task.transition(status);
        let event = match task.status {
            TaskStatus::WaitingApproval => Event::ApprovalRequested { task_id: id },
            TaskStatus::Completed => Event::TaskCompleted { task_id: id },
            TaskStatus::Failed => Event::TaskFailed {
                task_id: id,
                error: "task failed".into(),
            },
            _ => Event::TaskUpdated { task_id: id },
        };
        drop(state);
        let _ = self.events.publish(event);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_agent_and_enqueues_task() {
        let runtime = AgentRuntime::new();
        let agent_id = runtime.register_agent(Agent::new("Test agent")).unwrap();
        let task_id = runtime
            .enqueue_task(Task::new(agent_id, "run test"))
            .unwrap();
        let snapshot = runtime.snapshot().unwrap();
        assert_eq!(snapshot.agents.len(), 1);
        assert_eq!(snapshot.tasks[0].id, task_id);
    }

    #[test]
    fn rejects_tasks_for_unknown_agents() {
        let runtime = AgentRuntime::new();
        let error = runtime
            .enqueue_task(Task::new(uuid::Uuid::new_v4(), "invalid"))
            .unwrap_err();
        assert!(matches!(error, RuntimeError::AgentNotFound(_)));
    }

    #[test]
    fn emits_task_lifecycle_events() {
        let runtime = AgentRuntime::new();
        let mut events = runtime.events().subscribe();
        let agent_id = runtime.register_agent(Agent::new("Event agent")).unwrap();
        let task_id = runtime
            .enqueue_task(Task::new(agent_id, "observe"))
            .unwrap();
        runtime
            .set_task_status(task_id, TaskStatus::Completed)
            .unwrap();

        assert!(matches!(
            events.try_recv().unwrap(),
            Event::AgentCreated { .. }
        ));
        assert!(matches!(
            events.try_recv().unwrap(),
            Event::TaskCreated { .. }
        ));
        assert!(matches!(
            events.try_recv().unwrap(),
            Event::TaskCompleted { .. }
        ));
    }
}
