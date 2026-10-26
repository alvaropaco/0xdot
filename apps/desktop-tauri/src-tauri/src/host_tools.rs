use rakazo_core::{register_workspace_tools, CommandPolicy, ProcessRuntime, ToolCall, ToolDefinition, ToolExecutor, ToolRegistry, ToolResult, ToolRisk, ToolRuntime, WorkspaceFs};
use std::{env, sync::Arc, time::Duration};

pub struct HostToolRuntime { filesystem: Arc<ToolRuntime>, process: Arc<ProcessRuntime> }
impl HostToolRuntime {
 pub fn new()->Result<Self,String>{let home=env::var_os("HOME").or_else(||env::var_os("USERPROFILE")).ok_or_else(||"user home directory is unavailable".to_string())?;let fs=WorkspaceFs::new(&home).map_err(|e|e.to_string())?;let allowed=["git","node","npm","pnpm","python","python3","cargo","rustc","ls","cat","mkdir","cp","mv","docker"];let process=ProcessRuntime::new(&home,CommandPolicy::new(allowed).with_limits(64*1024,Duration::from_secs(60))).map_err(|e|e.to_string())?;let mut filesystem=ToolRuntime::new();register_workspace_tools(&mut filesystem,Arc::new(fs));Ok(Self{filesystem:Arc::new(filesystem),process:Arc::new(process)})}
 pub fn register_definitions(registry:&mut ToolRegistry)->Result<(),String>{for definition in [
  ToolDefinition{name:"host.filesystem.read_file".into(),description:"Read a text file under the user's home directory.".into(),risk:ToolRisk::ReadOnly,requires_approval:false},
  ToolDefinition{name:"host.filesystem.write_file".into(),description:"Write a text file under the user's home directory.".into(),risk:ToolRisk::Mutating,requires_approval:true},
  ToolDefinition{name:"host.filesystem.list_dir".into(),description:"List a directory under the user's home directory.".into(),risk:ToolRisk::ReadOnly,requires_approval:false},
  ToolDefinition{name:"host.computer.run".into(),description:"Run an allowlisted executable inside the user's home directory.".into(),risk:ToolRisk::Mutating,requires_approval:true},
  ToolDefinition{name:"host.docker.run".into(),description:"Run an allowlisted Docker or Docker Compose command from the user's home directory.".into(),risk:ToolRisk::Mutating,requires_approval:true},
 ]{registry.register(definition).map_err(|e|e.to_string())?;}Ok(())}
}
impl ToolExecutor for HostToolRuntime{fn execute(&self,call:&ToolCall)->Result<ToolResult,rakazo_core::ExecutorError>{if call.name=="host.computer.run"||call.name=="host.docker.run"{let mapped=ToolCall{name:"computer.run".into(),arguments:call.arguments.clone()};return self.process.execute(&mapped).map_err(|e|rakazo_core::ExecutorError::Tool(e.to_string()));}let mapped_name=call.name.strip_prefix("host.").unwrap_or(&call.name);let mapped=ToolCall{name:mapped_name.into(),arguments:call.arguments.clone()};self.filesystem.execute(&mapped).map_err(|e|rakazo_core::ExecutorError::Tool(e.to_string()))}}
