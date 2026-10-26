use rakazo_core::{Agent, AgentExecutor, AgentRuntime, ApprovalDecision, ApprovalGate, ExecutionInput, ExecutorError, ModelProvider, Task, TaskId, ToolCall, ToolExecutor, ToolRegistry, ToolResult};
use rakazo_model_openai::OpenAiCompatibleProvider;

struct HostToolExecutor;

impl ToolExecutor for HostToolExecutor {
    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ExecutorError> {
        crate::computer_bridge::execute(call)
            .map(|value| serde_json::from_value(value).unwrap_or(ToolResult { success: false, output: serde_json::json!({"error": "invalid computer tool response"}) }))
            .map_err(ExecutorError::Tool)
    }
}

struct RejectByDefaultApproval;

impl ApprovalGate for RejectByDefaultApproval {
    fn request(&self, _task_id: TaskId, tool: &ToolCall) -> Result<ApprovalDecision, ExecutorError> {
        Err(ExecutorError::ApprovalRejected(tool.name.clone()))
    }
}

pub struct AgentExecutionResult {
    pub task_id: TaskId,
    pub content: String,
    pub tool_calls: usize,
    pub completed: bool,
}

pub fn execute(model: String, prompt: String, system_prompt: Option<String>, temperature: Option<f32>, max_tokens: Option<u32>) -> Result<AgentExecutionResult, String> {
    let provider = OpenAiCompatibleProvider::from_env().map_err(|e| e.to_string())?;
    execute_with_provider(&provider, model, prompt, system_prompt, temperature, max_tokens)
}

fn execute_with_provider(
    provider: &dyn ModelProvider,
    model: String,
    prompt: String,
    system_prompt: Option<String>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
) -> Result<AgentExecutionResult, String> {
    let runtime = AgentRuntime::new();
    let agent_id = runtime.register_agent(Agent::new("desktop-agent")).map_err(|e| e.to_string())?;
    let task_id = runtime.enqueue_task(Task::new(agent_id, prompt.clone())).map_err(|e| e.to_string())?;

    let mut tools = ToolRegistry::default();
    rakazo_core::register_computer_automation_definitions(&mut tools).map_err(|e| e.to_string())?;

    let executor = AgentExecutor::new(&runtime, provider, &tools, &HostToolExecutor, &RejectByDefaultApproval);
    let output = executor.execute(ExecutionInput { task_id, agent_id, model, prompt, system_prompt, temperature, max_tokens }).map_err(|e| e.to_string())?;

    Ok(AgentExecutionResult { task_id, content: output.content, tool_calls: output.tool_calls, completed: output.completed })
}
