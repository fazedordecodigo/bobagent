# BobAgent

Local-first macOS desktop workspace for multiple persistent AI coding agents.
Bun workspaces monorepo: a Bun sidecar daemon (`bobagentd`) owns SQLite state and
serves a token-authenticated WebSocket API; a Tauri 2 + React desktop app spawns and
talks to it.

## Layout

- `packages/protocol` — `@bobagent/protocol`: zod 4 schemas + the typed method map
  (`methodMap`) shared by daemon and UI. Single source of truth for the wire contract.
- `packages/daemon` — `@bobagent/daemon`: `src/main.ts` is the sidecar entry.
  Args: `--data-dir <path>` (required), `--agents-root <path>` (default `~/BobAgent/agents`).
  The auth token is the first line on stdin (required; never via env, so agent CLIs can't
  read it). Prints `BOBAGENT_READY {"port":N}` on
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
`session/cancel` and hard-kills after `BOBAGENT_CANCEL_GRACE_MS` (default 10000).
On daemon start, turns left `running` are marked `interrupted`. Provider CLIs are
found via a login-shell PATH merge (`src/env/login-path.ts`) — spawned agents get
`NO_COLOR=1` and a resolved absolute binary path.

Daemon auth: the token is delivered on the FIRST STDIN LINE (never env — provider
children must not see it). Missing/empty token or no line within 10 s -> exit 2.
stdin EOF afterwards = shutdown. `spawnEnv` strips all `BOBAGENT_*` vars.

Env vars (daemon):
- `BOBAGENT_ACP_COMMAND_<PROVIDER>` — JSON array overriding the spawn command per
  provider (e.g. `BOBAGENT_ACP_COMMAND_DEVIN='["bun","path/to/agent.ts"]'`).
- `BOBAGENT_CANCEL_GRACE_MS` — ms after `chat.cancel` before the process is killed.

Sign-in commands surfaced on auth errors: `devin auth login`, `agent login`,
`grok login`, `opencode auth login`, `claude auth login`, `codex login` (all verified via --help). Gemini: `gemini`
interactive sign-in — UNVERIFIED, CLI not installed.

`bun run smoke:ui` — real-Chrome UI smoke (playwright-core, dev-only
`location.hash` connect path in daemon.ts — dead code in prod builds).

Tests drive `packages/daemon/test/fixtures/fake-acp-agent.ts` (an ACP-speaking fake
that logs requests to `$FAKE_ACP_STATE_DIR/log.jsonl` and its pid to `pids.txt`).

## Queue + config (Phase 3)

`chat.send` always enqueues (`queue` table, status queued|started|removed); the runtime
drains oldest-first while idle and unpaused. User `chat.cancel` pauses the queue when
items remain; a `failed` turn auto-pauses. `queue.get/remove/pause/resume` +
`queue.updated` events. `Agent.config` (configId->value) is applied to every new
provider session before its first prompt via `session/set_config_option`;
`DEFAULT_MODE` in `src/providers/index.ts` picks the safe per-provider mode
(devin=accept-edits, cursor=agent, opencode=build — measured by `spikes/mode-probe.ts`;
never a bypass/auto-approve value). `agents.configOptions` starts a session to read
options; `agents.setConfig` validates against live options (busy while a turn runs).
New (non-resumed) sessions with prior history get a `<conversation_history>` block
(`src/runtime/handoff.ts`, pure fn) before the first prompt.

`spikes/mode-probe.ts` — per provider x mode permission probe -> `spikes/out/mode-probe.json`.
- `BOBAGENT_DEBUG_PROMPTS_DIR` — when set, the daemon writes every outgoing prompt to
  `<dir>/<agentId>-<turnId>.txt` (debugging only).

## Native Claude + Codex (Phase 4)

`src/providers/index.ts` routes providers: `claude` -> `ClaudeDriver` (`claude.ts`),
`codex` -> `CodexDriver` (`codex.ts`), everything else -> ACP (`acp.ts`). Shared spawn,
stderr tail, JSONL and auth helpers live in `process.ts`.
- Claude: `claude --output-format stream-json --input-format stream-json --verbose
  --include-partial-messages --permission-prompt-tool stdio --permission-mode default`
  plus `--session-id <uuid>` (new) or `--resume <id>`; a failed resume falls back to a
  new session. Approvals arrive as `can_use_tool` control requests; cancel sends an
  `interrupt` control request. Config: `mode` (default/acceptEdits/plan, never bypass) and
  `model` (from the initialize response), applied via `set_permission_mode`/`set_model`.
- Codex: `codex app-server --listen stdio://` (JSON-RPC lines, no `jsonrpc` field):
  `initialize` -> `initialized` -> `account/read` (signed out -> `auth_required`) ->
  `thread/resume` or `thread/start` -> `model/list`. Turns are `turn/start`, cancel is
  `turn/interrupt`; command/file approvals map to accept/acceptForSession/decline/cancel.
  Config: `mode` (auto = workspace-write, read-only; both `on-request`), `model`, `effort`,
  sent with each `turn/start`.
- Verified against real CLIs (signed out) on the VM: claude 2.1.310, codex-cli 0.164.0.
- `BOBAGENT_PROVIDER_COMMAND_<PROVIDER>` overrides any provider's spawn command
  (`BOBAGENT_ACP_COMMAND_<PROVIDER>` still works). Tests use
  `test/fixtures/fake-claude.ts` / `fake-codex.ts` (`$FAKE_CLAUDE_STATE_DIR`,
  `$FAKE_CODEX_STATE_DIR`, `FAKE_CODEX_NO_AUTH=1`) from `test/native.e2e.test.ts`.

## Agent-to-agent bridge (Phase 5)

Every provider session gets a `bobagent` stdio MCP server: the daemon binary run as
`bobagentd mcp-bridge` (dev: `bun src/main.ts mcp-bridge`), with
`BOBAGENT_BRIDGE_URL`/`BOBAGENT_BRIDGE_TOKEN` in its env. The token is per agent,
regenerated each daemon start, and never the daemon's main token. The bridge forwards
`tools/list`/`tools/call` to `POST /bridge` (Bearer bridge token; any Origin header ->
403). Passed via ACP `mcpServers`, Claude `--mcp-config`, Codex `thread/start.config`
(`mcp_servers.bobagent`). Tools (`src/bridge.ts`):
- `list_agents`, `send_message {to, text}`: enqueues on the recipient with
  `queue.from_agent_id` + `hops` (migration 5). The recipient's prompt is framed by
  `<agent_message_context>` (`wrapAgentMessage`); its `user_message` item has `from`.
  Chains stop at `MAX_HOPS` (6).
- `share_file {to, path, note?}`: only regular files inside the sender workspace, max 100 MB.
  It copies the file to `<shared>/Transfers/<id>/` with `manifest.json` (sha256), delivers it
  to `<recipient ws>/transfers/<id>/<name>`, and notifies the recipient. Shared root is
  `BOBAGENT_SHARED_ROOT` or `dirname(agentsRoot)/Shared` (default `~/BobAgent/Shared`).
Tests: `test/bridge.e2e.test.ts` (the fake ACP agent's `mcp:<tool> <json>` prompt
spawns the real bridge and calls the tool).

## Channels (Phase 6)

`src/channels.ts` (`ChannelService`, migration 6: `channels`, `channel_members`,
`channel_messages`, `queue.channel_id` + `queue.prompt`). RPC `channels.list/create/
history/post/stop/resume/archive/restore/reassign/setMembers`; events `channel.created`,
`channel.updated`, `channel.message`. A user post goes to the owner (default: first
member) as a queue item whose provider prompt (`queue.prompt`) carries a
`<channel_context>` block with role and recent transcript. When a channel turn ends
(`turn.ended` hook in `main.ts`), the agent's reply is posted to the channel, and a
member's reply is forwarded to the owner (hop-limited by `MAX_HOPS`). Bridge tools
`list_channels` and `delegate {channel, to, task}` (members only). Stop/archive remove
queued channel items and cancel running channel turns; posting needs `active`.
UI: sidebar "Channels" + `components/ChannelView.tsx`. Tests: `test/channels.e2e.test.ts`.

## Usage + compaction (Phase 7)

Providers emit `{type:"usage"}` updates (ACP `usage_update` + `PromptResponse.usage`,
Claude `result.usage`/`total_cost_usd`/`modelUsage.contextWindow`, Codex
`thread/tokenUsage/updated`). `agent_usage` (migration 7) stores the context snapshot
(`usedTokens`/`contextWindow`) and cumulative in/out tokens and cost; `agents.usage` RPC +
`agent.usage` event; UI `components/UsageBar.tsx`. Compaction (`AgentRuntime.compact`, via
`agents.compact` or automatically after a completed turn when used/window >=
`BOBAGENT_COMPACT_THRESHOLD`, default 0.85, `off` disables): the agent answers a
`<compaction_request>` prompt (output captured, permissions denied, timeout
`BOBAGENT_COMPACT_TIMEOUT_MS`), the provider session is dropped and forgotten, and a
`compaction` chat item stores the summary. The next fresh session gets
`<conversation_summary>` plus only the history after it. The queue waits while compacting.
Tests: `test/usage.e2e.test.ts`.

## Avatars, memories, skills, agent creation (Phase 8)

`Agent.avatar` (`{emoji,color}` or null, `agents.avatar_json`, migration 8). `agents.draft
{prompt}` (`src/draft.ts`, deterministic) proposes name/instructions/avatar for the create
form. Memories: `memories` table, `MemoryStore` (`src/memories.ts`), RPC
`memories.list/add/update/delete`, event `memories.changed`. Skills library:
`<shared>/Skills/<name>/SKILL.md` with name/description/author frontmatter, previous versions
in `.history/` (`src/skills.ts`), RPC `skills.list/get/save/delete`, event `skills.changed`.
Bridge tools: `remember`, `forget`, `list_memories`, `list_skills`, `read_skill`,
`create_skill`, `revise_skill`, `create_agent`. The first prompt of every fresh session is
prefixed with `<agent_memories>` and `<skills_library>` (index only). UI:
`components/Library.tsx`. Tests: `test/phase8.e2e.test.ts`.

## Routines + attachments (Phase 9)

Routines (`src/routines.ts`, migration 9: `routines`, `routine_runs`) are saved prompts sent
to an agent with `trigger` schedule|webhook|manual. Schedules: `every <n>m|h|d`, `daily HH:MM`,
`weekly <day> HH:MM` (local time); the scheduler ticks every `BOBAGENT_ROUTINE_TICK_MS`
(default 30000) and collapses missed runs into one. Webhooks: `POST /hooks/<routineId>` with
`Authorization: Bearer <webhookToken>` (per-routine token; Origin rejected), body passed as
`<webhook_payload>` (20 KB cap). RPC `routines.list/create/update/delete/run/runs`, events
`routine.updated`/`routine.deleted`. The prompt is wrapped in `<routine name trigger>`;
`queue.meta_json` puts `routine`/`attachments` on the user_message item.
Attachments: `chat.send {attachments:[{name,mime,dataBase64}]}` (max 10, 25 MB total) are
written to `<workspace>/attachments/<id>/` (`src/attachments.ts`, basename-sanitized, ZIPs
extracted with `unzip`) and listed in an `<attachments>` block. Tests: `test/phase9.e2e.test.ts`.

## Agent browser (Phase 10)

`src/browser.ts`: one Chromium-family browser (Chrome/Chromium/Edge/Brave, or
`BOBAGENT_BROWSER_PATH`) launched lazily with `--remote-debugging-port=0` and its own profile
(`<data-dir>/browser-profile`, port read from `DevToolsActivePort`), driven over CDP (flattened
`Target.attachToTarget` sessions). Each agent gets one tab. Bridge tools: `browser_open`
(http/https only), `browser_snapshot` (numbered interactive elements via `data-bob-ref` + page
text), `browser_click`, `browser_type`, `browser_press`, `browser_back`, `browser_screenshot`
(PNG into `<workspace>/browser/`), `browser_close`. RPC `browser.status/closeTab/close`, event
`browser.updated`; UI `BrowserView`. `BOBAGENT_BROWSER=off` disables it,
`BOBAGENT_BROWSER_HEADLESS=1` for tests. Tests: `test/browser.e2e.test.ts` (skipped when no
browser is installed).

## Vault, connectors, Computer Use, voice (Phase 11)

Vault (`src/vault.ts`, migration 10 `vault` + `settings`): AES-256-GCM secrets; key in the
macOS Keychain (service `BobAgent`, account `vault-key`), else `<data-dir>/vault.key`;
`BOBAGENT_VAULT_KEY` (64 hex) overrides for tests. Per-secret agent allowlist. RPC
`vault.list/set/setAccess/delete` (values never returned), event `vault.changed`; bridge
`vault_list`, `vault_get`. Connectors (`src/connectors.ts`) use shared secrets without
returning them: `connector.github` -> `github_api` (REST proxy, token redacted,
`BOBAGENT_GITHUB_API` for tests); `connector.1password` -> `onepassword_read` (`op read`,
optional service-account token); `connector.bitwarden` -> `bitwarden_get` (`bw get`,
BW_SESSION). `BOBAGENT_OP_COMMAND`/`BOBAGENT_BW_COMMAND` override the CLIs.
Computer Use (`src/computer.ts`, macOS): off per agent until `computer.setAccess`; bridge
`computer_screenshot` (screencapture), `computer_click` (CoreGraphics via JXA),
`computer_type`, `computer_key` (System Events, whitelisted keys/modifiers);
`BOBAGENT_COMPUTER_DRYRUN=<file>` logs commands instead (tests).
Voice (`src/voice.ts`): `voice.speak/stop` (`say`, or `BOBAGENT_TTS_COMMAND` with text on
stdin), `voice.transcribe` (`BOBAGENT_STT_COMMAND` with `{file}`, or `whisper` on PATH),
`voice.status`. UI: Vault view, Computer Use toggle, composer mic, read-aloud button;
`src-tauri/Info.plist` has the microphone usage string. Tests: `test/phase11.e2e.test.ts`.

## Messaging gateways (Phase 12a)

`src/gateways/` connects Telegram (Bot API long polling), Slack (Socket Mode: `auth.test`,
`apps.connections.open`, envelope acks, `chat.postMessage` in thread) and Discord (Gateway v10:
Hello/Identify/heartbeat/READY/MESSAGE_CREATE, intents incl. MESSAGE_CONTENT; REST replies)
to an agent. Migration 11 `gateways`; tokens in the vault as `gateway.<id>.<field>` (hidden
from `vault.list`, never shared with agents). Only `allowedUsers` reach the agent (others get
their id back); `@AgentName text` routes to another agent; in Slack/Discord channels only
mentions count, DMs always. Prompt is wrapped in `<external_message>`; the queue
`meta_json.gateway` drives the reply on `turn.ended`. RPC `gateways.list/create/update/delete`,
events `gateway.updated/deleted`; UI `GatewaysView`. Test base URLs:
`BOBAGENT_TELEGRAM_API`, `BOBAGENT_SLACK_API`, `BOBAGENT_DISCORD_API`.
Tests: `test/gateways.e2e.test.ts`.

## Marketplace (Phase 12b)

`marketplace/` holds the default registry (`index.json` + `skills/*.md` + `agents/*.json`),
fetched from raw.githubusercontent.com (`BOBAGENT_MARKETPLACE_URL` overrides; user sources in
`settings.marketplace_sources`, http(s)/file URLs). `src/marketplace.ts` verifies each file's
sha256 before installing; skills go to the skills library (author `marketplace:<author>`),
agent templates create an agent (chosen provider) and install their listed skills. RPC
`marketplace.list/install/setSources`; UI `MarketplaceView`. Regenerate the index with
`bun scripts/marketplace-index.ts`. Tests: `test/marketplace.e2e.test.ts`.

## Mobile companion (Phase 12c)

`src/mobile.ts` + `src/mobile-app.ts` (vanilla JS PWA as a string): opt-in LAN
server (`mobile.enable`, `0.0.0.0`, port remembered in `settings.mobile`;
`BOBAGENT_MOBILE_HOST`/`BOBAGENT_MOBILE_PORT` override). Pairing: `mobile.pair` shows a
6-digit code (5 min, 5 attempts) -> `POST /api/pair` returns a device token (sha256 stored in
`mobile_devices`, migration 12). Devices call `POST /api/rpc` with an allowlist (agents.list/
statuses, chat.history/send/cancel, queue.get, permissions.list/respond; no attachments) and
read chat events from `GET /api/events` (SSE, `?token=`). Foreign Origins get 403.
RPC `mobile.status/enable/pair/revoke`; UI `MobileView`. Tests: `test/mobile.e2e.test.ts`.

## Teams (Phase 12d)

`packages/relay` (`bun run relay -- --data ./relay-data [--port 8787] [--host 0.0.0.0]`) is a
self-hostable Bun relay: admin token (`RELAY_ADMIN_TOKEN` or `<data>/admin-token`) manages
members (`POST/GET /members`, `DELETE /members/:id`, tokens stored hashed in `team.json`);
members connect to `/ws?token=` and exchange `share` / `send` / `incoming` / `reply` frames.
No chat content is stored on the relay. Daemon side `src/team.ts` (`settings.team`, token in
the vault as `team.token`, hidden from `vault.list`, migration 13 `team_messages`): shares
selected agents, runs incoming messages as `<team_message>` turns and replies on `turn.ended`.
RPC `team.status/connect/disconnect/share/send/messages`, events `team.updated/message`;
UI `TeamView`. Tests: `test/team.e2e.test.ts` (spawns the relay).

## CI, releases, updates, branding

- `.github/workflows/ci.yml` (macos-14): lint, typecheck, test, build:daemon, cargo check, vite build.
- `.github/workflows/release.yml`: on `v*` tags, tauri-action builds `.app` + `.dmg` with
  `createUpdaterArtifacts`, publishes a GitHub release with `latest.json`. Updater signing
  uses the `TAURI_SIGNING_PRIVATE_KEY` repo secret (pubkey in `tauri.conf.json`
  `plugins.updater`); Apple signing/notarization turn on when `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (+ `APPLE_ID`, `APPLE_PASSWORD`,
  `APPLE_TEAM_ID`) secrets exist. Bump `version` in `tauri.conf.json` before tagging.
- In-app updates: `tauri-plugin-updater` + `components/UpdateButton.tsx` (sidebar footer).
- Icon source: `apps/desktop/branding/icon.svg` -> `icon.png` (Chrome headless render) ->
  `bunx tauri icon branding/icon.png` (from `apps/desktop`).

## Remote hosts, Firecracker, subagents

`src/remote/hosts.ts` (`HostStore`, migration 14: `hosts`, `agent_placement`, `subagents`).
RPC `hosts.list/create/update/delete/install/check`, `placements.list/set`, `subagents.list`;
events `hosts.changed`, `placement.updated`, `subagent.updated`; UI `components/HostsView.tsx`
(Settings → Hosts). SSH runs the system `ssh` with `BatchMode=yes`,
`StrictHostKeyChecking=accept-new`, keepalives, `-p`, optional `-i`, then `--` and the target
(validated by `SshTarget`, so it cannot be an option); remote commands are single-quoted.
`BOBAGENT_SSH_COMMAND` (JSON array) replaces `ssh` (tests: `test/fixtures/fake-ssh.ts`,
`$FAKE_SSH_HOME`, `$FAKE_SSH_LOG`, targets `unreachable*` fail). Install uploads
`packages/host/src/main.ts` (embedded as text) to
`${BOBAGENT_HOST_ROOT:-$HOME/.bobagent}/bin/bobagent-host.ts` and runs `preflight`; install and
check honor the same remote `BOBAGENT_HOST_ROOT`. When an agent's placement has a host,
`AgentRuntime` passes a `RemoteLaunch` to
the driver: the provider command is spawned as `ssh -R <sock>:127.0.0.1:<daemon port> ...
bobagent-host run` (first stdin line = RunSpec JSON), and the `bobagent` MCP server becomes
`bobagent-host bridge` on the host (POSTs `/bridge` through the forwarded socket). Changing a
placement drops the provider session. Firecracker placement requires a host whose preflight
says `firecrackerReady` (Linux + /dev/kvm + firecracker + vmlinux + rootfs.ext4 + `mkfs.ext4`,
with no stale guest helper);
there is no fallback. Build the guest from a checkout with
`bash packages/host/rootfs/build-rootfs.sh`; the host needs Docker, curl, sudo and e2fsprogs,
and the user needs `/dev/kvm` access (`sudo usermod -aG kvm "$USER"`, then re-login).
`packages/host` (`bobagent-host run` with `isolation: "firecracker"`) boots one VM per session
(`firecracker --no-api --config-file`, fresh root disk copied from the base rootfs, vCPU 1-32,
memory 256-65536 MiB) and gives each agent a persistent sparse `workspace.ext4` (default
8192 MiB, configurable with `BOBAGENT_VM_WORKSPACE_MIB`) mounted at `/persist`, with `/workspace`
and `/root` bind-mounted from it. It connects vsock 1024 for provider stdio, serves guest vsock
5000 (bridge) and 3128 (CONNECT proxy), syncs storage when a provider exits, and removes the
per-run root disk on session end. With `setpriv` installed, Firecracker runs with
`--pdeathsig KILL`. On the Linux x86_64/KVM test host, boot to first guest output measured 1.7
seconds. The proxy resolves DNS once, rejects a hostname if any IPv4 answer is non-public, and
connects to the approved address. CONNECT requests are audited at `vms/<agentId>/proxy.log`
(rotated to `.1` above 1 MiB); provider processes drop inherited `BOBAGENT_*` variables while
retaining explicit RunSpec env.
Guest image: `packages/host/rootfs/` (`bobagent-init`, `build-rootfs.sh`); run the real host and
SSH integration tests with `bun run test:firecracker` on a Linux Firecracker host; signed-out
real Claude/Codex flows use `bun run test:firecracker:providers`. `--base <image>` overrides
`BOBAGENT_ROOTFS_BASE`; defaults try Debian Hub, mirror.gcr.io, then public ECR, selecting the
first cached or pullable image. This host's default-provider build selected Debian Hub and took
1m 0s: rootfs 4.0 GiB apparent / 1.6 GiB allocated, 1643 MiB ext4 used; Docker image 2.35 GB
disk usage / 775 MB content size. Re-run the build after updating or reinstalling the helper;
preflight reports `guestHelperCurrent`.
Subagents (`src/subagents.ts`): bridge `spawn_subagents {tasks:[{task,name?}], provider?,
keep?}` (max 8 per call, `BOBAGENT_MAX_SUBAGENTS` running per parent, default 8, depth 2)
creates child agents that inherit the parent's placement, sends each its task, and when the
whole batch has ended delivers one `<subagent_results>` message to the parent; non-kept
children are then deleted (stopping their process/VM). `list_subagents`, `stop_subagent`.
Tests: `test/remote.e2e.test.ts`, `packages/host/test/host.test.ts`.

## Permissions

Provider agents ask for approval only when THEIR OWN config says so
(`PROVIDER_PERMISSION_CONFIG` in `packages/protocol` maps provider -> config path).
The UI shows this as a notice; we never change or sandbox those configs.
Note: `spikes/out/mode-probe.json` was measured with the user's permissive global
configs, so it does not reflect stock defaults. Gemini's config path is unverified.

## Verified commands (run from repo root)

- `bun install` — install workspace deps.
- `bun run build:daemon` — compile `bobagentd-aarch64-apple-darwin` into
  `apps/desktop/src-tauri/binaries/` (Tauri externalBin naming).
- `bun run dev` — build the sidecar, then `tauri dev` (Vite on :1420).
- `bun run build:app` — `tauri build --debug --bundles app` ->
  `apps/desktop/src-tauri/target/debug/bundle/macos/BobAgent.app`.
- `bun run test` — `bun test packages/daemon packages/host` (daemon e2e: spawns the real daemon).
- `bun run lint` — `biome check .`
- `bun run typecheck` — `tsc -p` for protocol, daemon, relay, host, desktop (sequential).
- `cd apps/desktop/src-tauri && cargo check` — Rust side.

## Conventions

- Dependencies are pinned to exact versions.
- All client→daemon calls validate params with the protocol schemas; unknown methods
  and invalid params return `bad_request`.
- The daemon requires `Authorization: Bearer <token>` on `/health` and `?token=` on
  `/ws`; Origin headers outside the Tauri/localhost allowlist get 403.
