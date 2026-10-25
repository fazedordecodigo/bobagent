# Changelog

## Unreleased

## 0.2.0

### New
- MicroVM sign-in: save a Claude token/API key or an OpenAI API key (encrypted in the vault)
  and BobAgent passes it to Claude/Codex inside Firecracker sessions only.
- Settings & tools: Skills, Marketplace, Browser, Vault, Gateways, Mobile, Team and Hosts in
  one tabbed view.
- Remote hosts: run agents on a Linux VPS over SSH (`bobagent-host` helper, preflight, bridge
  over an `ssh -R` unix socket).
- Firecracker microVM per agent session on KVM hosts, with vsock bridge and a proxy restricted
  to public destinations; `packages/host/rootfs/build-rootfs.sh` builds the guest image.
- Subagents: `spawn_subagents`, `list_subagents`, `stop_subagent` bridge tools; parallel
  children with depth, fan-out and concurrency limits and automatic cleanup.

## 0.1.0

First public release.

### New
- Run Claude Code, Codex (native drivers) and ACP agents (Devin, Cursor, Grok, OpenCode, Gemini) side by side, each with its own workspace, queue, permissions and resumable session.
- Agents message each other, share files and collaborate in channels with an owner and delegation.
- Track context usage and cost per agent; long conversations compact automatically.
- Give agents avatars and memories; share a skills library; create agents from a prompt.
- Schedule routines or trigger them by webhook; attach images, audio, video and ZIP files.
- Let agents drive their own Chrome tabs, and opt in to Computer Use per agent.
- Keep secrets in an encrypted vault with GitHub, 1Password and Bitwarden connectors; read replies aloud and dictate.
- Talk to agents from Telegram, Slack and Discord with an allowlist.
- Install skills and agent templates from the marketplace.
- Pair your phone on the local network to chat and approve permissions.
- Share agents with teammates through a self-hostable relay.
- Update the app from inside it.
