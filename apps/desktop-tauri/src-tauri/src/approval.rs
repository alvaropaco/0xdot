use rakazo_core::{ApprovalDecision, ApprovalGate, ExecutorError, TaskId, ToolCall};
use serde::Serialize;
use std::{collections::HashMap, sync::{Arc, Condvar, Mutex}, time::Duration};

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Default)]
pub struct ApprovalBroker {
    inner: Arc<(Mutex<HashMap<TaskId, Option<ApprovalDecision>>>, Condvar)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingApproval {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub tool: String,
}

impl ApprovalBroker {
    pub fn decide(&self, task_id: TaskId, decision: ApprovalDecision) -> bool {
        let (lock, cv) = &*self.inner;
        let mut pending = lock.lock().expect("approval broker lock poisoned");
        if let Some(entry) = pending.get_mut(&task_id) {
            *entry = Some(decision);
            cv.notify_all();
            true
        } else {
            false
        }
    }

    pub fn pending(&self) -> Vec<TaskId> {
        let (lock, _) = &*self.inner;
        lock.lock().expect("approval broker lock poisoned").iter().filter_map(|(id, decision)| decision.is_none().then_some(*id)).collect()
    }
}

impl ApprovalGate for ApprovalBroker {
    fn request(&self, task_id: TaskId, _tool: &ToolCall) -> Result<ApprovalDecision, ExecutorError> {
        let (lock, cv) = &*self.inner;
        let mut pending = lock.lock().map_err(|_| ExecutorError::Runtime("approval broker lock poisoned".into()))?;
        pending.insert(task_id, None);
        loop {
            if let Some(Some(decision)) = pending.get(&task_id) {
                let decision = decision.clone();
                pending.remove(&task_id);
                return Ok(decision);
            }
            let (next, timeout) = cv
                .wait_timeout(pending, APPROVAL_TIMEOUT)
                .map_err(|_| ExecutorError::Runtime("approval broker wait failed".into()))?;
            pending = next;
            if timeout.timed_out() {
                pending.remove(&task_id);
                return Err(ExecutorError::Runtime(format!("approval timed out after {} seconds", APPROVAL_TIMEOUT.as_secs())));
            }
        }
    }
}

pub fn describe_pending(broker: &ApprovalBroker, task_id: TaskId, tool: String) -> Option<PendingApproval> {
    broker.pending().into_iter().find(|id| *id == task_id).map(|id| PendingApproval { task_id: id.to_string(), tool })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_task_cannot_be_approved() {
        let broker = ApprovalBroker::default();
        assert!(!broker.decide(TaskId::new(), ApprovalDecision::Approved));
    }
}
