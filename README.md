# 0xdot

English | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

![0xdot — AI teammates you actually own](./docs/readme-hero.png)

0xdot is an open-source platform for persistent AI teammates and self-hosted AI assistants. Run the stack on your own infrastructure, bring your own model providers, and give agents controlled access to computers, files, tools, memory and routines.

## Features

- Persistent agents with conversations, memory, routines and history
- Browser, terminal, file and graphical desktop automation
- Native desktop runtime built with Tauri 2 and Rust
- Human approval gates for mutating capabilities
- Native MCP server lifecycle and tool invocation
- OpenAI-compatible model providers
- Local-first agent state and durable memory
- Docker and remote computer providers
- Web, desktop and mobile clients
- Self-hosted deployment with PostgreSQL and Docker Compose

## Architecture

```text
                         0xdot
                           │
          ┌────────────────┼────────────────┐
          │                │                │
        Web UI          Tauri 2         Mobile
                           │
                    Native Rust Core
                           │
       ┌───────────┬───────┼────────┬───────────┐
       │           │       │        │           │
     Agents      Memory   Tools   Routines      MCP
       │           │       │        │           │
       └───────────┴───────┼────────┴───────────┘
                           │
                    Host capabilities
```

The native desktop path is Tauri 2. Electron remains only as a legacy compatibility/reference application and is excluded from the default build and release path.

## Quick start

Requirements:

- Node.js 22.22.2+ (22.x), Node.js 24.x, or Node.js 26+
- pnpm 9
- Docker
- Rust/Cargo for native desktop development

```bash
git clone https://github.com/alvaropaco/0xdot.git
cd 0xdot
cp .env.example .env
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
```

Open `http://127.0.0.1:5173` and create an account.

## Tauri desktop

The native desktop application uses Tauri 2 with the React/Vite web UI and a Rust runtime for native capabilities.

```bash
pnpm dev:tauri
```

The desktop runtime provides:

- Agent execution and model inference
- Durable local state and memory
- Approval-gated filesystem and process tools
- Native macOS computer automation with OS permission checks
- MCP stdio lifecycle and tool calls
- Background routines and scheduling
- Signed updater support

## Releases

Tauri releases are built for macOS Apple Silicon, macOS Intel, Linux x86_64 and Windows x86_64 by `.github/workflows/release-tauri.yml`.

Updater signing uses the GitHub Actions secrets:

```text
TAURI_UPDATER_PUBLIC_KEY
TAURI_SIGNING_PRIVATE_KEY
```

The current signing key is intentionally passwordless, so `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is not required.

The static updater manifest is published at:

```text
https://github.com/alvaropaco/0xdot/releases/latest/download/latest.json
```

## Development checks

```bash
pnpm lint
pnpm check
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm rust:check
pnpm rust:test
```

## Repository layout

```text
apps/       web, api, worker, desktop, mobile and public website
packages/   domain, contracts, persistence, adapters, UI and test tooling
crates/     native Rust agent, host and model runtimes
infra/      local services, updater and computer images
docs/       architecture, operations and release guides
```

## Documentation

- [Self-hosting](./docs/self-host.md)
- [Self-host secrets](./docs/self-host-secrets.md)
- [Computer runtime and isolation](./docs/computer-runtime.md)
- [Desktop releases](./docs/desktop-release.md)
- [Mobile releases](./docs/mobile-release.md)
- [Performance testing](./docs/performance.md)
- [Fleet management](./docs/fleet-management.md)

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. For security vulnerabilities, follow [SECURITY.md](./SECURITY.md) instead of filing a public issue.

0xdot is licensed under the [Apache License 2.0](./LICENSE).
