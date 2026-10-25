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
  The auth token is the first line on stdin (required; never via env, so agent CLIs can't
  read it). Prints `OPENAGENT_READY {"port":N}` on
  stdout when listening on 127.0.0.1; all other logs go to stderr.
  Exits on SIGTERM/SIGINT and on stdin EOF. Migrations live in `src/db/migrations.ts`
  (ordered SQL array, tracked in `schema_migrations`). Agent delete is a soft delete;
  workspace folders are never removed.
- `apps/desktop` — Tauri 2 + React 19 + Vite + Tailwind 4. Rust spawns the sidecar via
  `tauri-plugin-shell`, parses the READY line, and exposes `daemon_connection` ->
  `{port, token}`. Frontend WS client: `src/lib/daemon.ts`.
- `spikes` — `acp-probe.ts` probes agent CLIs for ACP support:
  `bun spikes/acp-probe.ts <name> -- <cmd...>` writes `spikes/out/acp-<name>.json`.
- `scripts/smoke-acp-real.ts` — runs the compiled daemon with a Finder-like PATH
  and drives devin/cursor/grok/opencode through a real prompt + restart + session
  resume: `bun scripts/smoke-acp-real.ts` -> `spikes/out/phase2-real-smoke.json`.

## Chat runtime (Phase 2)

Each agent gets a lazy `AgentRuntime` (`packages/daemon/src/runtime/`) that owns one
provider session at a time. Turns stream ACP updates into `items` rows; permission
requests pause in `awaiting_permission` until `permissions.respond`. Cancel sends
`session/cancel` and hard-kills after `OPENAGENT_CANCEL_GRACE_MS` (default 10000).
On daemon start, turns left `running` are marked `interrupted`. Provider CLIs are
found via a login-shell PATH merge (`src/env/login-path.ts`) — spawned agents get
`NO_COLOR=1` and a resolved absolute binary path.

Daemon auth: the token is delivered on the FIRST STDIN LINE (never env — provider
children must not see it). Missing/empty token or no line within 10 s -> exit 2.
stdin EOF afterwards = shutdown. `spawnEnv` strips all `OPENAGENT_*` vars.

Env vars (daemon):
- `OPENAGENT_ACP_COMMAND_<PROVIDER>` — JSON array overriding the spawn command per
  provider (e.g. `OPENAGENT_ACP_COMMAND_DEVIN='["bun","path/to/agent.ts"]'`).
- `OPENAGENT_CANCEL_GRACE_MS` — ms after `chat.cancel` before the process is killed.

Sign-in commands surfaced on auth errors: `devin auth login`, `agent login`,
`grok login`, `opencode auth login` (all verified via --help). Gemini: `gemini`
interactive sign-in — UNVERIFIED, CLI not installed.

`bun run smoke:ui` — real-Chrome UI smoke (playwright-core, dev-only
`location.hash` connect path in daemon.ts — dead code in prod builds).

Tests drive `packages/daemon/test/fixtures/fake-acp-agent.ts` (an ACP-speaking fake
that logs requests to `$FAKE_ACP_STATE_DIR/log.jsonl` and its pid to `pids.txt`).

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
