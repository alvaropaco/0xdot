#[cfg(test)]
mod tests {
    use crate::{Agent, AgentStatus, Event, EventBus, Task, TaskStatus};

    #[test]
    fn agent_lifecycle_is_deterministic() {
        let mut agent = Agent::new("Test Agent");
        assert_eq!(agent.status, AgentStatus::Idle);
        agent.start();
        assert_eq!(agent.status, AgentStatus::Running);
        agent.request_approval();
        assert_eq!(agent.status, AgentStatus::WaitingApproval);
        agent.pause();
        assert_eq!(agent.status, AgentStatus::Paused);
    }

    #[test]
    fn task_lifecycle_tracks_updates() {
        let agent = Agent::new("Test Agent");
        let mut task = Task::new(agent.id, "Open the browser");
        assert_eq!(task.status, TaskStatus::Queued);
        task.transition(TaskStatus::Running);
        assert_eq!(task.status, TaskStatus::Running);
        task.transition(TaskStatus::Completed);
        assert_eq!(task.status, TaskStatus::Completed);
    }

    #[test]
    fn event_bus_delivers_domain_events() {
        let bus = EventBus::new(16);
        let mut receiver = bus.subscribe();
        let agent = Agent::new("Test Agent");
        bus.publish(Event::AgentCreated { agent_id: agent.id })
            .unwrap();
        let event = receiver.try_recv().unwrap();
        assert!(matches!(event, Event::AgentCreated { agent_id } if agent_id == agent.id));
    }
}
