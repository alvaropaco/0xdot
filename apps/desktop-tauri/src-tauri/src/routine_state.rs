use rakazo_core::{Routine, RoutineId, RoutineScheduler};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, sync::Mutex};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RoutineFile { pub routines: Vec<Routine> }

pub struct RoutineStore { path: PathBuf, scheduler: Mutex<RoutineScheduler> }

impl RoutineStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let file = if path.exists() { let bytes = fs::read(&path).map_err(|e| e.to_string())?; serde_json::from_slice::<RoutineFile>(&bytes).map_err(|e| format!("invalid routine store: {e}"))? } else { RoutineFile::default() };
        let mut scheduler = RoutineScheduler::default();
        for routine in file.routines { scheduler.upsert(routine); }
        Ok(Self { path, scheduler: Mutex::new(scheduler) })
    }

    fn persist(&self) -> Result<(), String> {
        let scheduler = self.scheduler.lock().map_err(|_| "routine lock poisoned".to_string())?;
        let bytes = serde_json::to_vec_pretty(&RoutineFile { routines: scheduler.list().to_vec() }).map_err(|e| e.to_string())?;
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        fs::rename(temp, &self.path).map_err(|e| e.to_string())
    }

    pub fn list(&self) -> Result<Vec<Routine>, String> { Ok(self.scheduler.lock().map_err(|_| "routine lock poisoned".to_string())?.list().to_vec()) }
    pub fn upsert(&self, routine: Routine) -> Result<(), String> { self.scheduler.lock().map_err(|_| "routine lock poisoned".to_string())?.upsert(routine); self.persist() }
    pub fn remove(&self, id: RoutineId) -> Result<bool, String> { let removed = self.scheduler.lock().map_err(|_| "routine lock poisoned".to_string())?.remove(id); self.persist()?; Ok(removed) }
    pub fn tick(&self) -> Result<Vec<Routine>, String> { let due = self.scheduler.lock().map_err(|_| "routine lock poisoned".to_string())?.tick(Utc::now()); self.persist()?; Ok(due) }
}
