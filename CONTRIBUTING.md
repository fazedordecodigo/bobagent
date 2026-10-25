# Contributing to UpBot

Thanks for helping. UpBot is a macOS app (Tauri 2 + React) with a Bun daemon; read
[AGENTS.md](AGENTS.md) for the architecture before larger changes.

## Setup

Requirements: macOS 14+, [Bun](https://bun.sh) 1.4.4, Rust stable.

```sh
bun install
bun run dev
```

## Before opening a PR

```sh
bun run lint        # Biome
bun run typecheck
bun run test        # daemon e2e tests (fake providers, no accounts needed)
cd apps/desktop/src-tauri && cargo check
```

CI runs the same checks on macOS.

## Guidelines

- Keep PRs focused; one feature or fix per PR.
- Wire contract changes go in `packages/protocol` first (zod schemas + `methodMap`).
- New daemon behaviour needs an e2e test in `packages/daemon/test` using the fakes in
  `test/fixtures`.
- Database changes are new entries at the end of `src/db/migrations.ts`; never edit old ones.
- Pin exact dependency versions.
- Never log or return secrets; tokens belong in the vault.

## Reporting security issues

Please do not open public issues for vulnerabilities. Use GitHub's private
"Report a vulnerability" form on the repository's Security tab.
