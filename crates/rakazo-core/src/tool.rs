//! Provider-neutral tool contracts.
//!
//! Concrete MCP, browser, filesystem and computer implementations live outside
//! the core. The core only decides what can be invoked and whether approval is
//! required.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ToolRisk {
    ReadOnly,
    Mutating,
    Destructive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub risk: ToolRisk,
    pub requires_approval: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolCall {
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolResult {
    pub success: bool,
    pub output: serde_json::Value,
}

#[derive(Debug, Error)]
pub enum ToolRegistryError {
    #[error("tool already registered: {0}")]
    AlreadyRegistered(String),
    #[error("tool not found: {0}")]
    NotFound(String),
}

#[derive(Debug, Default, Clone)]
pub struct ToolRegistry {
    definitions: HashMap<String, ToolDefinition>,
}

impl ToolRegistry {
    pub fn register(&mut self, definition: ToolDefinition) -> Result<(), ToolRegistryError> {
        if self.definitions.contains_key(&definition.name) {
            return Err(ToolRegistryError::AlreadyRegistered(definition.name));
        }
        self.definitions.insert(definition.name.clone(), definition);
        Ok(())
    }

    pub fn get(&self, name: &str) -> Result<&ToolDefinition, ToolRegistryError> {
        self.definitions
            .get(name)
            .ok_or_else(|| ToolRegistryError::NotFound(name.to_owned()))
    }

    pub fn contains(&self, name: &str) -> bool {
        self.definitions.contains_key(name)
    }

    pub fn definitions(&self) -> impl Iterator<Item = &ToolDefinition> {
        self.definitions.values()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_and_resolves_tools() {
        let mut registry = ToolRegistry::default();
        registry
            .register(ToolDefinition {
                name: "browser.search".into(),
                description: "Search the browser".into(),
                risk: ToolRisk::ReadOnly,
                requires_approval: false,
            })
            .unwrap();

        assert!(registry.contains("browser.search"));
        assert_eq!(registry.definitions().count(), 1);
    }

    #[test]
    fn prevents_duplicate_tools() {
        let definition = ToolDefinition {
            name: "computer.write_file".into(),
            description: "Write a file".into(),
            risk: ToolRisk::Mutating,
            requires_approval: true,
        };
        let mut registry = ToolRegistry::default();
        registry.register(definition.clone()).unwrap();
        assert!(matches!(
            registry.register(definition),
            Err(ToolRegistryError::AlreadyRegistered(_))
        ));
    }
}
