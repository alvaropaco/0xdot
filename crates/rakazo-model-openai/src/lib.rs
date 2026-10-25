use rakazo_core::{MessageRole, ModelError, ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelUsage, ToolCall, ToolDefinition};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OpenAiProviderError {
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("provider returned HTTP {status}: {body}")]
    HttpStatus { status: u16, body: String },
    #[error("invalid provider response: {0}")]
    Response(String),
}

#[derive(Clone)]
pub struct OpenAiCompatibleProvider {
    client: Client,
    base_url: String,
    api_key: String,
}

impl OpenAiCompatibleProvider {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Result<Self, OpenAiProviderError> {
        let mut base_url = base_url.into().trim_end_matches('/').to_string();
        if !base_url.ends_with("/v1") {
            base_url.push_str("/v1");
        }
        Ok(Self { client: Client::builder().build()?, base_url, api_key: api_key.into() })
    }

    pub fn from_env() -> Result<Self, OpenAiProviderError> {
        let base_url = std::env::var("RAKAZO_MODEL_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".into());
        let api_key = std::env::var("RAKAZO_MODEL_API_KEY").map_err(|_| OpenAiProviderError::Response("RAKAZO_MODEL_API_KEY is not set".into()))?;
        Self::new(base_url, api_key)
    }

    fn request_json(&self, request: &ModelRequest) -> Value {
        let messages: Vec<Value> = request.messages.iter().map(message_json).collect();
        let tools: Vec<Value> = request.tools.iter().map(tool_json).collect();
        let mut body = json!({ "model": request.model, "messages": messages });
        if let Some(value) = request.temperature { body["temperature"] = json!(value); }
        if let Some(value) = request.max_tokens { body["max_tokens"] = json!(value); }
        if !tools.is_empty() { body["tools"] = Value::Array(tools); }
        body
    }
}

impl ModelProvider for OpenAiCompatibleProvider {
    fn complete(&self, request: &ModelRequest) -> Result<ModelResponse, ModelError> {
        let response = self.client
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&self.request_json(request))
            .send()
            .map_err(|error| ModelError::Provider(error.to_string()))?;

        let status = response.status();
        let body = response.text().map_err(|error| ModelError::Provider(error.to_string()))?;
        if !status.is_success() {
            return Err(ModelError::Provider(format!("HTTP {}: {}", status.as_u16(), body)));
        }

        let parsed: ChatCompletionResponse = serde_json::from_str(&body)
            .map_err(|error| ModelError::Provider(format!("invalid response JSON: {error}")))?;
        let choice = parsed.choices.first().ok_or_else(|| ModelError::Provider("provider returned no choices".into()))?;
        let message = &choice.message;
        let tool_calls = message.tool_calls.iter().map(|call| ToolCall {
            name: call.function.name.clone(),
            arguments: serde_json::from_str(&call.function.arguments).unwrap_or_else(|_| json!({"raw": call.function.arguments})),
        }).collect();

        Ok(ModelResponse {
            content: message.content.clone().unwrap_or_default(),
            tool_calls,
            finish_reason: choice.finish_reason.clone(),
            usage: parsed.usage.map(|usage| ModelUsage { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens }),
        })
    }
}

fn message_json(message: &ModelMessage) -> Value {
    json!({
        "role": match message.role { MessageRole::System => "system", MessageRole::User => "user", MessageRole::Assistant => "assistant", MessageRole::Tool => "tool" },
        "content": message.content,
    })
}

fn tool_json(tool: &ToolDefinition) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": { "type": "object", "additionalProperties": true }
        }
    })
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse { choices: Vec<Choice>, usage: Option<Usage> }
#[derive(Debug, Deserialize)]
struct Choice { message: ResponseMessage, finish_reason: Option<String> }
#[derive(Debug, Deserialize)]
struct ResponseMessage { content: Option<String>, #[serde(default)] tool_calls: Vec<ResponseToolCall> }
#[derive(Debug, Deserialize)]
struct ResponseToolCall { function: FunctionCall }
#[derive(Debug, Deserialize)]
struct FunctionCall { name: String, arguments: String }
#[derive(Debug, Deserialize)]
struct Usage { prompt_tokens: u64, completion_tokens: u64 }

#[derive(Debug, Serialize)]
struct _ProviderMarker;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base_url() {
        let provider = OpenAiCompatibleProvider::new("http://localhost:4000", "test").unwrap();
        assert_eq!(provider.base_url, "http://localhost:4000/v1");
        let provider = OpenAiCompatibleProvider::new("http://localhost:4000/v1/", "test").unwrap();
        assert_eq!(provider.base_url, "http://localhost:4000/v1");
    }

    #[test]
    fn serializes_tool_definition() {
        let tool = ToolDefinition { name: "computer.screen.capture".into(), description: "Capture screen".into(), risk: rakazo_core::ToolRisk::ReadOnly, requires_approval: false };
        let value = tool_json(&tool);
        assert_eq!(value["function"]["name"], "computer.screen.capture");
        assert_eq!(value["function"]["parameters"]["type"], "object");
    }
}
