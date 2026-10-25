# BobAgent

Local-first macOS desktop workspace for running many persistent AI coding agents side by side
(Claude Code, Codex, Devin, Cursor, Grok, OpenCode, Gemini and other ACP agents).

- Chat with each agent in its own workspace; queues, permissions, resume and context compaction
- Agents message each other, share files and work together in channels with an owner
- Memories, a shared skills library and a marketplace of skills and agent templates
- Scheduled and webhook routines, attachments, an agent-controlled browser, Computer Use
- Encrypted vault with GitHub, 1Password and Bitwarden connectors; voice
- Reach your agents from Telegram, Slack, Discord, your phone (LAN), or share them with a team relay

Built with Bun (daemon, relay), SQLite, Tauri 2 (Rust) and React.

## Install

Download the latest `.dmg` from [Releases](https://github.com/fazedordecodigo/bobagent/releases).
The app updates itself from there.

## Develop

```sh
bun install
bun run dev          # sidecar + tauri dev
bun run test         # daemon e2e tests
bun run lint && bun run typecheck
bun run build:app    # BobAgent.app
```

Architecture and conventions: [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
