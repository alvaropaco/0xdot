use rakazo_core::{
    MessageRole, ModelError, ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelUsage,
    ToolCall, ToolDefinition,
};
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::BufRead;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OpenAiProviderError {
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
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
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Result<Self, OpenAiProviderError> {
        let mut base_url = base_url.into().trim_end_matches('/').to_string();
        if !base_url.ends_with("/v1") {
            base_url.push_str("/v1");
        }
        Ok(Self {
            client: Client::builder().build()?,
            base_url,
            api_key: api_key.into(),
        })
    }

    pub fn from_env() -> Result<Self, OpenAiProviderError> {
        let base_url = std::env::var("RAKAZO_MODEL_BASE_URL")
            .unwrap_or_else(|_| "https://api.openai.com/v1".into());
        let api_key = std::env::var("RAKAZO_MODEL_API_KEY")
            .map_err(|_| OpenAiProviderError::Response("RAKAZO_MODEL_API_KEY is not set".into()))?;
        Self::new(base_url, api_key)
    }

    fn request_json(&self, request: &ModelRequest) -> Value {
        let messages: Vec<Value> = request.messages.iter().map(message_json).collect();
        let tools: Vec<Value> = request.tools.iter().map(tool_json).collect();
        let mut body = json!({ "model": request.model, "messages": messages });
        if let Some(value) = request.temperature {
            body["temperature"] = json!(value);
        }
        if let Some(value) = request.max_tokens {
            body["max_tokens"] = json!(value);
        }
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools);
        }
        body
    }
}

impl OpenAiCompatibleProvider {
    fn parse_completion(&self, body: &str) -> Result<ModelResponse, ModelError> {
        let parsed: ChatCompletionResponse = serde_json::from_str(body)
            .map_err(|error| ModelError::Provider(format!("invalid response JSON: {error}")))?;
        let choice = parsed
            .choices
            .first()
            .ok_or_else(|| ModelError::Provider("provider returned no choices".into()))?;
        let tool_calls = choice
            .message
            .tool_calls
            .iter()
            .map(|call| ToolCall {
                name: call.function.name.clone(),
                arguments: serde_json::from_str(&call.function.arguments)
                    .unwrap_or_else(|_| json!({"raw": call.function.arguments})),
            })
            .collect();
        Ok(ModelResponse {
            content: choice.message.content.clone().unwrap_or_default(),
            tool_calls,
            finish_reason: choice.finish_reason.clone(),
            usage: parsed.usage.map(|usage| ModelUsage {
                input_tokens: usage.prompt_tokens,
                output_tokens: usage.completion_tokens,
            }),
        })
    }
}

impl ModelProvider for OpenAiCompatibleProvider {
    fn complete(&self, request: &ModelRequest) -> Result<ModelResponse, ModelError> {
        let response = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&self.request_json(request))
            .send()
            .map_err(|error| ModelError::Provider(error.to_string()))?;
        let status = response.status();
        let body = response
            .text()
            .map_err(|error| ModelError::Provider(error.to_string()))?;
        if !status.is_success() {
            return Err(ModelError::Provider(format!(
                "HTTP {}: {}",
                status.as_u16(),
                body
            )));
        }
        self.parse_completion(&body)
    }

    fn complete_with_delta(
        &self,
        request: &ModelRequest,
        on_delta: &mut dyn FnMut(&str),
    ) -> Result<ModelResponse, ModelError> {
        let mut body = self.request_json(request);
        body["stream"] = json!(true);
        let response = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .map_err(|error| ModelError::Provider(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            let text = response
                .text()
                .map_err(|error| ModelError::Provider(error.to_string()))?;
            return Err(ModelError::Provider(format!(
                "HTTP {}: {}",
                status.as_u16(),
                text
            )));
        }
        // reqwest::blocking::Response implements io::Read, so the event stream
        // is consumed line by line without pulling an async client into the
        // desktop shell.
        let mut accumulator = StreamAccumulator::default();
        for line in std::io::BufReader::new(response).lines() {
            let line = line.map_err(|error| ModelError::Provider(error.to_string()))?;
            accumulator.feed_line(&line);
            for delta in accumulator.take_deltas() {
                on_delta(&delta);
            }
            if accumulator.finished() {
                break;
            }
        }
        accumulator.into_response(self)
    }
}

/// Reassembles an OpenAI-compatible SSE chat-completions stream into the
/// synchronous `ModelResponse` the core understands, keeping text deltas
/// available as they arrive and stitching streamed `tool_calls` fragments.
#[derive(Default)]
struct StreamAccumulator {
    content: String,
    tool_calls: std::collections::BTreeMap<u64, (String, String)>,
    finish_reason: Option<String>,
    usage: Option<ModelUsage>,
    saw_event: bool,
    raw: String,
    done: bool,
    pending_deltas: Vec<String>,
}

impl StreamAccumulator {
    fn feed_line(&mut self, line: &str) {
        self.raw.push_str(line);
        self.raw.push('\n');
        let Some(payload) = line.trim().strip_prefix("data:") else {
            return;
        };
        let payload = payload.trim();
        if payload == "[DONE]" {
            self.done = true;
            return;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        self.saw_event = true;
        if let Some(usage) = chunk.get("usage") {
            self.usage = Some(ModelUsage {
                input_tokens: usage["prompt_tokens"].as_u64().unwrap_or_default(),
                output_tokens: usage["completion_tokens"].as_u64().unwrap_or_default(),
            });
        }
        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return;
        };
        if choice.get("delta").is_some() {
            if let Some(content) = choice["delta"]["content"].as_str() {
                if !content.is_empty() {
                    self.content.push_str(content);
                    self.pending_deltas.push(content.to_string());
                }
            }
            if let Some(calls) = choice["delta"]["tool_calls"].as_array() {
                for call in calls {
                    let index = call["index"].as_u64().unwrap_or_default();
                    let entry = self
                        .tool_calls
                        .entry(index)
                        .or_insert_with(|| (String::new(), String::new()));
                    if let Some(name) = call["function"]["name"].as_str() {
                        entry.0.push_str(name);
                    }
                    if let Some(arguments) = call["function"]["arguments"].as_str() {
                        entry.1.push_str(arguments);
                    }
                }
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish_reason = Some(reason.to_string());
        }
    }

    fn take_deltas(&mut self) -> Vec<String> {
        std::mem::take(&mut self.pending_deltas)
    }

    fn finished(&self) -> bool {
        self.done || (self.saw_event && self.finish_reason.is_some())
    }

    fn into_response(
        self,
        provider: &OpenAiCompatibleProvider,
    ) -> Result<ModelResponse, ModelError> {
        if !self.saw_event {
            // Some compatible endpoints ignore `stream` and answer with one
            // non-SSE JSON body; parse the raw read as that response.
            let raw = self.raw.trim();
            if raw.is_empty() {
                return Err(ModelError::Provider("stream produced no events".into()));
            }
            return provider.parse_completion(raw);
        }
        Ok(ModelResponse {
            content: self.content,
            tool_calls: self
                .tool_calls
                .values()
                .map(|(name, arguments)| ToolCall {
                    name: name.clone(),
                    arguments: serde_json::from_str(arguments)
                        .unwrap_or_else(|_| json!({"raw": arguments})),
                })
                .collect(),
            finish_reason: self.finish_reason,
            usage: self.usage,
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
struct ChatCompletionResponse {
    choices: Vec<Choice>,
    usage: Option<Usage>,
}
#[derive(Debug, Deserialize)]
struct Choice {
    message: ResponseMessage,
    finish_reason: Option<String>,
}
#[derive(Debug, Deserialize)]
struct ResponseMessage {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ResponseToolCall>,
}
#[derive(Debug, Deserialize)]
struct ResponseToolCall {
    function: FunctionCall,
}
#[derive(Debug, Deserialize)]
struct FunctionCall {
    name: String,
    arguments: String,
}
#[derive(Debug, Deserialize)]
struct Usage {
    prompt_tokens: u64,
    completion_tokens: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(lines: &[&str]) -> StreamAccumulator {
        let mut accumulator = StreamAccumulator::default();
        for line in lines {
            accumulator.feed_line(line);
        }
        accumulator
    }

    #[test]
    fn streams_text_deltas() {
        let mut accumulator = StreamAccumulator::default();
        let mut deltas = Vec::new();
        for line in [
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hel\"}}]}",
            "",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo\"}}]}",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}",
            "data: [DONE]",
        ] {
            accumulator.feed_line(line);
            deltas.extend(accumulator.take_deltas());
        }
        assert_eq!(deltas, vec!["Hel".to_string(), "lo".to_string()]);
        assert!(accumulator.finished());
        let provider = OpenAiCompatibleProvider::new("http://localhost:1", "test").unwrap();
        let response = accumulator.into_response(&provider).unwrap();
        assert_eq!(response.content, "Hello");
        assert_eq!(response.finish_reason.as_deref(), Some("stop"));
        assert!(response.tool_calls.is_empty());
    }

    #[test]
    fn stitches_streamed_tool_call_fragments() {
        let accumulator = feed(&[
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"files\"}}]}}]}",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"ystem.read_file\"}}]}}]}",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\"}}]}}]}",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]}}]}",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}",
        ]);
        let provider = OpenAiCompatibleProvider::new("http://localhost:1", "test").unwrap();
        let response = accumulator.into_response(&provider).unwrap();
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].name, "filesystem.read_file");
        assert_eq!(response.tool_calls[0].arguments["path"], "a.txt");
    }

    #[test]
    fn falls_back_to_plain_json_when_endpoint_ignores_stream() {
        let accumulator = feed(&[
            "{\"choices\":[{\"message\":{\"content\":\"hi there\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3}}",
        ]);
        let provider = OpenAiCompatibleProvider::new("http://localhost:1", "test").unwrap();
        let response = accumulator.into_response(&provider).unwrap();
        assert_eq!(response.content, "hi there");
        assert_eq!(
            response.usage,
            Some(ModelUsage {
                input_tokens: 2,
                output_tokens: 3
            })
        );
    }

    #[test]
    fn normalizes_base_url() {
        let provider = OpenAiCompatibleProvider::new("http://localhost:4000", "test").unwrap();
        assert_eq!(provider.base_url, "http://localhost:4000/v1");
        let provider = OpenAiCompatibleProvider::new("http://localhost:4000/v1/", "test").unwrap();
        assert_eq!(provider.base_url, "http://localhost:4000/v1");
    }

    #[test]
    fn serializes_tool_definition() {
        let tool = ToolDefinition {
            name: "computer.screen.capture".into(),
            description: "Capture screen".into(),
            risk: rakazo_core::ToolRisk::ReadOnly,
            requires_approval: false,
        };
        let value = tool_json(&tool);
        assert_eq!(value["function"]["name"], "computer.screen.capture");
        assert_eq!(value["function"]["parameters"]["type"], "object");
    }
}
