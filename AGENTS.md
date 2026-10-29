# UpBot

Local-first cross-platform desktop hub for a team of collaborating general-purpose AI bots
(web, files, email, connected apps). Code and RPC names still say "agent"; the UI says "bot".
Renamed from BobAgent: `src/legacy.ts` moves `~/BobAgent` -> `~/UpBot` and repoints
workspace paths; Rust moves the `com.bobagent.desktop` data dir; the vault key falls back to
the old Keychain service `BobAgent`.
Bun workspaces monorepo: a Bun sidecar daemon (`upbotd`) owns SQLite state and
serves a token-authenticated WebSocket API; a Tauri 2 + React desktop app spawns and
talks to it.

## Bots (general purpose)

`src/persona.ts`: every fresh session starts with `<upbot_context>` (shared workspace path,
collaboration tools, approval and secret rules). `seedDefaultBot` creates one "UpBot" bot
(claude) on a fresh install (`settings.default_bot_seeded`; `UPBOT_DEFAULT_BOT=off` skips it,
set by the test helper). Shared workspace: `UPBOT_WORKSPACE_ROOT` or
`dirname(agentsRoot)/Workspace` (`~/UpBot/Workspace`), passed to local sessions as
`StartOpts.extraDirs` (Claude `--add-dir`, Codex `writableRoots`).

## Email (UpBot)

`src/email.ts` (`EmailService`, migration 15 `email_accounts`, `email_drafts`): IMAP via
`imapflow` + `mailparser`, SMTP via `nodemailer`. Presets gmail/icloud/outlook; app password
in the vault as `email.<id>.password` (hidden from `vault.list`, never given to bots).
`agentIds` empty = every bot. Bridge tools `email_accounts`, `email_search`, `email_read`,
`email_draft` (creates a pending draft only), `email_draft_status`. Only the user sends:
RPC `email.drafts.send` (also `email.accounts.list/save/delete/test`, `email.drafts.list/
update/discard`); events `email.accounts.changed`, `email.draft.updated`. UI: Settings →
Email and `DraftCards` above the composer. Tests: `UPBOT_EMAIL_FAKE_MAILBOX=<json>` replaces
IMAP, `UPBOT_EMAIL_PLAINTEXT=1` allows non-TLS SMTP (`test/email.e2e.test.ts` with smtp-server).

## Connected apps (UpBot)

`src/apps.ts` (`AppsService`, migration 16 `connected_apps`): the daemon itself runs each app's
MCP server via `@modelcontextprotocol/sdk` (stdio with secrets as env, or streamable HTTP with
secret-filled headers). Catalog `APP_CATALOG` (Notion, GitHub remote MCP, Brave Search,
Airtable, Stripe; pinned npx versions) plus `custom-stdio` / `custom-http`. Secrets in the
vault as `app.<id>.<KEY>` (hidden from `vault.list`); tool output has secrets redacted.
The bridge appends app tools to `tools/list` as `<slug>-<tool>` and routes calls to them
(`agentIds` empty = every bot). RPC `apps.catalog/list/connect/update/refresh/delete`, event
`apps.changed`; UI Settings → Apps. Tests: `test/apps.e2e.test.ts` + `fixtures/fake-mcp-server.ts`.
Migration 19 adds `permissions_json`: `read | write | send | pay | book | del` map to
`off | ask | allow`. New and migrated apps default to read=allow and all others=ask.
Sensitive kinds (send/pay/book/del) reject allow in both protocol schemas and AppsService.
`apps.connect/update` accept partial permissions. `classifyAppTool` in `@upbot/protocol`
(shared with the desktop UI) classifies the
operation after `<slug>-` on underscores, hyphens and camelCase. The leading verb determines
the kind; verbs after and/or/then can escalate it (del > pay > book > send > write > read).
Read-object nouns do not escalate. An unknown leading token falls back to known verbs
anywhere in the name; no known verb fails closed to write.
This is a naming heuristic, not argument or semantic inspection.
The Apps permissions dialog edits stored levels; disconnect confirms removal of saved
secrets, while enable/disable remains reversible. No account or last-used data is invented.
Grok rejects `__` in MCP tool names because it uses that separator to qualify server and tool names.

## Approvals (UpBot)

`src/approvals.ts` (`ApprovalService`): every bridge tool call passes `gate()`. Rules
(`settings.approval_rules`, glob on tool names, per bot or `agentId: null`): "ask" beats
"allow". App permissions are authoritative: off denies without an approval, allow passes
only for read/write, ask creates an approval. Explicit ask rules still require review;
neither specific nor wildcard allow rules bypass app permissions. Sensitive app tools
always ask unless off (then deny). App-tool approvals carry appId, appName and permission.
Unknown operations use write (ask by default), never the default read allow.
For app requests, `task` approves once and grants the same app+kind for the current turn
only (non-sensitive kinds); turn end clears grants. `always` sets a non-sensitive app
kind to allow and returns previousLevel for undo via apps.update. For sensitive kinds,
task/always approve only this call, leave ask unchanged and never create an allow rule.
Non-app approvals retain tool-name-rule behavior. Decisions emit approval.updated;
permission changes also emit apps.changed. Apps, composer, Approvals and RunPanel
refresh from these events. Undo restores only the previous preference, never an executed
external action; task and deny expose no undo.
A pending approval blocks the call; background turns (from another bot, routine, gateway,
team or group chat — `AgentRuntime.currentTurn().background`) expire after
`UPBOT_APPROVAL_BACKGROUND_TTL_MS` (10 min), others after `UPBOT_APPROVAL_TTL_MS` (60 min);
a finished turn expires its approvals. Bridge `request_secret` (masked form, value goes to the
vault allowlisted to the bot) and `request_takeover` (user uses the bot browser, clicks Done).
RPC `approvals.list/respond/rules/setRules` (also allowed for mobile), events
`approval.updated`, `approvals.rulesChanged`. Codex gets `tool_timeout_sec = 3600` for MCP
servers so waits do not time out. UI: `ApprovalCards` above the composer, Settings →
Approvals. Tests: `test/approvals.e2e.test.ts`, `test/approval-audit.test.ts`.
Every terminal decision persists to `approval_audit` (migration 21): `approval.decided`
(status, decision, kind, tool, app/permission, ageMs — never args or secret values),
`approval.auto_denied` for off permissions, `approval.permission_escalated` for
`always` escalations (app previousLevel or created ruleId), `approval.rules_changed`
(added/removed/changed rule ids) and `approval.app_permissions_changed` (source connect/update/
restore, per-kind from/to). Failed or overridden decisions include requestedDecision, reason
and failure. `approval.secret_allowlist_read_failed` records vault allowlist failures; error
details in the audit and stderr are limited to code/name, never message or stack. Tests:
`test/approval-audit.test.ts` and
`test/approvals.e2e.test.ts` cover the audit trail.

Desktop notifications: `apps/desktop/src/lib/notifications.ts` owns approval eligibility,
bounded summaries, actions, persisted one-hour mute and daemon decisions. Only pending
approvals notify; unknown/incomplete/oversized details, secrets, takeover, pay, book and del
open the app. Notifications never offer always. Permission buttons are deny/task;
sends require recipient and full content. Closing a notification does not decide it.
Inline results replace the same identifier; only a real preference undo can offer
Desfazer for six seconds. Current once/task/deny decisions have no undo.
macOS uses objc2 UserNotifications categories/delegate only in a real .app bundle;
unbundled development is a no-op. Muting skips macOS delivery (not replayed on unmute).
Windows uses WinRT ToastNotification XML (reminder requests), the app's AUMID and
per-user COM activation registration; mute uses SuppressPopup plus silent audio and
is also in the toast context menu. General settings expose mute on every platform.
Native callbacks queue actions until the main frontend can drain them; the daemon
remains authoritative. Optional dock/taskbar badges are not implemented.
Pending approvals and their blocked calls are memory-only: after daemon shutdown,
toast decisions cannot recover them. Missing IDs open Settings → Approvals with an
unavailable notice and remove the toast, without retrying or fabricating approval.
Windows registers its COM activator before spawning the daemon; `-ToastActivated`
payloads and COM callbacks share the native queue. The single-instance plugin forwards
second-launch arguments and focuses the existing window before another daemon starts.

## Pages (UpBot)

`src/pages.ts` (`PageLibrary`, migration 17 `pages`): bots publish self-contained HTML with
bridge `page_publish {title, html|file, id?}` (5 MB; `file` must be in the bot's or the
shared workspace), `list_pages`, `read_page`. Files: `<workspace>/Pages/<id>/index.html`,
old versions in `.history/v<n>.html`. Served at `GET /pages/<id>?token=<viewToken>` (token
per daemon start, CSP `default-src 'none'`, no network); UI `PagesView` (sidebar "Pages")
shows them in `<iframe sandbox="allow-scripts">` (Tauri CSP `frame-src http://127.0.0.1:*`).
RPC `pages.list/delete`, event `pages.changed`. Tests: `test/pages.e2e.test.ts`.
Titles are capped at 200 and descriptions at 1000 UTF-16 units on create and update
(including legacy values), without splitting a surrogate pair.

## Group chat + navigation (UpBot)

Channels are "Group chats" in the UI. `ChannelService.post(channelId, text, replyTo?)`:
`@Name` sends to those members, `@everyone`/`@all` to every member, a reply to a bot's
message goes to that bot (quoted as `<in_reply_to>`), otherwise the owner. Member replies are
forwarded to the owner only for bot-originated work (`queue.from_agent_id`). Migration 18 adds
`channel_messages.reply_to`. UI: `CommandPalette` (⌘K all, ⌘⇧F bots on macOS; Ctrl+K and
Ctrl+Shift+F elsewhere) and shortcuts in `App.tsx` (⌘N new bot, ⌘1–9 switch bot, ⌘, settings,
⌘P pages on macOS; Ctrl equivalents elsewhere).

## ACP providers in microVMs

ACP providers run in Firecracker like Claude/Codex (`AcpDriver` spawns via `RemoteLaunch` and
passes `remote.credentials` as env). MicroVM sign-in (`vmCredentials`, Settings → Hosts):
claude (OAuth token or API key), codex (`OPENAI_API_KEY`), gemini (`GEMINI_API_KEY`), cursor
(`CURSOR_API_KEY`). The verified five-provider image contains Claude Code 2.1.310, Codex
0.164.0, Gemini 0.65.0, OpenCode 1.19.4, and Cursor Agent 2026.10.22-27dcf5f. Cursor installs
under `/opt/cursor-agent-home` because `/root` is bind-mounted from persistent storage.
Signed-out behavior: Gemini reports `gemini`, OpenCode `opencode auth login`, and Cursor
`agent login`. OpenCode alone has a 30-second first-activity watchdog: message/thought chunks,
tool calls/updates, plans, or agent requests count as progress; session metadata updates such as
available commands do not. Without progress after a prompt, it reports `opencode auth login` and
tears down its child; after the first progress, the prompt is unbounded. Fake Gemini/Cursor credentials reach only
Firecracker provider env. Gemini invalid-key errors are explicit; Cursor's
`Failed to initialize session services` mapping is inferred from `proxy.log` showing a request
to `api2.cursor.sh` with a microVM credential set, since Cursor returns no explicit invalid-key
error. `bun run test:firecracker:providers` checks these real ACP flows, credential delivery,
placement isolation, and plaintext leaks.
devin/grok need a custom image plus `UPBOT_PROVIDER_COMMAND_<PROVIDER>`.

## Layout

- `packages/protocol` — `@upbot/protocol`: zod 4 schemas + the typed method map
  (`methodMap`) shared by daemon and UI. Single source of truth for the wire contract.
- `packages/daemon` — `@upbot/daemon`: `src/main.ts` is the sidecar entry.
  Args: `--data-dir <path>` (required), `--agents-root <path>` (default `~/UpBot/agents`).
  The auth token is the first line on stdin (required; never via env, so agent CLIs can't
  read it). Prints `UPBOT_READY {"port":N}` on
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
`session/cancel` and hard-kills after `UPBOT_CANCEL_GRACE_MS` (default 10000).
On daemon start, turns left `running` are marked `interrupted`. Provider CLIs are
found via a login-shell PATH merge (`src/env/login-path.ts`) — spawned agents get
`NO_COLOR=1` and a resolved absolute binary path.

Daemon auth: the token is delivered on the FIRST STDIN LINE (never env — provider
children must not see it). Missing/empty token or no line within 10 s -> exit 2.
stdin EOF afterwards = shutdown. `spawnEnv` strips all `UPBOT_*` vars.

Env vars (daemon):
- `UPBOT_ACP_COMMAND_<PROVIDER>` — JSON array overriding the spawn command per
  provider (e.g. `UPBOT_ACP_COMMAND_DEVIN='["bun","path/to/agent.ts"]'`).
- `UPBOT_CANCEL_GRACE_MS` — ms after `chat.cancel` before the process is killed.

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
- `UPBOT_DEBUG_PROMPTS_DIR` — when set, the daemon writes every outgoing prompt to
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
- `UPBOT_PROVIDER_COMMAND_<PROVIDER>` overrides any provider's spawn command
  (`UPBOT_ACP_COMMAND_<PROVIDER>` still works). Tests use
  `test/fixtures/fake-claude.ts` / `fake-codex.ts` (`$FAKE_CLAUDE_STATE_DIR`,
  `$FAKE_CODEX_STATE_DIR`, `FAKE_CODEX_NO_AUTH=1`) from `test/native.e2e.test.ts`.

## Agent-to-agent bridge (Phase 5)

Every provider session gets a `upbot` stdio MCP server: the daemon binary run as
`upbotd mcp-bridge` (dev: `bun src/main.ts mcp-bridge`), with
`UPBOT_BRIDGE_URL`/`UPBOT_BRIDGE_TOKEN` in its env. The token is per agent,
regenerated each daemon start, and never the daemon's main token. The bridge forwards
`tools/list`/`tools/call` to `POST /bridge` (Bearer bridge token; any Origin header ->
403). Passed via ACP `mcpServers`, Claude `--mcp-config`, Codex `thread/start.config`
(`mcp_servers.upbot`). Tools (`src/bridge.ts`):
- `list_agents`, `send_message {to, text}`: enqueues on the recipient with
  `queue.from_agent_id` + `hops` (migration 5). The recipient's prompt is framed by
  `<agent_message_context>` (`wrapAgentMessage`); its `user_message` item has `from`.
  Chains stop at `MAX_HOPS` (6).
- `share_file {to, path, note?}`: only regular files inside the sender workspace, max 100 MB.
  It copies the file to `<shared>/Transfers/<id>/` with `manifest.json` (sha256), delivers it
  to `<recipient ws>/transfers/<id>/<name>`, and notifies the recipient. Shared root is
  `UPBOT_SHARED_ROOT` or `dirname(agentsRoot)/Shared` (default `~/UpBot/Shared`).
Tests: `test/bridge.e2e.test.ts` (the fake ACP agent's `mcp:<tool> <json>` prompt
spawns the real bridge and calls the tool).

## Channels (Phase 6)

`src/channels.ts` (`ChannelService`, migration 6: `channels`, `channel_members`,
`channel_messages`, `queue.channel_id` + `queue.prompt`). RPC `channels.list/create/
history/post/stop/resume/archive/restore/reassign`; events `channel.created`,
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
`UPBOT_COMPACT_THRESHOLD`, default 0.85, `off` disables): the agent answers a
`<compaction_request>` prompt (output captured, permissions denied, timeout
`UPBOT_COMPACT_TIMEOUT_MS`), the provider session is dropped and forgotten, and a
`compaction` chat item stores the summary. The next fresh session gets
`<conversation_summary>` plus only the history after it. The queue waits while compacting.
Tests: `test/usage.e2e.test.ts`.

## Avatars, memories, skills, agent creation (Phase 8)

`Agent.avatar` (`{emoji,color}`, `{icon}` with `sym|mail|receipt|plane|chart|cal|sheet`, or
null; `agents.avatar_json`, migration 8). `agents.restore {id}` restores a soft-deleted agent
and emits `agent.created` so clients add it back to their lists. `agents.draft
{prompt}` (`src/draft.ts`, deterministic) proposes name/instructions/avatar for the create
form. Memories: `memories` table, `MemoryStore` (`src/memories.ts`), RPC
`memories.list/add/update/delete`, event `memories.changed`. Skills library:
`<shared>/Skills/<name>/SKILL.md` with name/description/author frontmatter, previous versions
in `.history/` (`src/skills.ts`), RPC `skills.list/get/save/delete`, event `skills.changed`.
Bridge tools: `remember`, `forget`, `list_memories`, `list_skills`, `read_skill`,
`create_skill`, `revise_skill`, `create_agent`. The first prompt of every fresh session is
prefixed with `<agent_memories>` and `<skills_library>` (index only). UI:
`components/Library.tsx`; the saved agent configuration screen is
`apps/desktop/src/components/AgentConfigScreen.tsx`. Tests: `test/phase8.e2e.test.ts`.

## Routines + attachments (Phase 9)

Routines (`src/routines.ts`, migration 9: `routines`, `routine_runs`) are saved prompts sent
to an agent with `trigger` schedule|webhook|manual. Schedules: `every <n>m|h|d`, `daily HH:MM`,
`weekly <day> HH:MM` (local time); the scheduler ticks every `UPBOT_ROUTINE_TICK_MS`
(default 30000), skips soft-deleted agents, and collapses missed runs into one. Manual and
webhook triggers also reject routines whose agent is soft-deleted; restoring the agent resumes
scheduled runs. Webhooks: `POST /hooks/<routineId>` with
`Authorization: Bearer <webhookToken>` (per-routine token; Origin rejected), body passed as
`<webhook_payload>` (20 KB cap). RPC `routines.list/create/update/delete/run/runs`, events
`routine.updated`/`routine.deleted`. The prompt is wrapped in `<routine name trigger>`;
`queue.meta_json` puts `routine`/`attachments` on the user_message item.
Attachments: `chat.send {attachments:[{name,mime,dataBase64}]}` (max 10, 25 MB total) are
written to `<workspace>/attachments/<id>/` (`src/attachments.ts`, basename-sanitized, ZIPs
extracted with `unzip` or Windows `tar`, with unsafe archive paths rejected) and listed in an
`<attachments>` block. Tests: `test/phase9.e2e.test.ts`.

## Agent browser (Phase 10)

`src/browser.ts`: one Chromium-family browser (Chrome/Chromium/Edge/Brave, or
`UPBOT_BROWSER_PATH`) launched lazily with `--remote-debugging-port=0` and its own profile
(`<data-dir>/browser-profile`, port read from `DevToolsActivePort`), driven over CDP (flattened
`Target.attachToTarget` sessions). Each agent gets one tab. Bridge tools: `browser_open`
(http/https only), `browser_snapshot` (numbered interactive elements via `data-bob-ref` + page
text), `browser_click`, `browser_type`, `browser_press`, `browser_back`, `browser_screenshot`
(PNG into `<workspace>/browser/`), `browser_close`. RPC `browser.status/closeTab/close`, event
`browser.updated`; UI `BrowserView`. `UPBOT_BROWSER=off` disables it,
`UPBOT_BROWSER_HEADLESS=1` for tests. Tests: `test/browser.e2e.test.ts` (skipped when no
browser is installed).

## Vault, connectors, Computer Use, voice (Phase 11)

Vault (`src/vault.ts`, migration 10 `vault` + `settings`): AES-256-GCM secrets; key precedence
is `UPBOT_VAULT_KEY` (64 hex, tests), macOS Keychain (service `UpBot`, account `vault-key`),
an existing `<data-dir>/vault.key`, then Windows DPAPI or Linux Secret Service. Linux writes
`vault.key.location` after a successful Secret Service store so a locked/unavailable keyring
cannot silently orphan secrets; when secure storage is unavailable, a 0600 plaintext key file
is used with a warning. Fallback diagnostics are covered by `test/vault-platform.test.ts` and
`test/vault-fallback.e2e.test.ts`. Existing plaintext keys are kept without migration.
Per-secret agent allowlist. RPC
`vault.list/set/setAccess/delete` (values never returned), event `vault.changed`; bridge
`vault_list`, `vault_get`. Connectors (`src/connectors.ts`) use shared secrets without
returning them: `connector.github` -> `github_api` (REST proxy, token redacted,
`UPBOT_GITHUB_API` for tests); `connector.1password` -> `onepassword_read` (`op read`,
optional service-account token); `connector.bitwarden` -> `bitwarden_get` (`bw get`,
BW_SESSION). `UPBOT_OP_COMMAND`/`UPBOT_BW_COMMAND` override the CLIs.
Computer Use (`src/computer.ts`, macOS): off per agent until `computer.setAccess`; bridge
`computer_screenshot` (screencapture), `computer_click` (CoreGraphics via JXA),
`computer_type`, `computer_key` (System Events, whitelisted keys/modifiers);
`UPBOT_COMPUTER_DRYRUN=<file>` logs commands instead (tests).
Voice (`src/voice.ts`): `voice.speak` (`say`, or `UPBOT_TTS_COMMAND` with text on
stdin), `voice.transcribe` (`UPBOT_STT_COMMAND` with `{file}`, or `whisper` on PATH),
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
events `gateway.updated/deleted`; UI `GatewaysView`. Daemon shutdown (SIGTERM/SIGINT/stdin EOF)
calls `GatewayService.stopAll()` before closing runtimes. Test base URLs:
`UPBOT_TELEGRAM_API`, `UPBOT_SLACK_API`, `UPBOT_DISCORD_API`.
Tests: `test/gateways.e2e.test.ts`, `test/gateways-shutdown.e2e.test.ts`.

## Marketplace (Phase 12b)

`marketplace/` holds the default registry (`index.json` + `skills/*.md` + `agents/*.json`),
fetched from raw.githubusercontent.com (`UPBOT_MARKETPLACE_URL` overrides; user sources in
`settings.marketplace_sources`, http(s)/file URLs). `src/marketplace.ts` verifies each file's
sha256 before installing; skills go to the skills library (author `marketplace:<author>`),
agent templates create an agent (chosen provider) and install their listed skills. RPC
`marketplace.list/install/setSources`; UI `MarketplaceView`. Regenerate the index with
`bun scripts/marketplace-index.ts`. Tests: `test/marketplace.e2e.test.ts`.

## Mobile companion (Phase 12c)

`src/mobile.ts` + `src/mobile-app.ts` (vanilla JS PWA as a string): opt-in LAN
server (`mobile.enable`, `0.0.0.0`, port remembered in `settings.mobile`;
`UPBOT_MOBILE_HOST`/`UPBOT_MOBILE_PORT` override). Pairing: `mobile.pair` shows a
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
Share entries are validated (string id/name/provider; avatar via protocol `AgentAvatar`, otherwise null).
No chat content is stored on the relay. Daemon side `src/team.ts` (`settings.team`, token in
the vault as `team.token`, hidden from `vault.list`, migration 13 `team_messages`): shares
selected agents, runs incoming messages as `<team_message>` turns and replies on `turn.ended`.
An incoming row is `completed` once the reply is handed to an open relay socket; if the socket
is down it is `failed` and logged (`team reply not delivered`). The relay has no delivery ack
and drops replies to offline members, so a sender's `out` row still `pending` after
`UPBOT_TEAM_REPLY_TTL_MS` (default 30 min; checked at start and periodically) becomes `failed`;
a late reply still overwrites it. No relay protocol change, nothing stored on the relay.
RPC `team.status/connect/disconnect/share/send/messages`, events `team.updated/message`;
UI `TeamView`. Tests: `test/team.e2e.test.ts` (spawns the relay). Relay audit logs are JSON
lines on stderr and never include member-supplied identifiers (only relay-known member IDs,
fixed route labels, and socket IP); limits are 20 lines per actor per window across event types,
with periodic `relay.audit_suppressed` summaries (`RELAY_AUDIT_WINDOW_MS`).

## CI, releases, updates, branding

- `.github/workflows/ci.yml`: lint/typecheck on Ubuntu; tests, daemon build, Rust check and
  desktop build on macOS, Linux and Windows.
- `.github/workflows/release.yml`: on `v*` tags, tauri-action builds macOS `.app`/`.dmg`,
  Linux `.AppImage`/`.deb` and an unsigned per-user Windows NSIS `.exe` into a draft release.
  It composes `latest.json` from each platform's updater asset and signature before publishing.
  Updater signing uses the `TAURI_SIGNING_PRIVATE_KEY` repo secret (pubkey in `tauri.conf.json`
  `plugins.updater`); Apple signing/notarization turn on when `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (+ `APPLE_ID`, `APPLE_PASSWORD`,
  `APPLE_TEAM_ID`) secrets exist. Bump `version` in `tauri.conf.json` before tagging.
- In-app updates: `tauri-plugin-updater` + `components/UpdateButton.tsx` (sidebar footer).
- Icon source: `apps/desktop/branding/icon.svg` -> `icon.png` (Chrome headless render) ->
  `bunx tauri icon branding/icon.png` (from `apps/desktop`).

## Remote hosts, Firecracker, subagents

`src/remote/hosts.ts` (`HostStore`, migration 14: `hosts`, `agent_placement`, `subagents`).
RPC `hosts.list/create/delete/install/check`, `placements.list/set`, `subagents.list`;
events `hosts.changed`, `placement.updated`, `subagent.updated`; UI `components/HostsView.tsx`
(Settings → Hosts). SSH runs the system `ssh` with `BatchMode=yes`,
`StrictHostKeyChecking=accept-new`, keepalives, `-p`, optional `-i`, then `--` and the target
(validated by `SshTarget`, so it cannot be an option); remote commands are single-quoted.
`UPBOT_SSH_COMMAND` (JSON array) replaces `ssh` (tests: `test/fixtures/fake-ssh.ts`,
`$FAKE_SSH_HOME`, `$FAKE_SSH_LOG`, targets `unreachable*` fail). Install uploads
`packages/host/src/main.ts` (embedded as text) to
`${UPBOT_HOST_ROOT:-$HOME/.upbot}/bin/upbot-host.ts` and runs `preflight`; install and
check honor the same remote `UPBOT_HOST_ROOT`. When an agent's placement has a host,
`AgentRuntime` passes a `RemoteLaunch` to
the driver: the provider command is spawned as `ssh -R <sock>:127.0.0.1:<daemon port> ...
upbot-host run` (first stdin line = RunSpec JSON), and the `upbot` MCP server becomes
`upbot-host bridge` on the host (POSTs `/bridge` through the forwarded socket). Changing a
placement drops the provider session. Firecracker placement requires a host whose preflight
says `firecrackerReady` (Linux + /dev/kvm + firecracker + vmlinux + rootfs.ext4 + `mkfs.ext4`,
with no stale guest helper);
there is no fallback. Build the guest from a checkout with
`bash packages/host/rootfs/build-rootfs.sh`; the host needs Docker, curl, sudo and e2fsprogs,
and the user needs `/dev/kvm` access (`sudo usermod -aG kvm "$USER"`, then re-login).
`packages/host` (`upbot-host run` with `isolation: "firecracker"`) boots one VM per session
(`firecracker --no-api --config-file`, fresh root disk copied from the base rootfs, vCPU 1-32,
memory 256-65536 MiB) and gives each agent a persistent sparse `workspace.ext4` (default
8192 MiB, configurable with `UPBOT_VM_WORKSPACE_MIB`) mounted at `/persist`, with `/workspace`
and `/root` bind-mounted from it. It connects vsock 1024 for provider stdio, serves guest vsock
5000 (bridge) and 3128 (CONNECT proxy), syncs storage when a provider exits, and removes the
per-run root disk on session end. With `setpriv` installed, Firecracker runs with
`--pdeathsig KILL`. On the Linux x86_64/KVM test host, boot to first guest output measured 1.7
seconds. The proxy resolves DNS once, rejects a hostname if any IPv4 answer is non-public, and
connects to the approved address. CONNECT requests are audited at `vms/<agentId>/proxy.log`
(rotated to `.1` above 1 MiB); provider processes drop inherited `UPBOT_*` variables while
retaining explicit RunSpec env.
MicroVM sign-in (`src/remote/credentials.ts`): `vmCredentials.list/set/delete` store
`vmcred.<provider>` in the vault (hidden from `vault.list`, never on an allowlist):
claude `oauth_token` -> `CLAUDE_CODE_OAUTH_TOKEN`, `api_key` -> `ANTHROPIC_API_KEY`; codex
`api_key` -> `OPENAI_API_KEY` + `CODEX_API_KEY`. `HostStore.launchFor` adds them to
`RemoteLaunch.credentials` and the RunSpec env only for `firecracker` placements; when Codex
reports signed out and a key is present the driver calls `account/login/start {type:"apiKey"}`.
Credentialed Codex sessions set `CODEX_HOME=/run/upbot/codex-home` on guest tmpfs; fake-key
runs found no `/root/.codex/auth.json` on the persistent workspace. Fake `OPENAI_API_KEY` or
`CODEX_API_KEY` alone left `account/read` signed out. Rejected credentials surface a redacted
provider detail and a Settings → Hosts prompt. Tests: `test/vm-credentials.test.ts` and
`bun run test:firecracker:providers` (real SSH/Firecracker, fake Claude API/OAuth and Codex
keys, persistence and leak checks). Codex's home/thread cache is ephemeral; the driver falls
back to `thread/start` if a thread cannot be resumed.
Guest image: `packages/host/rootfs/` (`upbot-init`, `build-rootfs.sh`); run the real host and
SSH integration tests with `bun run test:firecracker` on a Linux Firecracker host; signed-out
real Claude/Codex flows use `bun run test:firecracker:providers`. `--base <image>` overrides
`UPBOT_ROOTFS_BASE`; defaults try Debian Hub, mirror.gcr.io, then public ECR, selecting the
first cached or pullable image. This host's default-provider build selected Debian Hub and took
1m 0s: rootfs 4.0 GiB apparent / 1.6 GiB allocated, 1643 MiB ext4 used; Docker image 2.35 GB
disk usage / 775 MB content size. Re-run the build after updating or reinstalling the helper;
preflight reports `guestHelperCurrent`.
Subagents (`src/subagents.ts`): bridge `spawn_subagents {tasks:[{task,name?}], provider?,
keep?}` (max 8 per call, `UPBOT_MAX_SUBAGENTS` running per parent, default 8, depth 2)
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
- `bun run build:daemon` — compile the daemon for the host OS/architecture into
  `apps/desktop/src-tauri/binaries/` (Tauri externalBin naming);
  `bun scripts/build-daemon.ts --target <rust-triple>` selects a supported cross-build target.
- `bun run dev` — build the sidecar, then `tauri dev` (Vite on :1420).
- `bun run build:app` — build the debug desktop bundle for the host platform (macOS app,
  Linux AppImage/deb, or Windows NSIS).
- `bun run test` — `bun test packages/daemon packages/host apps/desktop/test` (daemon e2e and desktop browser tests).
- Computer Use and built-in `say` voice are macOS-only; Linux uses Secret Service for the
  vault key when available, while Windows uses DPAPI.
- `bun run lint` — `biome check .`
- `bun run typecheck` — `tsc -p` for protocol, daemon, relay, host, desktop (sequential).
- `cd apps/desktop/src-tauri && cargo check` — Rust side.

## Conventions

- Dependencies are pinned to exact versions.
- Windows command lookup follows PATHEXT and searches PATH directories in order; environment
  PATH keys are case-insensitive and Windows provider CLI launches use `cross-spawn`.
- On Windows, `mergedPath` skips login shells. On Linux it uses `$SHELL`, falling back to
  `/bin/bash`; macOS falls back to `/bin/zsh`.
- All client→daemon calls validate params with the protocol schemas; unknown methods
  and invalid params return `bad_request`.
- The daemon requires `Authorization: Bearer <token>` on `/health` and `?token=` on
  `/ws`; Origin headers outside the Tauri/localhost allowlist get 403.
