# OpenAgent

Local-first macOS desktop workspace for multiple persistent AI coding agents.
Bun workspaces monorepo: a Bun sidecar daemon (`openagentd`) owns SQLite state and
serves a token-authenticated WebSocket API; a Tauri 2 + React desktop app spawns and
talks to it.

## Layout

- `packages/protocol` — `@openagent/protocol`: zod 4 schemas + the typed method map
  (`methodMap`) shared by daemon and UI. Single source of truth for the wire contract.
- `packages/daemon` — `@openagent/daemon`: `src/main.ts` is the sidecar entry.
  Args: `--data-dir <path>` (required), `--agents-root <path>` (default `~/OpenAgent/agents`).
  Token comes from `OPENAGENT_TOKEN` (required). Prints `OPENAGENT_READY {"port":N}` on
  stdout when listening on 127.0.0.1; all other logs go to stderr.
  Exits on SIGTERM/SIGINT and on stdin EOF. Migrations live in `src/db/migrations.ts`
  (ordered SQL array, tracked in `schema_migrations`). Agent delete is a soft delete;
  workspace folders are never removed.
- `apps/desktop` — Tauri 2 + React 19 + Vite + Tailwind 4. Rust spawns the sidecar via
  `tauri-plugin-shell`, parses the READY line, and exposes `daemon_connection` ->
  `{port, token}`. Frontend WS client: `src/lib/daemon.ts`.
- `spikes` — `acp-probe.ts` probes agent CLIs for ACP support:
  `bun spikes/acp-probe.ts <name> -- <cmd...>` writes `spikes/out/acp-<name>.json`.

## Verified commands (run from repo root)

- `bun install` — install workspace deps.
- `bun run build:daemon` — compile `openagentd-aarch64-apple-darwin` into
  `apps/desktop/src-tauri/binaries/` (Tauri externalBin naming).
- `bun run dev` — build the sidecar, then `tauri dev` (Vite on :1420).
- `bun run build:app` — `tauri build --debug --bundles app` ->
  `apps/desktop/src-tauri/target/debug/bundle/macos/OpenAgent.app`.
- `bun run test` — `bun test packages/daemon` (daemon e2e: spawns the real daemon).
- `bun run lint` — `biome check .`
- `bun run typecheck` — `tsc -p` for protocol, daemon, desktop (sequential).
- `cd apps/desktop/src-tauri && cargo check` — Rust side.

## Conventions

- Dependencies are pinned to exact versions.
- All client→daemon calls validate params with the protocol schemas; unknown methods
  and invalid params return `bad_request`.
- The daemon requires `Authorization: Bearer <token>` on `/health` and `?token=` on
  `/ws`; Origin headers outside the Tauri/localhost allowlist get 403.
