//! Provider-neutral memory contracts.
//!
//! Storage implementations can target PostgreSQL, SQLite, Qdrant, files or
//! another backend without leaking persistence concerns into the agent core.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub type MemoryId = Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryRecord {
    pub id: MemoryId,
    pub agent_id: Uuid,
    pub content: String,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

impl MemoryRecord {
    pub fn new(agent_id: Uuid, content: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            agent_id,
            content: content.into(),
            metadata: serde_json::json!({}),
            created_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryQuery {
    pub agent_id: Uuid,
    pub text: String,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryMatch {
    pub record: MemoryRecord,
    pub score: f32,
}

#[derive(Debug, Error)]
pub enum MemoryError {
    #[error("memory backend error: {0}")]
    Backend(String),
    #[error("invalid memory query: {0}")]
    InvalidQuery(String),
}

/// Storage boundary for short-term and long-term agent memory.
pub trait MemoryStore: Send + Sync {
    fn remember(&self, record: MemoryRecord) -> Result<MemoryId, MemoryError>;
    fn search(&self, query: &MemoryQuery) -> Result<Vec<MemoryMatch>, MemoryError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct InMemoryStore(Mutex<Vec<MemoryRecord>>);

    impl MemoryStore for InMemoryStore {
        fn remember(&self, record: MemoryRecord) -> Result<MemoryId, MemoryError> {
            let id = record.id;
            self.0.lock().unwrap().push(record);
            Ok(id)
        }

        fn search(&self, query: &MemoryQuery) -> Result<Vec<MemoryMatch>, MemoryError> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.agent_id == query.agent_id && r.content.contains(&query.text))
                .take(query.limit)
                .cloned()
                .map(|record| MemoryMatch { record, score: 1.0 })
                .collect())
        }
    }

    #[test]
    fn memory_contract_supports_store_and_search() {
        let store = InMemoryStore::default();
        let agent_id = Uuid::new_v4();
        let id = store
            .remember(MemoryRecord::new(agent_id, "important legal context"))
            .unwrap();

        let matches = store
            .search(&MemoryQuery {
                agent_id,
                text: "legal".into(),
                limit: 5,
            })
            .unwrap();

        assert_eq!(id, matches[0].record.id);
        assert_eq!(matches[0].score, 1.0);
    }
}
