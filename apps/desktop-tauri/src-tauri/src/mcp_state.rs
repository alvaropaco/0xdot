use rakazo_core::{McpClient, McpServerConfig, McpTool};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::{Arc, Mutex}};
#[derive(Clone,Default)] pub struct McpState{clients:Arc<Mutex<HashMap<String,McpClient>>>}
#[derive(Debug,Deserialize)] pub struct McpConnectRequest{pub id:String,pub config:McpServerConfig}
#[derive(Debug,Serialize)] pub struct McpServerTools{pub id:String,pub tools:Vec<McpTool>}
impl McpState{pub fn connect(&self,request:McpConnectRequest)->Result<McpServerTools,String>{let mut client=McpClient::spawn(&request.config).map_err(|e|e.to_string())?;client.initialize().map_err(|e|e.to_string())?;let tools=client.list_tools().map_err(|e|e.to_string())?;self.clients.lock().map_err(|_|"MCP state lock poisoned".to_string())?.insert(request.id.clone(),client);Ok(McpServerTools{id:request.id,tools})}pub fn list_tools(&self,id:&str)->Result<Vec<McpTool>,String>{let mut clients=self.clients.lock().map_err(|_|"MCP state lock poisoned".to_string())?;clients.get_mut(id).ok_or_else(||format!("MCP server not connected: {id}"))?.list_tools().map_err(|e|e.to_string())}pub fn call_tool(&self,id:&str,name:&str,arguments:Value)->Result<Value,String>{let mut clients=self.clients.lock().map_err(|_|"MCP state lock poisoned".to_string())?;clients.get_mut(id).ok_or_else(||format!("MCP server not connected: {id}"))?.call_tool(name,arguments).map_err(|e|e.to_string())}pub fn disconnect(&self,id:&str)->Result<bool,String>{Ok(self.clients.lock().map_err(|_|"MCP state lock poisoned".to_string())?.remove(id).is_some())}}
