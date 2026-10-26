# Rakazo Tauri Desktop

Tauri 2 is the native desktop shell for Rakazo. The React/Vite renderer is shared with the web application while native agent execution, computer automation, filesystem/process access, memory, routines, approvals and MCP are implemented in Rust.

```text
                 Shared Rakazo Web UI
                         │
                    Tauri 2 Shell
                         │
                  @rakazo/desktop-api
                         │
                    Rust Runtime
        ┌────────────────┼────────────────┐
      Agent            Tools          Scheduler
        │                │                  │
     Memory         Computer/MCP        Routines
                         │
                    OS host adapters
```

## Development

Install Rust/Cargo and run:

```bash
pnpm install
pnpm dev:tauri
```

## Native capabilities

- Rust agent execution with OpenAI-compatible providers.
- Durable local agent state and memory.
- Human approval gates with timeout/failure handling.
- Sandboxed workspace filesystem.
- Host filesystem access under the user's home directory.
- Capability-scoped host process execution with allowlists, timeouts and output limits.
- Native macOS computer automation with privacy permission preflight.
- Native MCP stdio server lifecycle and tool invocation.
- Durable routines and background execution.
- Deep-link and single-instance support.
- Tauri updater integration and signed release pipeline.
- Stable React-facing `@rakazo/desktop-api` boundary.

## Migration status

Tauri is now the **primary native desktop architecture**. Electron is retained only as a legacy compatibility/reference application while downstream product code is migrated away from its APIs.

The Tauri runtime intentionally fails closed when an OS capability is unavailable. It does not emulate permissions or claim unsupported host automation.

## Release

Stable Tauri releases are produced by `.github/workflows/release-tauri.yml` for macOS Apple Silicon/Intel, Linux and Windows. Signed updater artifacts require the repository secrets `TAURI_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
