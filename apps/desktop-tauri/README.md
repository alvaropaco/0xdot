# Rakazo Tauri Desktop

Tauri 2 desktop shell for Rakazo.

## Why this is a parallel shell

The existing Electron desktop application contains product logic that is already reusable by the web application and packages. The Tauri migration therefore keeps the React/Vite UI and introduces a small native compatibility bridge instead of rewriting the renderer.

```text
                 Shared Rakazo Web UI
                         │
              ┌──────────┴──────────┐
              │                     │
          Electron              Tauri 2
          (legacy)               (new)
              │                     │
        Node/Electron APIs      Rust commands
              │                     │
              └──────────┬──────────┘
                         │
                   Rakazo backend
```

## Development

Install the Tauri CLI with Rust/Cargo:

```bash
cargo install tauri-cli --version '^2.0.0' --locked
```

Then from the repository root:

```bash
pnpm install
pnpm dev:tauri
```

The Tauri shell starts the existing Vite web application and loads it in a native WebView.

## Current migration scope

Implemented:

- Tauri 2 application shell.
- React/Vite reuse without duplicating the Rakazo UI.
- Native window controls exposed through the existing `RakazoDesktop` contract.
- System-browser URL opening for OAuth.
- Compatibility bridge for the existing desktop-aware web code.
- Cross-platform bundle targets for macOS, Windows and Linux.
- Fail-closed host-computer access during migration.
- Existing Electron desktop remains untouched and can be used as the reference implementation.

Not yet migrated:

1. The Node `DesktopSandboxProvider` host-computer listener.
2. Docker Compose local-stack lifecycle and setup UI.
3. Electron auto-update replacement with Tauri updater/signing.
4. Full loopback OAuth callback capture.
5. Native badge support.
6. E2E packaging/signing/notarization pipelines.

The host-computer capability is intentionally **not** faked by the Tauri bridge. The current Electron implementation starts a credentialed local HTTP listener around `DesktopSandboxProvider`; shipping a Tauri build that merely reports this capability as available would create a security and functionality regression.

## Next migration phase

The next step is to extract the Electron-only native services into a standalone `desktop-runtime` package and ship that runtime as a Tauri sidecar. That sidecar should own:

- host-computer HTTP server;
- local computer consent/token storage;
- Docker/local-stack lifecycle;
- loopback OAuth callback server.

After that extraction, Electron and Tauri can share the same native runtime contract, allowing Electron to be retired without changing the agent runtime or web UI.
