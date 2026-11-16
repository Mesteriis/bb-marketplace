# Skills Sync

Keeps agent skills installed in a flat folder (`~/.agents/skills`) in step with
the git repositories they came from.

The install folder is not a checkout. A marker file — `.mattpocock-skills-version`
for the mattpocock source — pins the upstream commit the installed skills came
from. Every answer this plugin gives comes from comparing three trees:

- **P** — the tree of the pinned commit
- **H** — the tree of upstream `HEAD` (or whatever `ref` names)
- **L** — the flat local install

## Buckets

Every skill lands in exactly one bucket:

| Bucket           | Condition                     | Meaning                                    |
| ---------------- | ----------------------------- | ------------------------------------------ |
| `new`            | in H, not in L, not offerable at P | never installed and never declined    |
| `deprecated`     | in P and L, gone from H       | upstream retired it (or moved it to `deprecated/`) |
| `clean`          | L == P and H != P             | safe to overwrite                          |
| `dirty-conflict` | L != P and H != P             | you edited it and upstream moved: hand merge |
| `dirty-only`     | L != P and H == P             | your edit stands; nothing to decide        |

`new` means "not installed and not already declined". Declining requires the
skill to have been *offerable* at the pin — present, and in neither a
`skipBuckets` bucket nor `deprecated/`. So a skill upstream promotes out of
`in-progress`, or revives out of `deprecated/`, is offered as new even though it
was in the pin. That is the same bucket move that produces `deprecated`, read in
the other direction.

A skill whose install is byte-identical to H is in no bucket, whatever the pin
says. A stale marker — from a manual copy, an interrupted apply, or a second
install route — would otherwise report every already-current skill as a
conflict. Reporting never writes the marker; you still apply and `--bump`
deliberately.

A local folder with no upstream match is **foreign**: it belongs to another
origin, or you wrote it. Foreign folders are listed for information and are
never modified, deleted, or offered.

## The cosmetic pass

Upstream sometimes makes repo-wide punctuation edits — one real commit removed
every em-dash from every file. A raw diffstat cannot tell that apart from twenty
genuine rewrites, so every changed file is diffed twice: raw, and again through
a normaliser that collapses dashes, quotes, and runs of whitespace and
separating punctuation.

- differs raw, matches normalised → **cosmetic**, reported in `cosmeticFiles`
- still differs after normalising → **substantive**, reported in `substantiveFiles`

## Safety

`apply` acts on an explicit list of names you pass. It never globs, scans, or
sweeps the install folder. Before touching a name it must resolve to an upstream
skill folder for that source, so foreign names are refused. The pin marker is
written **last**, only with `--bump` and only when every requested name landed —
a partial run leaves the marker honest.

## CLI

```
bb skills-sync sources [--json]
bb skills-sync status [--source <id>] [--refresh] [--json]
bb skills-sync diff --skill <name> [--kind upstream|local] [--source <id>] [--json]
bb skills-sync apply --skill <name> [--skill <name>...] [--bump] [--source <id>] [--json]
```

`status` reuses a cached clone; `--refresh` forces a fetch. Long output is
truncated with a notice so it stays under BB's CLI byte cap — narrow the request
or use the panel for the full text.

## Settings

One setting, `sources`: a JSON array of upstream repositories.

```json
[
  {
    "id": "mattpocock",
    "url": "https://github.com/mattpocock/skills.git",
    "ref": "HEAD",
    "skillsDir": "skills",
    "nested": true,
    "skipBuckets": ["in-progress", "deprecated"],
    "installRoot": "/Users/you/.agents/skills",
    "marker": ".mattpocock-skills-version"
  }
]
```

`nested: true` means skills live at `<skillsDir>/<bucket>/<name>`;
`false` means `<skillsDir>/<name>`. `skipBuckets` are never offered as new.
A malformed value puts the plugin in `needs-configuration` with the parse error
rather than failing to load; fix it with `bb plugin config skills-sync` and
reload.

## Multi-machine caveat

This plugin reads and writes the **BB server's own filesystem** through
`node:fs`, so on a multi-machine setup it syncs the server's skills folder and
not a remote host's — a deliberate limitation for a personal single-machine
setup.

## Layout

- `contract.ts` — the shared RPC contract and zod schemas, used by both halves.
- `sync.ts` — the whole engine: clone cache, tree materialisation, bucketing,
  the cosmetic pass, unified diffs, apply. Free of the `bb` API, so it unit-tests
  without a host.
- `server.ts` — wiring only: settings, RPC, the `bb skills-sync` command, the
  `skills-applied` realtime signal published after a successful apply.
- `app.tsx`, `components/sync/` — the panel.
- `tests/` — backend tests (`npx vitest run --project server`).

Run everything with `npm test` and `npm run typecheck`.
