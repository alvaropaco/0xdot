# rakazo-host

Platform adapters for Rakazo's native computer runtime.

## macOS

`MacOsBackend` implements the `rakazo-core::ComputerBackend` contract.

Capabilities:

- Screen capture through CoreGraphics.
- Mouse movement/click through HID `CGEvent`.
- Keyboard text, keys and hotkeys through HID `CGEvent`.
- Window enumeration and foreground activation through System Events.

### Required permissions

The host application must be granted:

- **Screen Recording** for `computer.screen.capture`.
- **Accessibility** for mouse, keyboard and window automation.

The adapter intentionally fails closed when macOS denies the operation. Permission prompts and user-facing permission management belong to the Tauri shell.

### Security boundary

`rakazo-core` remains OS-independent. `rakazo-host` is the only layer that talks to macOS APIs/processes. Agent policy, tool risk classification and human approval continue to be enforced by the core tool runtime before this backend is invoked.
