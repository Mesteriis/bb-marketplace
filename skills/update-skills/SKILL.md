---
name: update-skills
description: Update installed agent skills against their upstream repos. Use when the user says "update my skills", "update matt's skills", or asks what upstream skills are new or deprecated.
---

# Update installed skills

`bb skills-sync` does the comparison. You do the judgment: say what actually changed, drive the choice, and merge conflicts by hand.

Never diff the trees yourself — the CLI already did it, deterministically.

## 1. Look

```bash
bb skills-sync status --json
```

You get the pinned commit, upstream HEAD, the commits between them, and every skill sorted into five buckets. `foreign` lists local skills from other origins; they are never touched and never worth mentioning beyond one reassuring line.

| Bucket | Meaning | Safe to apply |
|---|---|---|
| `new` | never installed | yes, if the user wants it |
| `deprecated` | upstream retired it | nothing to apply |
| `clean` | local matches the pin, upstream moved | yes |
| `dirty-conflict` | user edit **and** upstream moved | no — merge by hand |
| `dirty-only` | user edit, upstream untouched | nothing to apply |

## 2. Report what changed, not how much

Each skill carries `substantiveFiles` and `cosmeticFiles`. Cosmetic means the change survives only as punctuation — upstream rewrites dashes and quoting repo-wide, and a diffstat makes that look like twenty rewrites. Fold all of it into one line naming the commit. Then read the commit subjects and say what genuinely changed in behaviour.

A skill whose files are all cosmetic deserves one word, not a paragraph.

## 3. Ask

One `AskUserQuestion` call carrying every decision, so the user answers in a single pass:

- the `clean` bucket as a group
- the `new` skills, when there are any
- one question per `dirty-conflict` skill, describing their local edit in the question itself

Say plainly that `deprecated` and `dirty-only` need no answer, and move on.

When the choices are many or the diffs matter, point the user at the **Skills Sync** panel instead: it shows every diff inline and holds the selection while they read.

## 4. Apply

```bash
bb skills-sync apply --skill <name> --skill <name> --bump
```

Pass `--bump` only when nothing is left over: no unapplied `new` or `clean` skill, and no unresolved `dirty-conflict`. A pin that moves while a conflict is open hides that conflict from the next run.

Then merge each conflict by hand: read both diffs (`bb skills-sync diff --skill <name> --kind upstream` and `--kind local`), take upstream whole, re-apply the user's edit onto it, and show the result before writing.

## 5. Close

Name the behaviour changes, which local edits survived, and what you deliberately left alone.
