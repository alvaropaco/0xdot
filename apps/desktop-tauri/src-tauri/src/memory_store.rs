use rakazo_core::{MemoryError, MemoryId, MemoryMatch, MemoryQuery, MemoryRecord, MemoryStore};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, sync::Mutex};

#[derive(Default, Serialize, Deserialize)]
struct MemoryFile { records: Vec<MemoryRecord> }

pub struct JsonMemoryStore {
    path: PathBuf,
    records: Mutex<Vec<MemoryRecord>>,
}

impl JsonMemoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let records = if path.exists() {
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            serde_json::from_slice::<MemoryFile>(&bytes).map_err(|e| format!("invalid memory store: {e}"))?.records
        } else { Vec::new() };
        Ok(Self { path, records: Mutex::new(records) })
    }

    fn persist(&self, records: &[MemoryRecord]) -> Result<(), MemoryError> {
        let temp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&MemoryFile { records: records.to_vec() }).map_err(|e| MemoryError::Backend(e.to_string()))?;
        fs::write(&temp, bytes).map_err(|e| MemoryError::Backend(e.to_string()))?;
        fs::rename(&temp, &self.path).map_err(|e| MemoryError::Backend(e.to_string()))
    }
}

impl MemoryStore for JsonMemoryStore {
    fn remember(&self, record: MemoryRecord) -> Result<MemoryId, MemoryError> {
        let id = record.id;
        let mut records = self.records.lock().map_err(|_| MemoryError::Backend("memory lock poisoned".into()))?;
        records.push(record);
        const MAX_RECORDS: usize = 500;
        if records.len() > MAX_RECORDS { let remove = records.len() - MAX_RECORDS; records.drain(0..remove); }
        self.persist(&records)?;
        Ok(id)
    }

    fn search(&self, query: &MemoryQuery) -> Result<Vec<MemoryMatch>, MemoryError> {
        if query.limit == 0 { return Ok(Vec::new()); }
        let terms: Vec<String> = query.text.split_whitespace().filter(|s| s.len() > 2).map(|s| s.to_ascii_lowercase()).collect();
        if terms.is_empty() { return Ok(Vec::new()); }
        let records = self.records.lock().map_err(|_| MemoryError::Backend("memory lock poisoned".into()))?;
        let mut matches: Vec<MemoryMatch> = records.iter().filter(|record| record.agent_id == query.agent_id).filter_map(|record| {
            let content = record.content.to_ascii_lowercase();
            let hits = terms.iter().filter(|term| content.contains(term.as_str())).count();
            (hits > 0).then(|| MemoryMatch { record: record.clone(), score: hits as f32 / terms.len() as f32 })
        }).collect();
        matches.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        matches.truncate(query.limit);
        Ok(matches)
    }
}
