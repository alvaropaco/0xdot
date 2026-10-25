use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::agent::AgentStatus;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum Event {
    AgentCreated { agent_id: Uuid },
    AgentStarted { agent_id: Uuid },
    AgentPaused { agent_id: Uuid },
    AgentStatusChanged { agent_id: Uuid, status: AgentStatus },
    TaskCreated { task_id: Uuid, agent_id: Uuid },
    TaskUpdated { task_id: Uuid },
    ApprovalRequested { task_id: Uuid },
    TaskCompleted { task_id: Uuid },
    TaskFailed { task_id: Uuid, error: String },
}

#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<Event>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    pub fn publish(&self, event: Event) -> Result<usize, broadcast::error::SendError<Event>> {
        self.sender.send(event)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.sender.subscribe()
    }
}
