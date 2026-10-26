//! Capability-scoped desktop automation primitives.
//!
//! The core owns the command model, authorization policy and lifecycle. OS-specific
//! input/window/screen implementations are supplied through `ComputerBackend`.
//! This keeps the Rust agent runtime independent from Tauri and platform APIs.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ComputerCapability {
    Screen,
    Mouse,
    Keyboard,
    Window,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MouseAction {
    Move { x: i32, y: i32 },
    Click { x: i32, y: i32, button: MouseButton },
    Scroll { x: i32, y: i32, delta: i32 },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum KeyboardAction {
    Type { text: String },
    Key { key: String },
    Hotkey { keys: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowInfo {
    pub id: String,
    pub title: String,
    pub app: String,
    pub focused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScreenCapture {
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum ComputerAutomationError {
    #[error("capability is not permitted: {0:?}")]
    CapabilityDenied(ComputerCapability),
    #[error("invalid automation request: {0}")]
    InvalidRequest(String),
    #[error("backend error: {0}")]
    Backend(String),
}

/// OS adapter implemented by Tauri/platform crates, never by the agent core.
pub trait ComputerBackend: Send + Sync {
    fn screenshot(&self) -> Result<ScreenCapture, ComputerAutomationError>;
    fn mouse(&self, action: MouseAction) -> Result<(), ComputerAutomationError>;
    fn keyboard(&self, action: KeyboardAction) -> Result<(), ComputerAutomationError>;
    fn windows(&self) -> Result<Vec<WindowInfo>, ComputerAutomationError>;
    fn focus_window(&self, id: &str) -> Result<(), ComputerAutomationError>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ComputerPermissions {
    pub screen: bool,
    pub mouse: bool,
    pub keyboard: bool,
    pub window: bool,
}

impl ComputerPermissions {
    pub const fn all() -> Self {
        Self {
            screen: true,
            mouse: true,
            keyboard: true,
            window: true,
        }
    }

    fn allows(self, capability: ComputerCapability) -> bool {
        match capability {
            ComputerCapability::Screen => self.screen,
            ComputerCapability::Mouse => self.mouse,
            ComputerCapability::Keyboard => self.keyboard,
            ComputerCapability::Window => self.window,
        }
    }
}

pub struct ComputerRuntime<B> {
    backend: B,
    permissions: ComputerPermissions,
}

impl<B: ComputerBackend> ComputerRuntime<B> {
    pub fn new(backend: B, permissions: ComputerPermissions) -> Self {
        Self {
            backend,
            permissions,
        }
    }

    pub fn screenshot(&self) -> Result<ScreenCapture, ComputerAutomationError> {
        self.require(ComputerCapability::Screen)?;
        self.backend.screenshot()
    }

    pub fn mouse(&self, action: MouseAction) -> Result<(), ComputerAutomationError> {
        self.require(ComputerCapability::Mouse)?;
        self.backend.mouse(action)
    }

    pub fn keyboard(&self, action: KeyboardAction) -> Result<(), ComputerAutomationError> {
        self.require(ComputerCapability::Keyboard)?;
        if let KeyboardAction::Type { ref text } = action {
            if text.len() > 16_384 {
                return Err(ComputerAutomationError::InvalidRequest(
                    "typed text exceeds 16 KiB".into(),
                ));
            }
        }
        self.backend.keyboard(action)
    }

    pub fn windows(&self) -> Result<Vec<WindowInfo>, ComputerAutomationError> {
        self.require(ComputerCapability::Window)?;
        self.backend.windows()
    }

    pub fn focus_window(&self, id: &str) -> Result<(), ComputerAutomationError> {
        self.require(ComputerCapability::Window)?;
        if id.trim().is_empty() {
            return Err(ComputerAutomationError::InvalidRequest(
                "window id cannot be empty".into(),
            ));
        }
        self.backend.focus_window(id)
    }

    fn require(&self, capability: ComputerCapability) -> Result<(), ComputerAutomationError> {
        if self.permissions.allows(capability) {
            Ok(())
        } else {
            Err(ComputerAutomationError::CapabilityDenied(capability))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        fn screenshot(&self) -> Result<ScreenCapture, ComputerAutomationError> {
            self.calls.lock().unwrap().push("screen".into());
            Ok(ScreenCapture {
                width: 1,
                height: 1,
                format: "raw".into(),
                data: vec![0],
            })
        }
        fn mouse(&self, _: MouseAction) -> Result<(), ComputerAutomationError> {
            self.calls.lock().unwrap().push("mouse".into());
            Ok(())
        }
        fn keyboard(&self, _: KeyboardAction) -> Result<(), ComputerAutomationError> {
            self.calls.lock().unwrap().push("keyboard".into());
            Ok(())
        }
        fn windows(&self) -> Result<Vec<WindowInfo>, ComputerAutomationError> {
            self.calls.lock().unwrap().push("windows".into());
            Ok(vec![])
        }
        fn focus_window(&self, _: &str) -> Result<(), ComputerAutomationError> {
            self.calls.lock().unwrap().push("focus".into());
            Ok(())
        }
    }

    #[test]
    fn enforces_capability_permissions() {
        let runtime = ComputerRuntime::new(
            FakeBackend::new(),
            ComputerPermissions {
                keyboard: true,
                ..Default::default()
            },
        );
        assert!(matches!(
            runtime.screenshot(),
            Err(ComputerAutomationError::CapabilityDenied(
                ComputerCapability::Screen
            ))
        ));
        assert!(runtime
            .keyboard(KeyboardAction::Key {
                key: "Enter".into()
            })
            .is_ok());
    }

    #[test]
    fn rejects_excessive_typed_text() {
        let runtime = ComputerRuntime::new(FakeBackend::new(), ComputerPermissions::all());
        let text = "x".repeat(16_385);
        assert!(matches!(
            runtime.keyboard(KeyboardAction::Type { text }),
            Err(ComputerAutomationError::InvalidRequest(_))
        ));
    }

    #[test]
    fn delegates_to_backend() {
        let backend = FakeBackend::new();
        let runtime = ComputerRuntime::new(backend, ComputerPermissions::all());
        runtime
            .mouse(MouseAction::Click {
                x: 10,
                y: 20,
                button: MouseButton::Left,
            })
            .unwrap();
        runtime.windows().unwrap();
    }
}
