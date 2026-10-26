use rakazo_core::RuntimeSnapshot;
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionRecord {
    pub task_id: String,
    pub content: String,
    pub tool_calls: usize,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistedAgentState {
    pub snapshot: Option<RuntimeSnapshot>,
    pub history: Vec<ExecutionRecord>,
}

pub struct AgentStateStore {
    path: PathBuf,
}

impl AgentStateStore {
    pub fn new(app_data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let dir = app_data_dir.as_ref();
        fs::create_dir_all(dir).map_err(|e| format!("failed to create agent state directory: {e}"))?;
        Ok(Self { path: dir.join("agent-state.json") })
    }

    pub fn load(&self) -> Result<PersistedAgentState, String> {
        if !self.path.exists() {
            return Ok(PersistedAgentState::default());
        }
        let bytes = fs::read(&self.path).map_err(|e| format!("failed to read agent state: {e}"))?;
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid agent state: {e}"))
    }

    pub fn save(&self, state: &PersistedAgentState) -> Result<(), String> {
        let temp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(state).map_err(|e| format!("failed to serialize agent state: {e}"))?;
        fs::write(&temp, bytes).map_err(|e| format!("failed to write agent state: {e}"))?;
        fs::rename(&temp, &self.path).map_err(|e| format!("failed to commit agent state: {e}"))
    }

    pub fn record(&self, snapshot: RuntimeSnapshot, execution: ExecutionRecord) -> Result<PersistedAgentState, String> {
        let mut state = self.load()?;
        state.snapshot = Some(snapshot);
        state.history.push(execution);
        const MAX_HISTORY: usize = 100;
        if state.history.len() > MAX_HISTORY {
            let remove = state.history.len() - MAX_HISTORY;
            state.history.drain(0..remove);
        }
        self.save(&state)?;
        Ok(state)
    }
}
