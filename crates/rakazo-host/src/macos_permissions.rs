#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MacOsPermissionState {
    pub screen_recording: bool,
    pub accessibility: bool,
}

/// Query macOS privacy permissions without prompting the user.
///
/// Prompting is intentionally left to the desktop UX so an agent cannot
/// silently change system privacy settings while executing a task.
pub fn preflight() -> MacOsPermissionState {
    unsafe {
        MacOsPermissionState {
            screen_recording: CGPreflightScreenCaptureAccess(),
            accessibility: AXIsProcessTrusted(),
        }
    }
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_is_copyable() {
        let state = MacOsPermissionState { screen_recording: true, accessibility: false };
        assert_eq!(state, state);
    }
}
