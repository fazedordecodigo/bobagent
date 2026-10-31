<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/desktop/public/assets/boto-logo-branco.svg">
    <source media="(prefers-color-scheme: light)" srcset="apps/desktop/public/assets/boto-logo.svg">
    <img alt="Boto" src="apps/desktop/public/assets/boto-logo.svg" width="240">
  </picture>
</p>

<h3 align="center">Your own team of AI bots, living on your desktop</h3>

<p align="center">
  <a href="https://github.com/fazedordecodigo/upbot/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/fazedordecodigo/upbot/actions/workflows/ci.yml/badge.svg?branch=develop"></a>
  <a href="https://github.com/fazedordecodigo/upbot/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/fazedordecodigo/upbot"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="macOS · Windows · Linux" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-informational">
</p>

Boto is a local-first desktop app where a team of AI bots work together on your everyday
tasks: researching and browsing the web, reading and organizing files, drafting emails and
documents, and using your connected apps. Each bot has its own name, role, memory and chat —
they message each other, delegate, share files through a shared workspace, and ask before
doing anything consequential. Under the hood, Claude Code, Codex and other ACP agents
(Devin, Cursor, Grok, OpenCode, Gemini) are the bots' brains.

Everything runs on your machine. Your bots, chats and secrets stay in `~/Boto` (or the
platform equivalent), secrets live in an encrypted vault, and nothing ever gets sent or
written on your behalf without your approval.

## Upgrading from UpBot

Quit the old app before starting Boto. Boto moves the default `~/UpBot` (or older
`~/BobAgent`) home to `~/Boto`, repoints stored bot workspaces, and migrates the
`com.upbot.desktop` (or `com.bobagent.desktop`) app data directory to `com.boto.desktop`.
The existing SQLite database becomes `boto.db`, including committed WAL records;
vault keys from the old Keychain/Secret Service names remain readable. Existing Boto
directories/databases are never overwritten or merged. Custom workspace roots stay put.

Update custom environment variables from `UPBOT_*` to `BOTO_*`. The daemon is now
`botod`, the remote helper is `boto-host`, and the MCP server is `boto`.
For remote hosts, stop active sessions, use **Install** again in Settings → Hosts to
migrate the default `~/.upbot` directory to `~/.boto` and upload the new helper, then
rebuild the Firecracker rootfs before launching microVMs. Persistent workspace disks
are retained. Custom host roots require the matching `BOTO_HOST_ROOT` setting.
The GitHub repository URL is unchanged; updater and marketplace URLs still use it.

## Why you'll like it

- **A team, not a chatbot.** Create bots with their own roles and memories; they talk to
  each other, hand off files and work together in group chats you can watch and steer.
- **Bots that do real work.** They browse the web in their own Chrome tabs, organize your
  files, read your email and prepare drafts, and publish HTML reports, dashboards and
  trackers to a local Pages library.
- **You're always in control.** Ask-first / allow-automatically approval rules, secure
  secret requests, browser take-over for sign-ins and CAPTCHAs — and a draft is never sent
  until you click Send.
- **Connected, on your terms.** Connect Notion, GitHub, Brave Search, Airtable, Stripe or
  any MCP server once and share them with the bots you choose; tokens stay in the vault.
- **Everywhere you are.** Reach your bots from Telegram, Slack, Discord, the mobile
  companion on your LAN, or share them with a team relay — plus routines on schedules and
  webhooks.
- **Built to grow.** A skills library, a marketplace of skills and bot templates, and bots
  you can create from a prompt — then run them on your Mac/PC, or on your own Linux VPS in
  Firecracker microVMs.

Built with Bun, SQLite, Tauri 2 (Rust) and React — with a warm design system of rounded
corners, soft colors and the Nunito typeface.

| Marketplace | Gateways |
|---|---|
| ![Marketplace](docs/screenshots/marketplace.png) | ![Gateways](docs/screenshots/gateways.png) |
| **Mobile companion** | **Team relay** |
| ![Mobile](docs/screenshots/mobile.png) | ![Team](docs/screenshots/team.png) |

## Get Boto

Download the installer for your OS from [Releases](https://github.com/fazedordecodigo/upbot/releases):

- **macOS:** install the `.dmg`; the app updates itself. Builds are not yet notarized by
  Apple — on first launch, open System Settings → Privacy & Security and click
  **Open Anyway** (or run `xattr -cr /Applications/Boto.app`). Versions before 0.2.1 were
  reported as "damaged"; use the `xattr` command for those.
- **Windows x64:** run the per-user `.exe` installer. Builds are unsigned, so SmartScreen
  may warn you: choose **More info → Run anyway** (in Portuguese, **Mais informações →
  Executar assim mesmo**).
- **Linux x64:** use the `.AppImage` for in-app updates (`chmod +x Boto_*.AppImage`, then
  run it), or install the `.deb` with `sudo apt install ./Boto_*.deb`. The `.deb` does not
  update itself; install newer `.deb` releases manually.

On Linux, install `libsecret-tools` to store the vault key in Secret Service. Otherwise
Boto uses a plaintext key file with owner-only permissions and warns at startup. Windows
stores new keys using DPAPI, and macOS uses Keychain. Computer Use and the built-in `say`
voice are macOS-only.

Boto was called BobAgent until 0.3.0; updating moves `~/BobAgent` to `~/Boto` and keeps
your bots, chats and vault.

## Run bots on your own server

Point Boto at a Linux VPS and each bot session can run there instead — as a plain process
or inside its own Firecracker microVM, with credentials delivered only inside the VM. Setup
guide, host requirements and microVM internals:
[docs/remote-hosts.md](docs/remote-hosts.md).

## Develop

```sh
bun install
bun run dev          # sidecar + tauri dev
bun run test         # daemon e2e tests
bun run lint && bun run typecheck
bun run build:app    # debug bundle for the host platform
```

Architecture and conventions: [AGENTS.md](AGENTS.md).

## Contributing

Boto is better with more hands — PRs, ideas, bug reports and skills for the marketplace
are all welcome. The [contributing guide](CONTRIBUTING.md) covers setup, the pre-PR
checklist and the few rules that keep the codebase easy to review, and
[AGENTS.md](AGENTS.md) explains how everything fits together.

Meet the people who built it so far:

<a href="https://github.com/fazedordecodigo/upbot/graphs/contributors">
  <img alt="Boto contributors" src="https://contrib.rocks/image?repo=fazedordecodigo/upbot">
</a>

Want to add yourself? Pick an [issue](https://github.com/fazedordecodigo/upbot/issues) or
open a small PR — focused changes get reviewed fastest. See the
[changelog](CHANGELOG.md) for what's shipped.

## License

[MIT](LICENSE)
