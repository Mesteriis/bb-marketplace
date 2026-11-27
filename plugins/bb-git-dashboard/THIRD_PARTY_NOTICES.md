# Third-party notices

## bb-github-actions

- Source: https://github.com/pers0na2dev/bb-github-actions, revision 337890140c9503fedde7dd7da8e8ea4ed24c7f0b (vendored in this repository as `plugins/github-actions`).
- Used in: `src/core/ci/dispatch.ts` (reading `workflow_dispatch` inputs; adapted to take a parsed document).
- License: MIT

```
MIT License

Copyright (c) 2026 pers0na2dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## bb-git-history

- Source: https://github.com/yusuf8834/bb-git-history, revision 816bc8c329bcea6276cd9be5fd19dec1926aa584 (vendored in this repository as `plugins/git-history`).
- Used in: `src/core/history/graph.ts` (lane layout, as is), `src/ui/history/graph-cell.tsx` (row geometry of the graph), `src/core/history/parse.ts` (parsing of Git output, adapted), `tests/history-graph.test.ts` (tests, moved to node:test).
- License: MIT

```
MIT License

Copyright (c) 2026 Yusuf Akbulut

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## bb-github-pr-dashboard

- Source: https://github.com/ahsan7162/bb-github-pr-dashboard, upstream revision e1e1881a6beddb7419bf117c9bd1743ada73a22e (vendored in this repository as `plugins/bb-github-pr-dashboard`; ported from that directory as of repository commit 898660bcd3b467d73b5d879d1185f5be06191264).
- Used in: `src/core/pulls/model.ts` (inbox row, blockers and search; adapted to every forge), `src/core/pulls/github.ts` (GitHub GraphQL mapping, checks and stacks), `src/core/pulls/watch.ts` (alert diffing and push text), `src/core/pulls/queries.ts` (GraphQL text of the tabs and the watcher), `src/core/pulls/{detail,github-detail,diff,review,prompt,agent-target}.ts` (pull request detail, its GitHub mapping, files and line anchors, review rules, agent prompts and thread target), `tests/pulls-ported.test.ts` and `tests/pulls-detail-ported.test.ts` (tests). Since 0.9.3 also: `src/core/pulls/jira.ts` (the Jira links of `prs.ts`: `jiraPrefixes`, `jiraSite`, `jiraHref`, `linkJira`, as they are) and `src/ui/review/pr-text.tsx` (follows `JiraTitle` and `Body` of `detail.tsx`, with `tests/pulls-jira.test.ts` from `prs.test.ts`)), `src/app/pr-links.tsx` (follows `PrLinkListener` of `app.tsx`), `src/ui/pulls/inbox-page.tsx` (the Open tiles, Showing N of M, Updated N ago and the kept tab, search and scroll follow `app.tsx`) and `src/app/notification-settings.tsx` (follows `NotificationSettings` of `alerts.tsx`). Since 0.9.4 also: `src/app/alerts.tsx` (follows `AlertListener` and `useAlertBadge` of `alerts.tsx`) and `threadFilter` in `src/core/pulls/detail.ts` (the Unresolved / Resolved lists and the waiting count of `ThreadsTab` in `detail.tsx`).
- License: MIT

```
MIT License

Copyright (c) 2026 Muhammad Ahsan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## diff-review

- Source: https://github.com/gpambrozio/bb-plugins (`diff-review`), upstream revision 240f0372f9292084756612227624f5f6185a341a (vendored in this repository as `plugins/diff-review` through the fork https://github.com/Mesteriis/gpambrozio-bb-plugins, branch `marketplace/diff-review`, commit 2130a3f470ad1ddc3ddc4f5b1a8f48dce5ccec14; ported from that directory as of repository commit da73dd23).
- Used in: `src/core/code-review/{anchors,patch-lines,suggestion,revert,git-spec}.ts` (as they are, imports adjusted), `src/core/code-review/model.ts` (the review model of `shared/types.ts`: sessions per working copy instead of per BB environment, without the `files` and `pr` views), `src/core/code-review/diff.ts` (the host diff schema of `shared/host-contract.ts`), `src/core/code-review/prompt.ts` (`server/prompt.ts`, with the `bb git-dashboard review` command and a longer fence for code), `src/adapters/bb/review-git.ts` (`host/git.ts`: every view computed on the host, without the pull request fetch and the index fingerprint), `src/adapters/bb/review-store.ts` (the tables and send bookkeeping of `server/store.ts`, keyed by working copy, with the answer right checked in its transaction), `src/adapters/bb/code-review-cli.ts` (`decodeText`, `textOf` and `formatThread` of `server/cli.ts`), `src/adapters/bb/code-review-service.ts` (follows `server/review.ts` for sends, answers, no-reply marks and applied suggestions), `skills/git-dashboard/SKILL.md` (the answering rules of `skills/diff-review/SKILL.md`), `tests/code-review-{anchors,suggestion,git}.test.ts` (tests, vitest replaced by node:test with `tests/vitest-expect.ts`). Since 0.9.1 also: `src/core/code-review/mentions.ts` (`shared/mentions.ts`), `src/core/code-review/run-prompts.ts` (`server/run-prompts.ts`, without the `files` and `pr` views, for the `bb git-dashboard review` command), `src/core/code-review/tool-names.ts` (`server/tool-names.ts`, renamed `git_review_*`), `src/core/code-review/runs.ts` (the permission, reasoning, changed-files and ranges rules of `server/runs.ts`, with a fingerprint taken from the uncommitted view's diff), `src/adapters/bb/review-run-store.ts` (the runs table and its methods of `server/store.ts`, without the `mention` kind), `src/adapters/bb/code-review-runs.ts` (follows `server/runs.ts`: starts on the working copy, without Clear review and orphan reviews), `src/adapters/bb/code-review-tools.ts` (the comment tools of `server/tools.ts`), `src/ui/code-review/ai-runs.tsx` and `run-labels.ts` (follow `app/ai-review-dialog.tsx`, `app/execution-picker.tsx` and `app/runs-list.tsx`), `tests/code-review-{mentions,run-prompts}.test.ts`. Since 0.9.2 also: `src/adapters/bb/review-revert.ts` (`host/revert.ts` as it is, imports adjusted, plus `revertShown`) with `tests/review-revert.test.ts` (`host/revert.test.ts`, vitest replaced, the file-size-limit runs without an esbuild bundle), `src/adapters/bb/review-ignore.ts` (`server/ignore.ts`, read on the copy's host), `src/adapters/bb/review-watch.ts` (follows the watch lease of `server/review.ts`), `src/core/code-review/view-memory.ts` (`app/view-memory.ts`), `src/core/code-review/view-state.ts` and `src/ui/code-review/kept-state.tsx` (`shared/types.ts` view states and `app/view-state.tsx`), `src/ui/code-review/commands.ts` (`app/commands.ts`), `src/ui/code-review/navigation.ts` and `navigate-bar.tsx` (follow `app/find.ts`, `app/comment-nav.tsx`, `app/goto-dialog.tsx`), `src/ui/code-review/reviews-page.tsx` (follows `app/reviews-page.tsx` and `app/orphans.tsx`), `src/ui/code-review/revert-form.tsx` (follows `app/revert-dialog.tsx`), `src/app/review-open.tsx` (follows `app/open-overlay.tsx`), and the pull request mirror and draft answers in `src/adapters/bb/review-store.ts` and `src/ui/review/thread-view.tsx` (follow `server/pull-requests.ts` and `app/thread-card.tsx`).
- License: MIT (the package's `license` field; author gpambrozio). The plugin directory carries no license file of its own; the MIT terms are:

```
MIT License

Copyright (c) gpambrozio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### diffity, through diff-review

diff-review adapts parts of [diffity](https://github.com/nilbuild/diffity) (commits `ce9de40` and `ebeb656`); the parts ported here keep that origin: `suggestion.ts` adapts diffity's `src/features/suggestions/suggestion.ts`, the review model and the `__general__` / line 0 conventions follow `src-tauri/src/core/store.rs`.

diffity is licensed under the MIT License:

```
MIT License

Copyright (c) 2026 Kamran Ahmed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Shiki

- Source: https://github.com/shikijs/shiki, npm packages `shiki`, `@shikijs/langs` (a direct dependency: the server bundles its grammars), `@shikijs/core`, `@shikijs/engine-javascript`, `@shikijs/types`, `@shikijs/primitive`, `@shikijs/vscode-textmate` 4.6.0 (vscode-textmate 10.1.0), with `oniguruma-to-es`, `regex`, `regex-recursion` and `regex-utilities` (MIT) under the JavaScript regex engine. A dependency, not copied: `bb plugin build` bundles it.
- Used in: `src/ui/highlight/shiki.ts` (the highlighter core and its JavaScript regex engine, in the app bundle) and `src/adapters/bb/grammars.ts` (52 TextMate grammars of `@shikijs/langs`, in the server bundle, served one per request by `GET /grammar`).
- License: MIT. `@shikijs/langs` is published under MIT; the grammars it carries come from their upstream repositories through https://github.com/shikijs/textmate-grammars-themes, which lists each grammar's source and license.

```
MIT License

Copyright (c) 2021 Pine Wu
Copyright (c) 2023 Anthony Fu <https://github.com/antfu>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## GitWand (the BB plugin)

- Source: this repository's tag `gitwand/v0.2.0`, `plugins/gitwand/src/core/git-remotes.ts` and `src/core/repo-catalog.ts` (the plugin's own core, not code of the GitWand application it wraps).
- Used in: `src/core/catalog/catalog.ts` (`remoteKey`, now built on `parseRemote`; `parseConfigRemotes`; `buildCatalog` and `keepFailedSources`, adapted to the accounts of every forge) and `tests/catalog-core.test.ts` (the remote and config cases).
- License: MIT

```
MIT License

Copyright (c) 2026 Mesteriis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
