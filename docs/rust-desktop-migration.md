# 0xdot desktop: Rust runtime migration plan

Product target: **one Tauri binary per platform. No server, no Docker, no accounts.**
The Rust process inside the app is the whole backend — agents, tools, persistence,
scheduling — and the React UI ships inside the binary's resources. The user's
machine is the deployment.

This document plans the move from the current shape (TS API as the reference
implementation, Tauri as a thin shell pointing at a server origin) to that target.

## Where we are

- **TypeScript backend (reference):** `apps/api` exposes 39 RPC groups (~132
  procedures) via oRPC — threads, bots, computer, memory, routines, mcp,
  artifacts, boards/tickets, search, export, voice, messaging, settings.
  `packages/adapters/executor.ts` (~10k lines) is the agent execution core.
  Persistence is Postgres with row-level security.
- **Rust core (seed):** `crates/rakazo-core` (agent loop, executor, tools, mcp,
  memory, routine, events), `crates/rakazo-host` (macOS automation +
  permissions), `crates/rakazo-model-openai` (chat client). ~3.2k lines.
- **Shell:** `apps/desktop-tauri` already registers Tauri commands for
  `agent_*`, `routine_*`, `mcp_*`, `computer_*` — but the window still
  navigates to a configured server origin; the UI talks oRPC to a remote API.

## Target architecture

```text
React UI (apps/web, shipped as Tauri asset)
   │  typed IPC (tauri-specta), replacing the oRPC client
   ▼
Tauri Rust process
   ├── rakzo-app        command surface, state, events (SSE → tauri events)
   ├── rakazo-runtime   agent loop, tool dispatch, approvals, compaction
   ├── rakazo-store     SQLite (sqlx, migrations); files under app-data dir
   ├── rakazo-model     provider clients (OpenAI-compatible first, BYOK keys)
   ├── rakazo-mcp       MCP client (stdio + HTTP)
   ├── rakazo-host      OS computer: files, processes, screen, permissions
   └── rakazo-routines  local scheduler (cron), wakeups, usage totals
```

Cross-cutting rules:

1. **Behavior is ported, not invented.** Each context moves with a conformance
   check against the TS implementation's fixtures (`packages/testkit` journeys
   and unit tests are the oracle). Where TS behavior needs no server concept
   (tenancy, RLS, sessions) we delete it, not translate it.
2. **Single local owner.** Post-auth-removal, the TS side already has exactly
   one implicit owner; the Rust side starts with a single-user schema — no
   users/tenancy tables at all.
3. **BYOK stays.** Model connections (api key / base url / oauth-style) are the
   only external dependency; provider-neutral, stored encrypted at rest with
   the OS keychain (Keychain/DPAPI) like the TS secret store.
4. **The web/mobile/remote story is untouched until parity ships**, then decided
   separately (the TS stack remains deployable for anyone who wants a server).

## Milestones (each ends in a shippable DMG)

- **M0 — self-contained shell.** UI bundle ships inside the app; window loads
  local assets; a placeholder Rust command answers a health check. No remote
  origin required to launch. (Small: build pipeline + `server_origin` removal.)
- **M1 — vertical chat slice (the proof).** SQLite store for bots/threads/
  messages; create bot; send a message; the Rust agent loop streams a reply
  from a BYOK OpenAI-compatible key with two tools (`remember`,
  `read/write workspace file`); restart the app and the thread survives.
  This is the milestone that proves UI-over-IPC replaces oRPC end to end.
- **M2 — the computer.** `rakazo-host` becomes the sandbox "computer": shell
  commands with approvals, file tree, screenshots; takeover UX; approval rules
  and auto-review ported. This is the product's headline capability on desktop.
- **M3 — memory, artifacts, scratchpad.** MEMORY.md semantics, artifact
  store on disk, search over local content (FTS5).
- **M4 — routines & usage.** Native scheduler for crons/once routines, usage
  totals, the sidebar's routine surfaces.
- **M5 — MCP + integrations.** `mcp_*` (connect, tools, secrets per server),
  Composio-style connectors only if they still matter without a server.
- **M6 — parity sweep and decide-the-rest.** groups, boards/tickets, export,
  links, voice, messaging: per group, either port or consciously cut from the
  desktop product (cutting is a product decision, revisited here).

Out of scope by decision: any multi-tenant/server concepts (already removed:
accounts, billing); mobile push; hosted providers.

## Key decisions to lock before M1

1. **IPC contract:** tauri-specta (TS types generated from Rust) vs a JSON-RPC
   shim that keeps the existing oRPC client shape. Recommendation: tauri-specta
   + a thin `rpc` adapter in the web app so components keep calling
   `rpc.bots.create(...)`-style APIs while transport swaps.
2. **Streaming:** oRPC event iterators → Tauri channels/events; the UI's
   thread-events reducer already consumes discrete events, so this maps
   cleanly.
3. **Store:** sqlx + checked-in SQL migrations; no ORM. Document-level
   columns (thread blocks, memory docs) stay JSONB-shaped (SQLite JSON).
4. **Where `apps/web` goes:** it remains the UI; the Electron app
   (`apps/desktop`) becomes redundant once parity ships and is archived.

## Risks

- **Executor semantics are the deep part:** compaction, steering, tool-call
  accounting, model-error classification. Mitigation: M1 deliberately runs
  without compaction; M2+ ports behaviors behind the conformance fixtures.
- **macOS-only first.** `rakazo-host` is macOS today; Windows/Linux polish is
  sequenced after M2, not before.
- **Two backends live in the repo for a while.** The TS stack is frozen for
  features (bug fixes only) from the moment M1 is signed off, so behavior
  deltas surface as port bugs, not moving targets.
