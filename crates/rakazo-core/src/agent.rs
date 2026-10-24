use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type AgentId = Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentStatus {
    Idle,
    Running,
    WaitingApproval,
    Paused,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: AgentId,
    pub name: String,
    pub status: AgentStatus,
}

impl Agent {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            status: AgentStatus::Idle,
        }
    }

    pub fn start(&mut self) {
        self.status = AgentStatus::Running;
    }

    pub fn pause(&mut self) {
        self.status = AgentStatus::Paused;
    }

    pub fn request_approval(&mut self) {
        self.status = AgentStatus::WaitingApproval;
    }

    pub fn fail(&mut self) {
        self.status = AgentStatus::Failed;
    }
}
