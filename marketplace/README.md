# BobAgent marketplace

`index.json` lists installable skills and agent templates. BobAgent fetches it from
`https://raw.githubusercontent.com/fazedordecodigo/bobagent/main/marketplace/index.json` by
default; you can add other registries (http(s) or file URLs) in the app.

Each item has `id`, `kind` (`skill` | `agent`), `name`, `description`, `author`, `version`,
`url` (relative to the index or absolute) and `sha256` of the file. Skills are `SKILL.md`
files with `name`/`description` frontmatter; agent templates are JSON
`{name, instructions, avatar?, provider?, skills?}` where `skills` are ids from the same index
that are installed together with the agent.

To publish, add the file and run `bun scripts/marketplace-index.ts` to regenerate the index.
