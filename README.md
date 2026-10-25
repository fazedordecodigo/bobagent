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

Host requirements: Linux, [Bun](https://bun.sh), `curl`, Docker, `sudo`, and `e2fsprogs`.
For the real integration tests, also install `openssh-server`, `socat`, and `unzip`. On
Debian/Ubuntu:

```sh
sudo apt-get install curl docker.io e2fsprogs openssh-server socat sudo unzip
sudo usermod -aG kvm,docker "$USER"
# log out and back in so the new groups apply
```

From a BobAgent checkout on the host, build the default guest image (Claude and Codex CLIs):

```sh
bash packages/host/rootfs/build-rootfs.sh
```

`--base <image>` overrides `BOBAGENT_ROOTFS_BASE`; otherwise the builder tries
`debian:bookworm-slim`, `mirror.gcr.io/library/debian:bookworm-slim`, then
`public.ecr.aws/docker/library/debian:bookworm-slim`, selecting the first cached or pullable
image. The guest uses Node.js 22.23.4 from the official tarball with its SHA-256 checked against
the published checksum file. This default-provider build selected Debian Hub and took 1m 0s;
the 4096 MiB rootfs used 1643 MiB in ext4 (1.6 GiB allocated, 4.0 GiB apparent), and the
`bobagent-guest` image reported 2.35 GB disk usage / 775 MB content size.

The build downloads a checksummed Firecracker release and guest kernel and creates
`~/.bobagent/firecracker/` with the rootfs. For a custom host root, set
`BOBAGENT_HOST_ROOT` in the remote SSH environment; install and check use that same root.
Re-run the build after updating or reinstalling the host helper; preflight reports
`guestHelperCurrent`.
Firecracker placement requires `/dev/kvm`, the image, and `mkfs.ext4`. Each session gets a
fresh root disk and an agent-persistent `workspace.ext4`, mounted at `/persist` with
`/workspace` and `/root` backed by it. The workspace image is sparse and defaults to 8192 MiB;
set `BOBAGENT_VM_WORKSPACE_MIB` in the remote host environment to change its size. When
available, `setpriv --pdeathsig KILL` ensures Firecracker dies if its host helper is killed.
The guest syncs storage when a provider exits. On the Linux x86_64/KVM test host, boot to the
first guest output measured 1.7 seconds.
Provider subprocesses drop inherited `BOBAGENT_*` variables (explicit RunSpec env is retained).
CONNECT requests are audited at `vms/<agentId>/proxy.log`, rotated to `.1` above 1 MiB.
Run the opt-in signed-out Claude/Codex SSH + Firecracker test with
`bun run test:firecracker:providers`.

VMs have no network device: provider stdio, the agent-to-agent bridge, and an HTTPS proxy all
use vsock. The proxy resolves hostnames once and rejects requests if any IPv4 result is not
public. Agents can call `spawn_subagents` to run up to 8 tasks in parallel (each subagent
inherits the parent's host and isolation); the results come back as one message, and agents
talk to each other with `send_message`.

On a Linux host with Firecracker artifacts installed, run the opt-in host/SSH integration
suite with `bun run test:firecracker`. It uses temporary host roots and does not modify
`~/.bobagent`.

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
