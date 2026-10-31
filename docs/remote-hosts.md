# Remote hosts and Firecracker microVMs

Settings → Hosts adds a VPS (`user@host`, port, optional identity file). Boto uses your
system `ssh` with `BatchMode=yes` (keys from `~/.ssh` or your ssh-agent; no keys or passwords
are stored), uploads a helper to `~/.boto/bin/` on the host and runs a preflight. Then pick,
per agent, **This Mac**, **Process** (provider CLI on the VPS) or **Firecracker microVM**.

Host requirements: Linux, [Bun](https://bun.sh), `curl`, Docker, `sudo`, and `e2fsprogs`.
For the real integration tests, also install `openssh-server`, `socat`, and `unzip`. On
Debian/Ubuntu:

```sh
sudo apt-get install curl docker.io e2fsprogs openssh-server socat sudo unzip
sudo usermod -aG kvm,docker "$USER"
# log out and back in so the new groups apply
```

From a Boto checkout on the host, build the default guest image (Claude and Codex CLIs):

```sh
bash packages/host/rootfs/build-rootfs.sh
```

`--base <image>` overrides `BOTO_ROOTFS_BASE`; otherwise the builder tries
`debian:bookworm-slim`, `mirror.gcr.io/library/debian:bookworm-slim`, then
`public.ecr.aws/docker/library/debian:bookworm-slim`, selecting the first cached or pullable
image. The guest uses Node.js 22.23.4 from the official tarball with its SHA-256 checked against
the published checksum file. This default-provider build selected Debian Hub and took 1m 0s;
the 4096 MiB rootfs used 1643 MiB in ext4 (1.6 GiB allocated, 4.0 GiB apparent), and the
`boto-guest` image reported 2.35 GB disk usage / 775 MB content size.

The build downloads a checksummed Firecracker release and guest kernel and creates
`~/.boto/firecracker/` with the rootfs. For a custom host root, set
`BOTO_HOST_ROOT` in the remote SSH environment; install and check use that same root.
Re-run the build after updating or reinstalling the host helper; preflight reports
`guestHelperCurrent`.
Firecracker placement requires `/dev/kvm`, the image, and `mkfs.ext4`. Each session gets a
fresh root disk and an agent-persistent `workspace.ext4`, mounted at `/persist` with
`/workspace` and `/root` backed by it. The workspace image is sparse and defaults to 8192 MiB;
set `BOTO_VM_WORKSPACE_MIB` in the remote host environment to change its size. When
available, `setpriv --pdeathsig KILL` ensures Firecracker dies if its host helper is killed.
The guest syncs storage when a provider exits. On the Linux x86_64/KVM test host, boot to the
first guest output measured 1.7 seconds.
Provider subprocesses drop inherited `BOTO_*` variables (explicit RunSpec env is retained).
CONNECT requests are audited at `vms/<agentId>/proxy.log`, rotated to `.1` above 1 MiB.
MicroVMs start signed out. Under **Settings → Hosts → MicroVM sign-in** save a Claude
subscription token (`claude setup-token`) or Anthropic API key, and/or an OpenAI API key for
Codex. They are encrypted in the vault, hidden from agents, and sent only inside the run spec
(SSH stdin, then vsock) as the provider's environment in Firecracker sessions; Codex logs in
with `account/login/start` (`apiKey`) inside the VM. Codex credentialed sessions use
`CODEX_HOME=/run/boto/codex-home` on guest tmpfs; fake-key runs left no
`/root/.codex/auth.json` on the persistent workspace. With fake `OPENAI_API_KEY` or
`CODEX_API_KEY` alone, Codex `account/read` still reported signed out. Rejected VM credentials
show a redacted provider detail and direct the user to **Settings → Hosts**. Process placements
keep the host's login. Codex's own home and thread cache are ephemeral; if a thread cannot be
resumed, Boto starts a fresh Codex thread while retaining its chat history. `bun run
test:firecracker:providers` exercises fake Claude API/OAuth and Codex credentials, rejection
handling, persistence, and credential leak boundaries.

The five-provider guest image was verified in Firecracker with Claude Code 2.1.310,
Codex 0.164.0, Gemini 0.65.0, OpenCode 1.19.4, and Cursor Agent 2026.10.22-27dcf5f.
Cursor is installed under `/opt/cursor-agent-home` because guest startup bind-mounts the
persistent workspace over `/root`. Gemini and Cursor vault credentials reach only Firecracker
provider processes; invalid Gemini keys produce a redacted saved-credential rejection.
Cursor's `Failed to initialize session services` mapping while a microVM credential is set is
inferred: `proxy.log` shows the CLI reached `api2.cursor.sh`, but Cursor does not return an
explicit invalid-key error. Signed-out Gemini and Cursor surface `gemini` and `agent login`.
OpenCode has a 30-second, OpenCode-only first-activity watchdog. Message/thought chunks, tool
calls/updates, plans, or agent requests count as progress; session metadata updates such as
available commands do not. Without progress after a prompt it reports `opencode auth login` and
tears down the child; after the first progress, the prompt is unbounded. The provider suite also checks signed-out chats,
credential delivery, `isolation: "none"`, and plaintext leaks.

VMs have no network device: provider stdio, the agent-to-agent bridge, and an HTTPS proxy all
use vsock. The proxy resolves hostnames once and rejects requests if any IPv4 result is not
public. Agents can call `spawn_subagents` to run up to 8 tasks in parallel (each subagent
inherits the parent's host and isolation); the results come back as one message, and agents
talk to each other with `send_message`.

On a Linux host with Firecracker artifacts installed, run the opt-in host/SSH integration
suite with `bun run test:firecracker`. It uses temporary host roots and does not modify
`~/.boto`.
