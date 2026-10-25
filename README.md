# BobAgent

Local-first macOS desktop workspace for running many persistent AI coding agents side by side
(Claude Code, Codex, Devin, Cursor, Grok, OpenCode, Gemini and other ACP agents).

- Chat with each agent in its own workspace; queues, permissions, resume and context compaction
- Agents message each other, share files and work together in channels with an owner
- Memories, a shared skills library and a marketplace of skills and agent templates
- Scheduled and webhook routines, attachments, an agent-controlled browser, Computer Use
- Encrypted vault with GitHub, 1Password and Bitwarden connectors; voice
- Reach your agents from Telegram, Slack, Discord, your phone (LAN), or share them with a team relay
- Run agents on your own Linux VPS over SSH, each in its own Firecracker microVM, and let them
  fan out to parallel subagents

Built with Bun (daemon, relay), SQLite, Tauri 2 (Rust) and React.

| Marketplace | Gateways |
|---|---|
| ![Marketplace](docs/screenshots/marketplace.png) | ![Gateways](docs/screenshots/gateways.png) |
| **Mobile companion** | **Team relay** |
| ![Mobile](docs/screenshots/mobile.png) | ![Team](docs/screenshots/team.png) |

## Install

Download the latest `.dmg` from [Releases](https://github.com/fazedordecodigo/bobagent/releases).
The app updates itself from there.

## Remote hosts and Firecracker microVMs

Settings → Hosts adds a VPS (`user@host`, port, optional identity file). BobAgent uses your
system `ssh` with `BatchMode=yes` (keys from `~/.ssh` or your ssh-agent; no keys or passwords
are stored), uploads a helper to `~/.bobagent/bin/` on the host and runs a preflight. Then pick,
per agent, **This Mac**, **Process** (provider CLI on the VPS) or **Firecracker microVM**.

Host requirements: Linux, [Bun](https://bun.sh), the provider CLIs you use (signed in on the
host), and for microVMs `/dev/kvm` access plus the guest image:

```sh
# on the VPS, after Install
bash bobagent/packages/host/rootfs/build-rootfs.sh --providers "claude codex"
```

This downloads a checksummed Firecracker release and guest kernel and builds `rootfs.ext4`
(Debian, bun, socat, CLIs) into `~/.bobagent/firecracker/`. Each agent session boots its own VM
with no network device: provider stdio, the agent-to-agent bridge and an HTTPS proxy that only
reaches public addresses all go over vsock. Agents can call `spawn_subagents` to run up to 8
tasks in parallel (each subagent inherits the parent's host and isolation); the results come
back as one message, and agents talk to each other with `send_message`.

## Develop

```sh
bun install
bun run dev          # sidecar + tauri dev
bun run test         # daemon e2e tests
bun run lint && bun run typecheck
bun run build:app    # BobAgent.app
```

Architecture and conventions: [AGENTS.md](AGENTS.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [changelog](CHANGELOG.md).

## License

[MIT](LICENSE)
