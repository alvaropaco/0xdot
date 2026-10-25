# Rakazo Rust Core

This directory is the beginning of the native Rakazo runtime migration.

## Direction

The long-term desktop architecture is:

```text
React UI
   │
Tauri IPC
   │
Rust Runtime
   ├── rakazo-core       domain and agent state
   ├── rakazo-runtime    orchestration and scheduling
   ├── rakazo-computer   filesystem/process/browser/desktop control
   ├── rakazo-mcp        MCP tool execution
   └── rakazo-connectors external integrations
```

The existing TypeScript implementation remains the source of production behavior while each bounded context is migrated and validated. We are deliberately avoiding a mechanical TypeScript-to-Rust translation.

## Migration order

1. Core domain state and events
2. Agent/task orchestration
3. Persistence and memory interfaces
4. Tool and MCP runtime
5. Computer runtime
6. Scheduler/routines
7. Tauri integration
8. Remove obsolete Node/Electron-only runtime code

## Compatibility rule

Rust must become the authoritative implementation for each migrated bounded context before the corresponding TypeScript implementation is removed. During the transition, adapters may bridge Rust and TypeScript, but domain behavior must not be duplicated indefinitely.
