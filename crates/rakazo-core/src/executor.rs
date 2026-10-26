//! Deterministic agent execution loop.
//!
//! The executor coordinates model inference, tool calls and approval gates.
//! Provider- and OS-specific implementations are injected through traits.

use crate::{AgentId, AgentRuntime, MemoryQuery, MemoryStore, ModelMessage, ModelProvider, ModelRequest, TaskId, ToolCall, ToolDefinition, ToolRegistry, ToolResult};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approved,
    Rejected,
}

pub trait ApprovalGate: Send + Sync {
    fn request(&self, task_id: TaskId, tool: &ToolCall) -> Result<ApprovalDecision, ExecutorError>;
}

pub trait ToolExecutor: Send + Sync {
    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ExecutorError>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionInput {
    pub task_id: TaskId,
    pub agent_id: AgentId,
    pub model: String,
    pub prompt: String,
    pub system_prompt: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionOutput {
    pub content: String,
    pub tool_calls: usize,
    pub completed: bool,
}

#[derive(Debug, Error)]
pub enum ExecutorError {
    #[error("runtime error: {0}")]
    Runtime(String),
    #[error("model error: {0}")]
    Model(String),
    #[error("tool error: {0}")]
    Tool(String),
    #[error("approval rejected for tool: {0}")]
    ApprovalRejected(String),
    #[error("maximum tool rounds exceeded: {0}")]
    MaxRounds(usize),
}

pub struct AgentExecutor<'a> {
    runtime: &'a AgentRuntime,
    provider: &'a dyn ModelProvider,
    tools: &'a ToolRegistry,
    tool_executor: &'a dyn ToolExecutor,
    approval: &'a dyn ApprovalGate,
    memory: Option<&'a dyn MemoryStore>,
    max_rounds: usize,
}

impl<'a> AgentExecutor<'a> {
    pub fn new(runtime: &'a AgentRuntime, provider: &'a dyn ModelProvider, tools: &'a ToolRegistry, tool_executor: &'a dyn ToolExecutor, approval: &'a dyn ApprovalGate) -> Self {
        Self { runtime, provider, tools, tool_executor, approval, memory: None, max_rounds: 8 }
    }

    pub fn with_memory(mut self, memory: &'a dyn MemoryStore) -> Self { self.memory = Some(memory); self }
    pub fn with_max_rounds(mut self, max_rounds: usize) -> Self { self.max_rounds = max_rounds.max(1); self }

    pub fn execute(&self, input: ExecutionInput) -> Result<ExecutionOutput, ExecutorError> {
        self.runtime.set_task_status(input.task_id, crate::TaskStatus::Running).map_err(|e| ExecutorError::Runtime(e.to_string()))?;
        let mut messages = Vec::new();
        if let Some(system) = input.system_prompt.as_deref() { messages.push(ModelMessage::system(system)); }
        if let Some(memory) = self.memory {
            let matches = memory.search(&MemoryQuery { agent_id: input.agent_id, text: input.prompt.clone(), limit: 5 }).map_err(|e| ExecutorError::Tool(e.to_string()))?;
            for item in matches { messages.push(ModelMessage::system(format!("Relevant memory: {}", item.record.content))); }
        }
        messages.push(ModelMessage::user(input.prompt));
        let definitions: Vec<ToolDefinition> = self.tools.definitions().cloned().collect();
        let mut total_tool_calls = 0;

        for _round in 0..self.max_rounds {
            let response = self.provider.complete(&ModelRequest { model: input.model.clone(), messages: messages.clone(), tools: definitions.clone(), temperature: input.temperature, max_tokens: input.max_tokens }).map_err(|e| ExecutorError::Model(e.to_string()))?;
            if response.tool_calls.is_empty() {
                self.runtime.set_task_status(input.task_id, crate::TaskStatus::Completed).map_err(|e| ExecutorError::Runtime(e.to_string()))?;
                return Ok(ExecutionOutput { content: response.content, tool_calls: total_tool_calls, completed: true });
            }
            messages.push(ModelMessage::assistant(response.content.clone()));
            for call in response.tool_calls {
                total_tool_calls += 1;
                let definition = self.tools.get(&call.name).map_err(|e| ExecutorError::Tool(e.to_string()))?;
                if definition.requires_approval {
                    self.runtime.set_task_status(input.task_id, crate::TaskStatus::WaitingApproval).map_err(|e| ExecutorError::Runtime(e.to_string()))?;
                    let decision = match self.approval.request(input.task_id, &call) {
                        Ok(decision) => decision,
                        Err(error) => {
                            let _ = self.runtime.set_task_status(input.task_id, crate::TaskStatus::Failed);
                            return Err(error);
                        }
                    };
                    match decision {
                        ApprovalDecision::Approved => {
                            self.runtime.set_task_status(input.task_id, crate::TaskStatus::Running).map_err(|e| ExecutorError::Runtime(e.to_string()))?;
                        }
                        ApprovalDecision::Rejected => {
                            self.runtime.set_task_status(input.task_id, crate::TaskStatus::Failed).map_err(|e| ExecutorError::Runtime(e.to_string()))?;
                            return Err(ExecutorError::ApprovalRejected(call.name));
                        }
                    }
                }
                let result = self.tool_executor.execute(&call)?;
                messages.push(ModelMessage { role: crate::MessageRole::Tool, content: serde_json::to_string(&result.output).unwrap_or_default() });
            }
        }
        self.runtime.set_task_status(input.task_id, crate::TaskStatus::Failed).map_err(|e| ExecutorError::Runtime(e.to_string()))?;
        Err(ExecutorError::MaxRounds(self.max_rounds))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Agent, ModelError, ModelResponse, ModelUsage, Task, ToolRisk};
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;

    struct FakeProvider { calls: Arc<Mutex<usize>> }
    impl ModelProvider for FakeProvider {
        fn complete(&self, request: &ModelRequest) -> Result<ModelResponse, ModelError> {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            if *calls == 1 {
                Ok(ModelResponse { content: "using tool".into(), tool_calls: vec![ToolCall { name: "test.read".into(), arguments: serde_json::json!({}) }], finish_reason: None, usage: None })
            } else {
                assert!(request.messages.iter().any(|m| m.role == crate::MessageRole::Tool));
                Ok(ModelResponse { content: "done".into(), tool_calls: vec![], finish_reason: Some("stop".into()), usage: Some(ModelUsage { input_tokens: 1, output_tokens: 1 }) })
            }
        }
    }

    struct FakeTools;
    impl ToolExecutor for FakeTools { fn execute(&self, _call: &ToolCall) -> Result<ToolResult, ExecutorError> { Ok(ToolResult { success: true, output: serde_json::json!({"ok":true}) }) } }
    struct AutoApprove;
    impl ApprovalGate for AutoApprove { fn request(&self, _task_id: TaskId, _tool: &ToolCall) -> Result<ApprovalDecision, ExecutorError> { Ok(ApprovalDecision::Approved) } }
    struct Reject;
    impl ApprovalGate for Reject { fn request(&self, _task_id: TaskId, _tool: &ToolCall) -> Result<ApprovalDecision, ExecutorError> { Ok(ApprovalDecision::Rejected) } }
    struct ApprovalError;
    impl ApprovalGate for ApprovalError { fn request(&self, _task_id: TaskId, _tool: &ToolCall) -> Result<ApprovalDecision, ExecutorError> { Err(ExecutorError::Runtime("approval unavailable".into())) } }

    fn setup(requires_approval: bool) -> (AgentRuntime, TaskId, ToolRegistry) {
        let runtime = AgentRuntime::new();
        let agent_id = runtime.register_agent(Agent::new("executor")).unwrap();
        let task_id = runtime.enqueue_task(Task::new(agent_id, "execute")).unwrap();
        let mut tools = ToolRegistry::default();
        tools.register(ToolDefinition { name: "test.read".into(), description: "test".into(), risk: ToolRisk::ReadOnly, requires_approval }).unwrap();
        (runtime, task_id, tools)
    }

    #[test]
    fn executes_tool_and_continues_model_loop() {
        let (runtime, task_id, tools) = setup(false);
        let provider_calls = Arc::new(Mutex::new(0));
        let provider = FakeProvider { calls: provider_calls.clone() };
        let output = AgentExecutor::new(&runtime, &provider, &tools, &FakeTools, &AutoApprove).execute(ExecutionInput { task_id, agent_id: runtime.snapshot().unwrap().agents[0].id, model: "fake".into(), prompt: "hello".into(), system_prompt: None, temperature: None, max_tokens: Some(100) }).unwrap();
        assert_eq!(output.content, "done");
        assert_eq!(*provider_calls.lock().unwrap(), 2);
        assert_eq!(runtime.snapshot().unwrap().tasks[0].status, crate::TaskStatus::Completed);
    }

    #[test]
    fn approval_rejection_fails_task() {
        let (runtime, task_id, tools) = setup(true);
        let provider = FakeProvider { calls: Arc::new(Mutex::new(0)) };
        let error = AgentExecutor::new(&runtime, &provider, &tools, &FakeTools, &Reject).execute(ExecutionInput { task_id, agent_id: runtime.snapshot().unwrap().agents[0].id, model: "fake".into(), prompt: "hello".into(), system_prompt: None, temperature: None, max_tokens: Some(100) }).unwrap_err();
        assert!(matches!(error, ExecutorError::ApprovalRejected(name) if name == "test.read"));
        assert_eq!(runtime.snapshot().unwrap().tasks[0].status, crate::TaskStatus::Failed);
    }

    #[test]
    fn approval_gate_error_fails_task() {
        let (runtime, task_id, tools) = setup(true);
        let provider = FakeProvider { calls: Arc::new(Mutex::new(0)) };
        let error = AgentExecutor::new(&runtime, &provider, &tools, &FakeTools, &ApprovalError).execute(ExecutionInput { task_id, agent_id: runtime.snapshot().unwrap().agents[0].id, model: "fake".into(), prompt: "hello".into(), system_prompt: None, temperature: None, max_tokens: Some(100) }).unwrap_err();
        assert!(matches!(error, ExecutorError::Runtime(message) if message == "approval unavailable"));
        assert_eq!(runtime.snapshot().unwrap().tasks[0].status, crate::TaskStatus::Failed);
    }
}
