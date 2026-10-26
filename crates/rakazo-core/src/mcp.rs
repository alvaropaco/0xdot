use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Write}, process::{Child, ChildStdin, ChildStdout, Command, Stdio}};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpServerConfig { pub command: String, #[serde(default)] pub args: Vec<String>, #[serde(default)] pub env: std::collections::HashMap<String, String> }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpTool { pub name: String, pub description: Option<String>, #[serde(rename="inputSchema")] pub input_schema: Value }
#[derive(Debug, Error)]
pub enum McpError { #[error("failed to spawn MCP server: {0}")] Spawn(String), #[error("MCP transport error: {0}")] Transport(String), #[error("MCP protocol error: {0}")] Protocol(String), #[error("MCP server error {code}: {message}")] Server { code: i64, message: String } }

pub struct McpClient { child: Child, stdin: ChildStdin, stdout: BufReader<ChildStdout>, next_id: u64 }
impl McpClient {
 pub fn spawn(config: &McpServerConfig) -> Result<Self,McpError> { let mut c=Command::new(&config.command); c.args(&config.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()); c.envs(&config.env); let mut child=c.spawn().map_err(|e|McpError::Spawn(e.to_string()))?; let stdin=child.stdin.take().ok_or_else(||McpError::Spawn("MCP stdin unavailable".into()))?; let stdout=child.stdout.take().ok_or_else(||McpError::Spawn("MCP stdout unavailable".into()))?; Ok(Self{child,stdin,stdout:BufReader::new(stdout),next_id:1}) }
 pub fn initialize(&mut self)->Result<(),McpError>{ self.request("initialize",json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"rakazo","version":env!("CARGO_PKG_VERSION")}}))?; self.notify("notifications/initialized",json!({})) }
 pub fn list_tools(&mut self)->Result<Vec<McpTool>,McpError>{ let r=self.request("tools/list",json!({}))?; serde_json::from_value(r.get("tools").cloned().unwrap_or_else(||Value::Array(vec![]))).map_err(|e|McpError::Protocol(format!("invalid tools/list response: {e}"))) }
 pub fn call_tool(&mut self,name:&str,arguments:Value)->Result<Value,McpError>{self.request("tools/call",json!({"name":name,"arguments":arguments}))}
 fn notify(&mut self,method:&str,params:Value)->Result<(),McpError>{self.write_message(&json!({"jsonrpc":"2.0","method":method,"params":params}))}
 fn request(&mut self,method:&str,params:Value)->Result<Value,McpError>{let id=self.next_id;self.next_id+=1;self.write_message(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;loop{let mut line=String::new();let n=self.stdout.read_line(&mut line).map_err(|e|McpError::Transport(e.to_string()))?;if n==0{return Err(McpError::Transport("MCP server closed stdout".into()));}if line.trim().is_empty(){continue;}let v:Value=serde_json::from_str(line.trim()).map_err(|e|McpError::Protocol(format!("invalid JSON-RPC message: {e}")))?;if v.get("id").and_then(Value::as_u64)!=Some(id){continue;}if let Some(e)=v.get("error"){return Err(McpError::Server{code:e.get("code").and_then(Value::as_i64).unwrap_or(-32000),message:e.get("message").and_then(Value::as_str).unwrap_or("unknown MCP error").into()});}return Ok(v.get("result").cloned().unwrap_or(Value::Null));}}
 fn write_message(&mut self,message:&Value)->Result<(),McpError>{let encoded=serde_json::to_vec(message).map_err(|e|McpError::Protocol(e.to_string()))?;self.stdin.write_all(&encoded).map_err(|e|McpError::Transport(e.to_string()))?;self.stdin.write_all(b"\n").map_err(|e|McpError::Transport(e.to_string()))?;self.stdin.flush().map_err(|e|McpError::Transport(e.to_string()))}
}
impl Drop for McpClient{fn drop(&mut self){let _=self.child.kill();}}
#[cfg(test)]mod tests{use super::*;#[test]fn config_round_trips(){let c=McpServerConfig{command:"node".into(),args:vec!["server.js".into()],env:std::collections::HashMap::new()};assert_eq!(serde_json::to_value(&c).unwrap()["command"],"node");}}
