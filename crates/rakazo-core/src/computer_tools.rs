//! Tool adapters for the provider-neutral desktop automation runtime.

use crate::{
    computer_automation::{ComputerBackend, ComputerRuntime, KeyboardAction, MouseAction},
    ToolCall, ToolDefinition, ToolRegistry, ToolResult, ToolRisk,
};
use serde_json::json;
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ComputerToolError {
    #[error("invalid tool arguments: {0}")]
    InvalidArguments(String),
    #[error("automation error: {0}")]
    Automation(String),
}

pub struct ComputerToolRuntime<B: ComputerBackend> {
    runtime: Arc<ComputerRuntime<B>>,
}

impl<B: ComputerBackend + 'static> ComputerToolRuntime<B> {
    pub fn new(runtime: Arc<ComputerRuntime<B>>) -> Self {
        Self { runtime }
    }

    pub fn execute(&self, call: &ToolCall) -> Result<ToolResult, ComputerToolError> {
        match call.name.as_str() {
            "computer.screen.capture" => {
                let capture = self
                    .runtime
                    .screenshot()
                    .map_err(|e| ComputerToolError::Automation(e.to_string()))?;
                Ok(ToolResult {
                    success: true,
                    output: json!({
                        "width": capture.width,
                        "height": capture.height,
                        "format": capture.format,
                        "data": capture.data,
                    }),
                })
            }
            "computer.mouse" => {
                let action: MouseAction = serde_json::from_value(call.arguments.clone())
                    .map_err(|e| ComputerToolError::InvalidArguments(e.to_string()))?;
                self.runtime
                    .mouse(action)
                    .map_err(|e| ComputerToolError::Automation(e.to_string()))?;
                Ok(ok())
            }
            "computer.keyboard" => {
                let action: KeyboardAction = serde_json::from_value(call.arguments.clone())
                    .map_err(|e| ComputerToolError::InvalidArguments(e.to_string()))?;
                self.runtime
                    .keyboard(action)
                    .map_err(|e| ComputerToolError::Automation(e.to_string()))?;
                Ok(ok())
            }
            "computer.window.list" => {
                let windows = self
                    .runtime
                    .windows()
                    .map_err(|e| ComputerToolError::Automation(e.to_string()))?;
                Ok(ToolResult {
                    success: true,
                    output: json!({"windows": windows}),
                })
            }
            "computer.window.focus" => {
                let id = call
                    .arguments
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        ComputerToolError::InvalidArguments("missing string argument: id".into())
                    })?;
                self.runtime
                    .focus_window(id)
                    .map_err(|e| ComputerToolError::Automation(e.to_string()))?;
                Ok(ok())
            }
            _ => Err(ComputerToolError::InvalidArguments(format!(
                "unsupported computer tool: {}",
                call.name
            ))),
        }
    }
}

fn ok() -> ToolResult {
    ToolResult {
        success: true,
        output: json!({"ok": true}),
    }
}

pub fn register_computer_automation_definitions(
    registry: &mut ToolRegistry,
) -> Result<(), crate::ToolRegistryError> {
    let definitions = [
        (
            "computer.screen.capture",
            "Capture the current screen.",
            ToolRisk::ReadOnly,
            false,
        ),
        (
            "computer.mouse",
            "Move, click or scroll the host mouse.",
            ToolRisk::Mutating,
            true,
        ),
        (
            "computer.keyboard",
            "Type text or send keyboard keys/hotkeys to the host.",
            ToolRisk::Mutating,
            true,
        ),
        (
            "computer.window.list",
            "List visible host windows.",
            ToolRisk::ReadOnly,
            false,
        ),
        (
            "computer.window.focus",
            "Focus a host window by opaque window id.",
            ToolRisk::Mutating,
            true,
        ),
    ];
    for (name, description, risk, requires_approval) in definitions {
        registry.register(ToolDefinition {
            name: name.into(),
            description: description.into(),
            risk,
            requires_approval,
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ComputerPermissions, ScreenCapture, WindowInfo};
    use std::sync::Mutex;

    struct FakeBackend {
        calls: Mutex<Vec<String>>,
    }
    impl FakeBackend {
        fn new() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
            }
        }
    }
    impl ComputerBackend for FakeBackend {
        fn screenshot(&self) -> Result<ScreenCapture, crate::ComputerAutomationError> {
            self.calls.lock().unwrap().push("screen".into());
            Ok(ScreenCapture {
                width: 2,
                height: 1,
                format: "raw".into(),
                data: vec![1, 2],
            })
        }
        fn mouse(&self, _: MouseAction) -> Result<(), crate::ComputerAutomationError> {
            self.calls.lock().unwrap().push("mouse".into());
            Ok(())
        }
        fn keyboard(&self, _: KeyboardAction) -> Result<(), crate::ComputerAutomationError> {
            self.calls.lock().unwrap().push("keyboard".into());
            Ok(())
        }
        fn windows(&self) -> Result<Vec<WindowInfo>, crate::ComputerAutomationError> {
            self.calls.lock().unwrap().push("windows".into());
            Ok(vec![])
        }
        fn focus_window(&self, _: &str) -> Result<(), crate::ComputerAutomationError> {
            self.calls.lock().unwrap().push("focus".into());
            Ok(())
        }
    }

    #[test]
    fn exposes_read_and_mutating_tool_definitions_with_correct_risk() {
        let mut registry = ToolRegistry::default();
        register_computer_automation_definitions(&mut registry).unwrap();
        assert!(
            !registry
                .get("computer.screen.capture")
                .unwrap()
                .requires_approval
        );
        assert!(registry.get("computer.mouse").unwrap().requires_approval);
        assert_eq!(
            registry.get("computer.keyboard").unwrap().risk,
            ToolRisk::Mutating
        );
    }

    #[test]
    fn dispatches_screen_capture() {
        let backend = FakeBackend::new();
        let runtime = Arc::new(ComputerRuntime::new(backend, ComputerPermissions::all()));
        let tools = ComputerToolRuntime::new(runtime);
        let result = tools
            .execute(&ToolCall {
                name: "computer.screen.capture".into(),
                arguments: json!({}),
            })
            .unwrap();
        assert_eq!(result.output["width"], 2);
        assert_eq!(result.output["data"][0], 1);
    }

    #[test]
    fn validates_keyboard_payload() {
        let runtime = Arc::new(ComputerRuntime::new(
            FakeBackend::new(),
            ComputerPermissions::all(),
        ));
        let tools = ComputerToolRuntime::new(runtime);
        let result = tools.execute(&ToolCall {
            name: "computer.keyboard".into(),
            arguments: json!({"text":"hello"}),
        });
        assert!(matches!(
            result,
            Err(ComputerToolError::InvalidArguments(_))
        ));
    }
}
