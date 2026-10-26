use crate::approval::ApprovalBroker;
use rakazo_core::{Agent, AgentExecutor, AgentRuntime, ExecutionInput, ExecutorError, ModelProvider, RuntimeSnapshot, Task, TaskId, ToolCall, ToolExecutor, ToolRegistry, ToolResult, ToolRisk, ToolDefinition, ToolRuntime, WorkspaceFs};
use rakazo_model_openai::OpenAiCompatibleProvider;
use std::{path::Path, sync::Arc};

struct HostToolExecutor { workspace: Arc<ToolRuntime> }
impl ToolExecutor for HostToolExecutor {
    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ExecutorError> {
        if call.name.starts_with("filesystem.") {
            return self.workspace.execute(call).map_err(|e| ExecutorError::Tool(e.to_string()));
        }
        crate::computer_bridge::execute(call)
            .map(|value| serde_json::from_value(value).unwrap_or(ToolResult { success: false, output: serde_json::json!({"error": "invalid computer tool response"}) }))
            .map_err(ExecutorError::Tool)
    }
}

pub struct AgentExecutionResult { pub task_id: TaskId, pub content: String, pub tool_calls: usize, pub completed: bool, pub snapshot: RuntimeSnapshot }

pub fn execute_with_runtime(provider: &dyn ModelProvider, runtime: AgentRuntime, agent_id: rakazo_core::AgentId, task_id: TaskId, model: String, prompt: String, system_prompt: Option<String>, temperature: Option<f32>, max_tokens: Option<u32>, approval: ApprovalBroker, workspace_root: impl AsRef<Path>) -> Result<AgentExecutionResult, String> {
    let workspace_fs = Arc::new(WorkspaceFs::new(workspace_root).map_err(|e| e.to_string())?);
    let mut workspace = ToolRuntime::new();
    rakazo_core::register_workspace_tools(&mut workspace, workspace_fs);
    let workspace = Arc::new(workspace);

    let mut tools = ToolRegistry::default();
    rakazo_core::register_computer_automation_definitions(&mut tools).map_err(|e| e.to_string())?;
    tools.register(ToolDefinition { name: "filesystem.read_file".into(), description: "Read a text file inside the agent workspace.".into(), risk: ToolRisk::ReadOnly, requires_approval: false }).map_err(|e| e.to_string())?;
    tools.register(ToolDefinition { name: "filesystem.write_file".into(), description: "Write a text file inside the agent workspace.".into(), risk: ToolRisk::Mutating, requires_approval: true }).map_err(|e| e.to_string())?;
    tools.register(ToolDefinition { name: "filesystem.list_dir".into(), description: "List files inside the agent workspace.".into(), risk: ToolRisk::ReadOnly, requires_approval: false }).map_err(|e| e.to_string())?;

    let executor = AgentExecutor::new(&runtime, provider, &tools, &HostToolExecutor { workspace }, &approval);
    let output = executor.execute(ExecutionInput { task_id, agent_id, model, prompt, system_prompt, temperature, max_tokens }).map_err(|e| e.to_string())?;
    let snapshot = runtime.snapshot().map_err(|e| e.to_string())?;
    Ok(AgentExecutionResult { task_id, content: output.content, tool_calls: output.tool_calls, completed: output.completed, snapshot })
}

pub fn new_runtime_task(prompt: String) -> Result<(AgentRuntime, rakazo_core::AgentId, Task), String> {
    let runtime = AgentRuntime::new();
    let agent = Agent::new("desktop-agent");
    let agent_id = agent.id;
    runtime.register_agent(agent).map_err(|e| e.to_string())?;
    let task = Task::new(agent_id, prompt);
    Ok((runtime, agent_id, task))
}

pub fn provider_from_env() -> Result<OpenAiCompatibleProvider, String> { OpenAiCompatibleProvider::from_env().map_err(|e| e.to_string()) }
