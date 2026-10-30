//! Provider-neutral model contracts.
//!
//! The core does not depend on OpenAI, Anthropic, Gemini, Ollama or any other
//! provider SDK. Adapters translate these contracts to a concrete provider.

use crate::tool::{ToolCall, ToolDefinition};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelMessage {
    pub role: MessageRole,
    pub content: String,
}

impl ModelMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::System,
            content: content.into(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::User,
            content: content.into(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::Assistant,
            content: content.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelRequest {
    pub model: String,
    pub messages: Vec<ModelMessage>,
    pub tools: Vec<ToolDefinition>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelResponse {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    pub usage: Option<ModelUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Error)]
pub enum ModelError {
    #[error("model provider error: {0}")]
    Provider(String),
    #[error("model request rejected: {0}")]
    InvalidRequest(String),
}

/// Synchronous provider boundary for the first native core milestone.
/// Async/network adapters can wrap their client behind this interface later;
/// the domain model remains independent of provider SDKs.
pub trait ModelProvider: Send + Sync {
    fn complete(&self, request: &ModelRequest) -> Result<ModelResponse, ModelError>;

    /// Completion that can surface incremental assistant text through
    /// `on_delta`. Providers without a streaming wire format inherit the
    /// synchronous `complete` and simply emit no deltas.
    fn complete_with_delta(
        &self,
        request: &ModelRequest,
        _on_delta: &mut dyn FnMut(&str),
    ) -> Result<ModelResponse, ModelError> {
        self.complete(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeProvider;

    impl ModelProvider for FakeProvider {
        fn complete(&self, request: &ModelRequest) -> Result<ModelResponse, ModelError> {
            Ok(ModelResponse {
                content: request
                    .messages
                    .last()
                    .map(|m| m.content.clone())
                    .unwrap_or_default(),
                tool_calls: Vec::new(),
                finish_reason: Some("stop".into()),
                usage: Some(ModelUsage {
                    input_tokens: 1,
                    output_tokens: 1,
                }),
            })
        }
    }

    #[test]
    fn provider_contract_is_provider_neutral() {
        let provider = FakeProvider;
        let response = provider
            .complete(&ModelRequest {
                model: "test-model".into(),
                messages: vec![ModelMessage::user("hello")],
                tools: Vec::new(),
                temperature: None,
                max_tokens: Some(100),
            })
            .unwrap();

        assert_eq!(response.content, "hello");
    }
}
