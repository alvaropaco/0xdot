use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type RoutineId = Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Routine {
    pub id: RoutineId,
    pub name: String,
    pub model: String,
    pub prompt: String,
    pub interval_seconds: u64,
    pub enabled: bool,
    pub last_run_at: Option<DateTime<Utc>>,
    pub next_run_at: DateTime<Utc>,
}

impl Routine {
    pub fn new(name: impl Into<String>, model: impl Into<String>, prompt: impl Into<String>, interval_seconds: u64) -> Self {
        let interval_seconds = interval_seconds.max(1);
        let now = Utc::now();
        Self { id: Uuid::new_v4(), name: name.into(), model: model.into(), prompt: prompt.into(), interval_seconds, enabled: true, last_run_at: None, next_run_at: now + Duration::seconds(interval_seconds as i64) }
    }

    pub fn due(&self, now: DateTime<Utc>) -> bool { self.enabled && self.next_run_at <= now }

    pub fn mark_run(&mut self, now: DateTime<Utc>) { self.last_run_at = Some(now); self.next_run_at = now + Duration::seconds(self.interval_seconds as i64); }
}

#[derive(Debug, Default)]
pub struct RoutineScheduler {
    routines: Vec<Routine>,
}

impl RoutineScheduler {
    pub fn upsert(&mut self, routine: Routine) { if let Some(existing) = self.routines.iter_mut().find(|item| item.id == routine.id) { *existing = routine; } else { self.routines.push(routine); } }
    pub fn remove(&mut self, id: RoutineId) -> bool { let before = self.routines.len(); self.routines.retain(|item| item.id != id); before != self.routines.len() }
    pub fn list(&self) -> &[Routine] { &self.routines }
    pub fn tick(&mut self, now: DateTime<Utc>) -> Vec<Routine> { let mut due = Vec::new(); for routine in &mut self.routines { if routine.due(now) { due.push(routine.clone()); routine.mark_run(now); } } due }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interval_routine_becomes_due_and_reschedules() {
        let mut routine = Routine::new("test", "model", "run", 60);
        let first = routine.next_run_at;
        assert!(!routine.due(first - Duration::seconds(1)));
        assert!(routine.due(first));
        routine.mark_run(first);
        assert_eq!(routine.last_run_at, Some(first));
        assert_eq!(routine.next_run_at, first + Duration::seconds(60));
    }

    #[test]
    fn scheduler_only_returns_enabled_due_routines() {
        let now = Utc::now();
        let mut scheduler = RoutineScheduler::default();
        let mut routine = Routine::new("test", "model", "run", 1);
        routine.next_run_at = now;
        scheduler.upsert(routine.clone());
        let mut disabled = Routine::new("disabled", "model", "run", 1);
        disabled.enabled = false;
        disabled.next_run_at = now;
        scheduler.upsert(disabled);
        let due = scheduler.tick(now);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, routine.id);
    }
}
