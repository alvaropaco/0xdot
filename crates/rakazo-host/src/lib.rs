#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod macos_permissions;

#[cfg(target_os = "macos")]
pub use macos::{MacOsBackend, MacOsHostError};
#[cfg(target_os = "macos")]
pub use macos_permissions::{preflight as macos_permission_preflight, MacOsPermissionState};

/// Returns the native host backend for the current desktop platform.
///
/// The core crate deliberately stays platform-neutral; this crate owns the
/// operating-system boundary used by the Tauri desktop shell.
#[cfg(target_os = "macos")]
pub fn native_backend() -> MacOsBackend {
    MacOsBackend::new()
}

#[cfg(not(target_os = "macos"))]
pub fn native_backend() {
    // Other platforms will be added as independent adapters. Keeping the
    // symbol available avoids forcing platform selection into rakazo-core.
}
