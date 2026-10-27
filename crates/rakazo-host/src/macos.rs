use core_graphics::display::CGDisplay;
use core_graphics::event::{CGEvent, CGEventTapLocation, CGEventType, CGMouseButton};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use rakazo_core::{
    ComputerBackend, KeyboardAction, MouseAction, MouseButton, ScreenCapture, WindowInfo,
};
use std::process::Command;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MacOsHostError {
    #[error("macOS accessibility automation is unavailable: {0}")]
    Accessibility(String),
    #[error("macOS screen capture failed: {0}")]
    ScreenCapture(String),
    #[error("invalid automation request: {0}")]
    InvalidRequest(String),
}

/// Native macOS implementation of the platform-neutral Rakazo computer API.
///
/// Screen capture and HID input use CoreGraphics. Window enumeration/focus is
/// intentionally performed through System Events so the adapter can work with
/// arbitrary Cocoa applications without coupling the core crate to Objective-C
/// application models. macOS Accessibility permission is required for input
/// and window operations; Screen Recording permission is required for capture.
pub struct MacOsBackend;

impl MacOsBackend {
    pub fn new() -> Self {
        Self
    }

    fn capture_screen(&self) -> Result<ScreenCapture, MacOsHostError> {
        let image = CGDisplay::main().image().ok_or_else(|| {
            MacOsHostError::ScreenCapture(
                "CGDisplay::main().image() returned no image; grant Screen Recording permission"
                    .into(),
            )
        })?;

        let data = image.data();

        Ok(ScreenCapture {
            width: image.width() as u32,
            height: image.height() as u32,
            format: "raw".into(),
            data: data.bytes().to_vec(),
        })
    }

    fn post_mouse(&self, action: &MouseAction) -> Result<(), MacOsHostError> {
        let (event_type, button) = match action {
            MouseAction::Move { .. } => (CGEventType::MouseMoved, CGMouseButton::Left),
            MouseAction::Click { button, .. } => match button {
                MouseButton::Left => (CGEventType::LeftMouseDown, CGMouseButton::Left),
                MouseButton::Middle => (CGEventType::OtherMouseDown, CGMouseButton::Center),
                MouseButton::Right => (CGEventType::RightMouseDown, CGMouseButton::Right),
            },
            MouseAction::Scroll { .. } => {
                return Err(MacOsHostError::InvalidRequest(
                    "scroll is not yet supported by the CoreGraphics adapter".into(),
                ))
            }
        };

        let (x, y) = match action {
            MouseAction::Move { x, y } | MouseAction::Click { x, y, .. } => (*x as f64, *y as f64),
            MouseAction::Scroll { .. } => unreachable!(),
        };

        let source = hid_source()?;
        let event = CGEvent::new_mouse_event(source, event_type, CGPoint::new(x, y), button)
            .map_err(|_| {
                MacOsHostError::Accessibility(
                    "CGEvent could not be created; grant Accessibility permission".into(),
                )
            })?;
        event.post(CGEventTapLocation::HID);

        if matches!(action, MouseAction::Click { .. }) {
            let up_type = match button {
                CGMouseButton::Left => CGEventType::LeftMouseUp,
                CGMouseButton::Right => CGEventType::RightMouseUp,
                CGMouseButton::Center => CGEventType::OtherMouseUp,
            };
            if let Ok(up) =
                CGEvent::new_mouse_event(hid_source()?, up_type, CGPoint::new(x, y), button)
            {
                up.post(CGEventTapLocation::HID);
            }
        }
        Ok(())
    }

    fn post_keyboard(&self, action: &KeyboardAction) -> Result<(), MacOsHostError> {
        match action {
            KeyboardAction::Type { text } => {
                if text.len() > 16 * 1024 {
                    return Err(MacOsHostError::InvalidRequest(
                        "typed text exceeds 16 KiB".into(),
                    ));
                }
                for ch in text.encode_utf16() {
                    let event =
                        CGEvent::new_keyboard_event(hid_source()?, 0, true).map_err(|_| {
                            MacOsHostError::Accessibility("CGEvent could not be created".into())
                        })?;
                    event.set_string_from_utf16_unchecked(&[ch]);
                    event.post(CGEventTapLocation::HID);
                    let up =
                        CGEvent::new_keyboard_event(hid_source()?, 0, false).map_err(|_| {
                            MacOsHostError::Accessibility("CGEvent could not be created".into())
                        })?;
                    up.set_string_from_utf16_unchecked(&[ch]);
                    up.post(CGEventTapLocation::HID);
                }
            }
            KeyboardAction::Key { key } => {
                let code = keycode(key)?;
                post_key(code)?;
            }
            KeyboardAction::Hotkey { keys } => {
                if keys.is_empty() || keys.len() > 8 {
                    return Err(MacOsHostError::InvalidRequest(
                        "hotkey must contain 1 to 8 keys".into(),
                    ));
                }
                let codes = keys
                    .iter()
                    .map(|k| keycode(k))
                    .collect::<Result<Vec<_>, _>>()?;
                for code in &codes {
                    post_key_state(*code, true)?;
                }
                for code in codes.iter().rev() {
                    post_key_state(*code, false)?;
                }
            }
        }
        Ok(())
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>, MacOsHostError> {
        let script = r#"
            tell application "System Events"
                set rows to {}
                repeat with p in application processes whose background only is false
                    set pn to name of p
                    repeat with w in windows of p
                        set end of rows to (pn & "\t" & (name of w))
                    end repeat
                end repeat
                return rows as text
            end tell
        "#;
        let output = Command::new("/usr/bin/osascript")
            .args(["-e", script])
            .output()
            .map_err(|e| MacOsHostError::Accessibility(e.to_string()))?;
        if !output.status.success() {
            return Err(MacOsHostError::Accessibility(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        Ok(text
            .split(", ")
            .filter_map(|row| {
                let mut parts = row.splitn(2, '\t');
                let app = parts.next()?.trim().to_string();
                let title = parts.next()?.trim().to_string();
                if app.is_empty() && title.is_empty() {
                    return None;
                }
                Some(WindowInfo {
                    id: format!("{app}:{title}"),
                    title,
                    app,
                    focused: false,
                })
            })
            .collect())
    }

    fn focus_window(&self, id: &str) -> Result<(), MacOsHostError> {
        let (app, title) = id
            .split_once(':')
            .ok_or_else(|| MacOsHostError::InvalidRequest("window id must be app:title".into()))?;
        let script = format!(
            "tell application \"System Events\" to tell process {} to set frontmost to true\n",
            applescript_quote(app)
        );
        let output = Command::new("/usr/bin/osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| MacOsHostError::Accessibility(e.to_string()))?;
        if !output.status.success() {
            return Err(MacOsHostError::Accessibility(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        let _ = title;
        Ok(())
    }
}

impl Default for MacOsBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl ComputerBackend for MacOsBackend {
    fn screenshot(&self) -> Result<ScreenCapture, rakazo_core::ComputerAutomationError> {
        self.capture_screen()
            .map_err(|e| rakazo_core::ComputerAutomationError::Backend(e.to_string()))
    }

    fn mouse(&self, action: MouseAction) -> Result<(), rakazo_core::ComputerAutomationError> {
        self.post_mouse(&action)
            .map_err(|e| rakazo_core::ComputerAutomationError::Backend(e.to_string()))
    }

    fn keyboard(&self, action: KeyboardAction) -> Result<(), rakazo_core::ComputerAutomationError> {
        self.post_keyboard(&action)
            .map_err(|e| rakazo_core::ComputerAutomationError::Backend(e.to_string()))
    }

    fn windows(&self) -> Result<Vec<WindowInfo>, rakazo_core::ComputerAutomationError> {
        self.list_windows()
            .map_err(|e| rakazo_core::ComputerAutomationError::Backend(e.to_string()))
    }

    fn focus_window(&self, id: &str) -> Result<(), rakazo_core::ComputerAutomationError> {
        self.focus_window(id)
            .map_err(|e| rakazo_core::ComputerAutomationError::Backend(e.to_string()))
    }
}

fn hid_source() -> Result<CGEventSource, MacOsHostError> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| {
        MacOsHostError::Accessibility(
            "CGEventSource could not be created; grant Accessibility permission".into(),
        )
    })
}

fn post_key(code: u16) -> Result<(), MacOsHostError> {
    post_key_state(code, true)?;
    post_key_state(code, false)
}

fn post_key_state(code: u16, down: bool) -> Result<(), MacOsHostError> {
    let event = CGEvent::new_keyboard_event(hid_source()?, code, down).map_err(|_| {
        MacOsHostError::Accessibility(
            "CGEvent could not be created; grant Accessibility permission".into(),
        )
    })?;
    event.post(CGEventTapLocation::HID);
    Ok(())
}

fn keycode(key: &str) -> Result<u16, MacOsHostError> {
    let normalized = key.to_ascii_lowercase();
    let code = match normalized.as_str() {
        "a" => 0,
        "s" => 1,
        "d" => 2,
        "f" => 3,
        "h" => 4,
        "g" => 5,
        "z" => 6,
        "x" => 7,
        "c" => 8,
        "v" => 9,
        "b" => 11,
        "q" => 12,
        "w" => 13,
        "e" => 14,
        "r" => 15,
        "y" => 16,
        "t" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "=" => 24,
        "9" => 25,
        "7" => 26,
        "-" => 27,
        "8" => 28,
        "0" => 29,
        "]" => 30,
        "o" => 31,
        "u" => 32,
        "[" => 33,
        "i" => 34,
        "p" => 35,
        "l" => 37,
        "j" => 38,
        "k" => 40,
        "n" => 45,
        "m" => 46,
        "tab" => 48,
        "space" => 49,
        "enter" | "return" => 36,
        "escape" | "esc" => 53,
        "delete" | "backspace" => 51,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        "command" | "cmd" => 55,
        "shift" => 56,
        "capslock" => 57,
        "option" | "alt" => 58,
        "control" | "ctrl" => 59,
        "f1" => 122,
        "f2" => 120,
        "f3" => 99,
        "f4" => 118,
        "f5" => 96,
        "f6" => 97,
        "f7" => 98,
        "f8" => 100,
        "f9" => 101,
        "f10" => 109,
        "f11" => 103,
        "f12" => 111,
        _ => {
            return Err(MacOsHostError::InvalidRequest(format!(
                "unsupported macOS key: {key}"
            )))
        }
    };
    Ok(code)
}

fn applescript_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keycodes_are_deterministic() {
        assert_eq!(keycode("cmd").unwrap(), 55);
        assert_eq!(keycode("enter").unwrap(), 36);
        assert!(keycode("not-a-key").is_err());
    }

    #[test]
    fn applescript_values_are_escaped() {
        assert_eq!(applescript_quote("Safari"), "\"Safari\"");
        assert_eq!(applescript_quote("A\"B"), "\"A\\\"B\"");
    }
}
