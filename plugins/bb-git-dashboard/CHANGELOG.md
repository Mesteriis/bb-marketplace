# Changelog

## 0.14.1 — 2026-11-28

The new interface, second slice: the overview.

- **Overview** opens the Git panel. As a list it shows what needs your action (CI failed in your pull request, a review asked of you, a merge conflict, changes requested, open threads), what you can finish (ready to merge — green CI and an approval, as the forge reports them; commits not pushed or a branch never published) and what goes on without you (CI running, a copy behind origin); the chosen item's details say what keeps it from merging and lead to the page where its action is. As a board it shows the same objects by stage — local (unpushed, never published or behind origin), PR open, in review (including reviews asked of you), ready, merged this week — each card with its state as a word and the row's action, under CI now: what runs and what failed within a day, with a way to all runs. `j`/`k` move through the list, Enter opens the item.
- It reads through the plugin's existing calls: My PRs' Open and Review requested tabs, CI/CD's overview and the status of up to 50 attached copies (Merged only when the board is shown) — on opening, that is the requests of those pages together. A complete read is kept for five minutes; Refresh reads again. It writes nothing itself. A source that does not answer is named and the rest is shown.
- **Overview opens as** (List / Board) is a setting; the view chosen in the overview is kept. Projects moved to their own place in the sidebar.
- The first line of a language's first diff is highlighted: each grammar is compiled once before its first line, which used to run out of its time and come plain.

## 0.14.0 — 2026-11-27

The new interface, first slice: its system and the side column.

- **One navigation.** The Git panel's sidebar now holds every section — My PRs, CI/CD, Reviews, Projects, Catalog — with their counts (new alerts, open comment threads, connected accounts), the projects folder tree with each project's sources and actions (⋯), Connections and the language. The row of section buttons above the projects and the breadcrumbs that served as navigation are gone. `/` puts the cursor in the sidebar search.
- **Connections** is a section of its own: the connected accounts, **+ Add connection** and the accounts' repositories.
- **Russian and English.** The interface language follows BB's until RU or EN is chosen in the sidebar or **Interface language** (As in BB / Русский / English) in the plugin settings; the choice is kept for every window. The sidebar uses it now; each section follows as it moves to the new interface.
- **Colours from BB's theme.** Status colours and their tones are derived from BB's background, so they hold 4.5:1 in BB's light and dark modes and in every palette BB ships (Catppuccin, Dracula, Gruvbox, Nord, Solarized), with no theme of the plugin's own.
- Dialogs keep the keyboard focus inside and give it back to the button that opened them; Escape in a dialog closes the dialog only (it used to close the whole Git panel behind it). The catalog's check boxes no longer stretch across their row.

## 0.13.2 — 2026-11-27

The token of a new repository in the Keychain.

- **New project…** with a repository now saves the account's token in the macOS Keychain for that repository's exact address and the account's username, right after the forge has made it with this account, and then pushes main. The token reaches the helper on stdin of the host's own `git credential approve` only — not arguments, environment, `.git/config`, logs or error text — so the push finds it and macOS does not ask for access.
- The preview says so before confirming; the activity log records that the entry was saved (or why not), without its value.
- The entry is read back through the same `git` and helper (`git credential approve` reports success whatever the helper did). If the Keychain did not keep it, main is not pushed: the repository stays empty with origin set, and the answer names the reason and what to do. A repository whose creation was not confirmed gets no entry.

## 0.13.1 — 2026-11-27

A new project's repository on a forge.

- **New project…** can also create the repository with a connected GitHub, GitLab, Gitea or Azure DevOps account — in the account's own namespace, an organization, a GitLab group or an Azure project — and push main to it. The repository is **private** unless Public is chosen; a public one is spelled out in the form and in the preview. An Azure repository takes its project's visibility, which is checked against the choice before anything is made.
- The first push goes the way fetch and push do: origin is the plain clone address, and Git takes the HTTPS credential from the macOS Keychain entry for the new repository's path (add it before, or push main from Git later). No token reaches the remote address, `.git/config` or a command line. Afterwards main follows origin/main and the copy is linked to the repository.
- A step that does not go through leaves the project made and says what is left; a lost answer is told apart from a refusal. Creating the repository and pushing are recorded in the publication activity.
- `MAKOSH_GIT_CA_FILE`, when set for BB, is the CA bundle HTTPS Git verifies forges against (a self-hosted forge on a private CA).

## 0.13.0 — 2026-11-27

Scaffolds: new projects from a skeleton.

- **New project…** in the Catalog: a scaffold, a category of the projects folder and a name, its parameters, the CI of a chosen forge and the commit author; the files are listed and can be read before anything is written. After a preview, the folder is made with git init on main and a first commit, and the copy is attached in Git. Only a new folder inside the projects folder, never inside another project; a failed step removes the folder again.
- Built-in scaffolds: **Python service (uv)** (a plain asyncio service or FastAPI, Docker optional), **Go service with a web UI** (golangci-lint and govulncheck pinned, React + Vite + TypeScript in web/ and Docker optional) and **BB plugin** (server with an RPC, optional app page and host entry, core and UI kept free of host code, typed ESLint). Each was generated and passed its own `make check` with the pinned versions.
- Every scaffold gets the common files: LICENSE (MIT, Apache-2.0 or none), SECURITY.md, README.ru.md, AGENTS.md and CLAUDE.md, .editorconfig, .gitattributes, .gitignore (`.env*` but `.env.example`, `.zed/`), CHANGELOG.md and THIRD_PARTY_NOTICES.md; CONTRIBUTING.md and CODE_OF_CONDUCT.md by choice.
- The CI file comes from the 0.12 templates by the stack of the generated files and calls `make check`.
- Own scaffolds in the same JSON format from the **Scaffolds: own scaffolds** setting or a folder on the machine. Free text goes as it is only into Markdown, LICENSE and NOTICE, quoted with `|json` into other files and never into shell, Make or Docker files; no file goes into `.git` or is a `.env` other than `.env.example`; a scaffold with secret-like text, or that does not render with every choice, is listed with the reason and not offered.
- CI templates: Corepack is installed before it is enabled (Node.js 25+ ships without it); uv uses `--locked` only with a committed `uv.lock`; a root Makefile with a `check` target is what CI runs; a Go project with web/ gets Node.js for it (a job of its own on GitLab).

## 0.12.0 — 2026-11-27

CI templates.

- **Templates** in the Actions tab: the stack is read from the copy at `origin/<default branch>` as last fetched, else at HEAD (Node.js with its package manager, Node version and scripts; Python with uv, Poetry, pip or a bare pyproject and pytest; Go with its version; Rust; a Dockerfile), and the templates of the linked forge that suit it come first.
- Built-in templates for Node.js, Python, Go, Rust and a Docker image build on GitHub Actions, Gitea Actions, GitLab CI and Azure Pipelines. They hold only the pipeline and its parameters: no secrets, nothing deployed or pushed.
- Own templates in the same JSON format from the **CI templates: own templates** setting or a folder on the copy's machine (**CI templates: folder of own templates**). A template that does not render with its defaults, or carries a private key, a token, an address, an IP address or a `.env` file, is listed with the reason and not offered.
- The form shows each parameter and the file as it will be written; a value that does not fit its parameter is refused before anything is sent. **Create branch and pull request** renders the file again on the server, previews the new branch from the default branch's head, and after confirmation commits the file there through the forge's API and opens the pull request. The branch must be new; a template writes only where its forge reads CI files. If a branch was left by a failed write, the outcome names it (on GitHub a branch whose file was refused is removed again).
- On GitHub, writing a workflow file needs a token with the `workflow` scope.

## 0.11.0 — 2026-11-27

The project catalog.

- **Каталог** in Git: the projects of a machine's projects folder (by the rules of the Projects folder setting) and the repositories of every connected GitHub, GitLab, Gitea and Azure DevOps account in one list. A repository a local project has as a remote is marked **cloned**, with its folder; one seen by two accounts is one row. An account that does not answer keeps its last listing and says so.
- **Clone…** asks every time for a category (a folder of the projects folder that holds projects) and a name, then previews the clone before it runs.
- **Status, Fetch, Pull** for chosen local projects, one answer each; fetch and pull are confirmed with the list of projects, and pull only fast-forwards a clean branch behind its upstream. SSH remotes are reached with your SSH keys in batch mode (it never asks), HTTPS ones with the connected account of their server; only projects inside the projects folder are touched.
- **Open pull requests** of chosen repositories, listed together and opened in Makosh Git.
- A merge or rebase that took in a commit which reached the branch while it was being confirmed says which, with **Abort** while it is in progress or **Undo** once done.
- Ported from GitWand gitwand/v0.2.0 (MIT): the remote key, reading remotes from a Git config and the merge of listings.

## 0.10.0 — 2026-11-27

Merge, rebase and a conflict editor.

- **Branches** lists local and remote-tracking branches with **Merge into** the current branch and **Rebase onto** (an ordinary rebase, not interactive). The confirmation says beforehand how many commits come and which files will conflict (Git's merge-tree, without touching the tree); a merge can fast-forward or always make a merge commit. Both start only on a clean tree at the head that was shown, and ask for a Git author where the copy has none.
- **In progress:** a bar for a merge, rebase, cherry-pick or revert left in progress, with its step (commit N of M), its conflicted files, **Continue**, **Skip** (rebase, cherry-pick) and **Abort**, each confirmed.
- **Conflict editor:** each conflict side by side with the base, answered by one side, both in either order, the base, picked lines or typed text; the result can be edited as a whole before **Save and mark resolved**, which writes it over the file as it was read and stages it. A file one side deleted, or that is not text, is taken whole from a side or deleted.
- A rebase keeps each commit's author; Git never waits for an editor; conflict markers are written in the zdiff3 style.

## 0.9.4 — 2026-11-27

The three remaining differences from bb-github-pr-dashboard, on the owner's decision.

- **Alerts across BB:** new My PRs alerts show as toasts anywhere in BB, with **Open** to the pull request in Makosh Git (My PRs for the test alert), while **My PRs: show alerts as toasts** is on; Git's navigation entry shows the unread count while **My PRs: show the unread count** is on.
- **Prev / Next** and **N of M** on a pull request opened from My PRs, beside the [ and ] keys.
- **Comments:** **Unresolved / Resolved** with their counts, and **N waiting on your reply** on your pull request (**N answered by the author** on someone else's). Drafts of your unsubmitted review stay on Files.
- **Apply suggestion** keeps a file's mode under a strict umask (a 0755 script became 0700 under umask 077).
- Ported from bb-github-pr-dashboard (MIT): the alert toasts and badge, and the Comments filter.

## 0.9.3 — 2026-11-27

The pull request page and My PRs catch up with bb-github-pr-dashboard, so it can be removed.

- **Pull request menu (⋯):** Refresh, Copy link, Copy PR number, **Link to thread…** (sends the pull request to a thread as context), **Ask a question** and **Explain this PR** (BB's composer with the pull request as context). The branch name copies on click.
- **Delete** your own comment, after a preview: GitHub, GitLab and Azure DevOps; on Gitea, discussion comments only (its API does not delete review comments).
- **Markdown and Jira:** descriptions and comments render as Markdown; Jira keys of the projects a pull request names (in its title, branch or a Jira link) link to BB's My Jira when it runs, else to the Jira site.
- **Files:** a file list with each file's open comment threads, **Side by side** (kept), **j / k** through files and **n / p** through open comments. A thread on Comments shows its diff fragment and **Show in diff**.
- **Syntax highlighting** with Shiki on the pull request's Files and in Review, in BB's code theme (light or dark, following it). It loads with the first shown diff, paints a file once it nears the screen, fetches one grammar per language from the plugin's server and leaves folded, deferred and large changes (over 2,000 lines) plain, as it does any diff it fails to paint.
- **My PRs:** tiles on Open (CI failing, Unresolved comments, Changes requested, Ready to merge), **Updated N ago**, **Collapse all / Expand all**, **Showing the N most recently updated of M**, search over the whole Merged or Closed history on GitHub (up to 1,000), and coming back from a pull request on the same tab, search, row and scroll.
- **Notifications** in the plugin's settings sends a test alert; the bell in My PRs opens them.
- A plain click on a github.com pull request link anywhere in BB opens it in Makosh Git (with a github.com account connected).
- **Fix with agent** starts a new thread on the machine of the project's working copy, not the project's first environment.
- New dependency: Shiki 4.6.0 (MIT). Ported from bb-github-pr-dashboard (MIT): the Jira links, the link listener, the tiles and list notes, and the notification test.

## 0.9.2 — 2026-11-27

The rest of diff-review, so it can be removed: its parity checklist has no "missing" row left.

- **The view:** Review remembers the picked view and its switches per thread tab or working copy; a first look at an empty uncommitted view shows the branch's commits instead; **Side by side**; the commit view lists HEAD's recent commits; **Any file** comments on any file of the copy, changed or not.
- **Following the copy:** an edit, a stage or a commit reloads the Review by itself (a watch on the copy's host while the Review is on screen). Patches come in batches of 25 after the file list, with Retry; changes over 2,000 lines start folded.
- **Files:** **Viewed** marks (cleared when the file's change moves on; a viewed file folds), **Open** in BB's preview, **Revert…** a file or chosen hunks in the uncommitted view after confirming, and files left out by **Line review: files to leave out** and the copy's `.diffityignore` / `info/diffityignore`, counted in the stats.
- **Moving around:** **Find** (⌘/Ctrl+F, Enter / Shift+Enter, Match case), **Go to** a file, comment or view (⌘/Ctrl+P), previous and next comment, and palette commands for the Review's actions.
- **Kept per tab and view:** unsent comments, folds and scroll; drafts on files a view no longer shows are listed apart.
- **Comments** render as Markdown (BB's chat rendering). **Clear review** deletes a view's threads and closes its AI runs. **Line review: colours for colour blindness** shows blue and orange.
- **Reviews** in Git lists every review with its open threads, with a count on the button; reviews of detached copies can be deleted. A **Review** button in the thread header and a row in the thread's Info. `bb git-dashboard review open [file] [--view …] [--thread …]` opens a thread's Review in the window that shows it.
- **Pull requests:** threads sent with **Fix with agent** are mirrored, so the agent answers each by id; its answers wait under the thread as drafts to **Post**, **Post and resolve**, **Edit** or **Discard**. Fix with agent now names the host of the new thread's worktree (it failed when it had to start a thread).
- **@reviewer** that cannot start a reviewer (no BB project and no thread on the copy) says why at the comment.
- Ported from diff-review (MIT): the revert, watch, ignore, view memory and state, commands, find, Go to and Reviews page parts.

## 0.9.1 — 2026-11-27

AI runs of the line review, the second part of taking over diff-review (0.9.2 brings the rest).

- **AI review** in Review: an agent reviews the view, with focuses (Security, Performance, Correctness, Naming, Tests, Types) and your own instructions, or summarizes it, in a thread of its own on the working copy, a child of the reviewed thread when there is one. Its comments arrive as line, file or whole-diff threads signed by its provider.
- **Explain** on a file, or on selected lines, starts a run that leaves the explanation as a comment there.
- **@reviewer** (or @agent) in a comment asks the view's reviewer: the question goes to the latest open review run's thread as a new turn, or starts a reviewer.
- **Fix in a new thread** in Send to agent sends the chosen threads to a new thread on the copy instead of an existing one; it answers them like any thread they were sent to.
- **AI runs** under the toolbar: each run's state, Open thread, and Close, which archives its thread and takes away its rights. A run that should not edit lists the files that changed on the copy while it ran.
- The picker is BB's own provider, model and reasoning picker, reading the catalog where the run starts. New settings: **Line review: provider for AI runs**, **model for AI runs** and **permission mode for AI runs** (Approve for me or Accept edits; full mode where the provider lacks it).
- An AI review run may answer every thread of its review. Runs comment with `git_review_comment` and `git_review_general_comment`, or `bb git-dashboard review comment`; a comment off the diff is refused with the lines the diff shows.
- Ported from diff-review (MIT): the run prompts, @reviewer mentions, the run service, store and tools.

## 0.9.0 — 2026-11-27

Line review, the first part of taking over diff-review (0.9.1 brings its AI runs, 0.9.2 the rest).

- **Review** in Git for each working copy, and a **Review** tab in threads: uncommitted, staged or unstaged changes, a branch's commits or all changes since a base (the copy's default branch when left empty), one commit, or a range `a..b` / `a...b`. Hide whitespace, only files with comments, wrap lines.
- Comment on a line (Shift+click for a range on one side), a file or the whole diff, with a severity (must fix, suggestion, nit, question). Threads follow their code as it moves and are listed apart when it is gone. Reply, resolve, dismiss and reopen; edit and delete your own comments.
- **Suggest a change** adds a suggestion block seeded with the commented lines; **Apply suggestion** writes it over those lines of the working file, only while the file is as the view read it, and resolves the thread.
- **Send to agent** puts the chosen open threads, with the commented code and a review summary, in a thread working on the copy (the current one in a thread's tab). Each thread then shows Sent, Answered or No reply.
- The agent answers each thread from that thread: `bb git-dashboard review list|reply|resolve|dismiss` (text as base64 through stdin) or the `git_review_*` tools; answers from any other thread are refused. The git-dashboard skill describes it.
- The whole `bb git-dashboard` CLI is declared with BB's command parser: `--help` at every level, usage errors with codes, and `--json` error envelopes. `ci list --active --failed` together is now refused instead of showing the failed runs.
- **Edit description** on a pull request's Overview, previewed and confirmed: 0.7.0 listed editing the description, but only the title had a control.
- Ported from diff-review (MIT) with diffity's parts (MIT): anchors, patch lines, suggestions, ranges, the host's diffs, the store, the send prompt and the review CLI, with their tests.

## 0.8.0 — 2026-11-27

Parity with git-history and github-actions, so both can be removed.

- **History in a thread:** a Git History tab in the thread panel's New tab, and a Git History button in the thread header when **History: show a Git History button in the thread header** is on.
- **History:** Find in loaded commits by subject, hash prefix, author, e-mail or ref, with the match count; Enter and Shift+Enter step through matches. A Refresh button. Commits grouped by day (Today, Yesterday, weekday, date) under sticky headings with their count. At most three refs per row, the rest as "+N". Conventional-commit prefixes are marked. **History: draw branch and merge lanes** turns the graph off. Patches have Wrap long lines, +/− counts and "N changed lines". A patch over 1.5 MB is cut at a whole line and says so instead of failing.
- **CI/CD in a thread:** a CI/CD tab for the thread's working copy, with **Send to this thread**.
- **CI/CD overview:** **CI/CD** in Git lists the latest runs of every linked repository, with an All repositories filter and Running, Queued, Failed and Success rate tiles; the tiles also head each repository's runs. Durations tick while a run is active.
- **Logs:** a line filter with its count, Copy log, Follow the end, Open job on the forge.
- **Runs:** Run with inputs… from a run row or a run opens Run workflow on its workflow and branch; Copy link; Run workflow is offered only when the token may push. Workflow lists are read once per five minutes.
- **Agents:** **CI/CD: project for investigations of repositories without a BB project** lets Ask agent, Send and failure notifications work for copies outside BB projects (the thread starts in that project's default environment). **CI/CD: model for failure investigations** picks the model of new investigation threads. **Ask agent with another model…** opens the composer with the prompt. Send to threads takes a message (a default one for a failed run) and an Include log excerpts switch, and remembers the last recipients.
- **CLI:** `bb git-dashboard ci list|show|workflows|run|rerun|cancel` on the thread's working copy. Reads need Read access; writes need Stage and commit and the owner's approval in the thread. The git-dashboard skill describes it.
- **Rate limits:** a pull request or issue page refused by the forge's rate limit counts down the seconds the forge named and reads again by itself, with Try now.

## 0.7.1 — 2026-11-27

- A pull request page needs only the pull request itself: on GitLab, Gitea and Azure DevOps its discussions, reviews, approvals, commits, statuses and your own user are read on their own, and one that fails leaves the page open with a line saying what is missing and why (live check on gitlab.com, where one such read answered 401 and took the whole merge request page down).

## 0.7.0 — 2026-11-27

- **Pull request page** for GitHub, GitLab, Gitea and Azure DevOps, opened from My PRs (click or Enter; ↗ still opens the forge; [ and ] step through the list): header with state, branches, size, blockers, reviewers and labels; Overview with the description and discussion; Checks with what failed; Files with the patch, line threads under their lines and Wrap long lines; Commits; Comments with every review thread.
- Writes, each previewed and confirmed, refused when the head moved since the preview and offered only where the forge can: comment; reply and resolve or unresolve a thread; comment on a line or a Shift-selected range (GitLab and Gitea anchor a range on its last line); a review as comment, approve or request changes with pending line comments; request a reviewer; rename and edit the description; ready for review or draft; close or reopen; merge, squash or rebase by the forge's methods. Not offered: request-changes reviews on GitLab (its API has none); line comments, patches and the draft state on Azure DevOps (its API returns no line diff and does not change the draft state); rebase-merge on GitLab.
- **Fix with agent** on a review thread or a failed check, or **Fix all with agent**: the prompt goes to the newest thread on the pull request's branch in a project whose remote is the repository, on any forge, else a new thread starts there.
- Safety of writes: a preview is checked against the head the page showed (line numbers come from that diff); pull request and issue previews cannot be confirmed through each other; a review GitHub would refuse (changes without a reason, an empty comment review) or one blocked by your pending GitHub review is refused at the preview; a review sent as several requests that stops halfway is reported as partly sent (OUTCOME_PARTIAL) instead of inviting a duplicate.
- Agents get forge text fenced (title, check summary, comments) or flattened (paths, branches, names), with a note that fenced text is data. A fork's pull request never borrows a base-repository thread on a same-named branch; a new thread starts in a managed worktree from the pull request's head branch rather than in the project's own checkout.
- Reads are retried up to twice after a rate limit or a 5xx, as the forge asks when that is a few seconds (live check on gitlab.com); a lasting limit reads PROVIDER_RATE_LIMITED. An issue whose comments cannot be read still opens.
- **Issues** open from the Issues section of GitHub, GitLab and Gitea repositories, with comments, close or reopen, and **New issue**.
- Pull request detail, files, patch rows, review rules and agent prompts are ported from bb-github-pr-dashboard (MIT) with their tests.

## 0.6.0 — 2026-11-27

- **My PRs**: one page for every connected GitHub, GitLab, Gitea and Azure DevOps account, with Open, Review requested, Reviewed, Assigned, Merged and Closed tabs and their counts (a tab total only when every account can count it). Rows are grouped by account and repository, newest first, and lead with what blocks each pull request: draft, stacked on another one, merge conflicts, failing CI with the number of checks, CI running, changes requested, unresolved comments, awaiting review, and each forge's own reasons (GitLab's "Needs rebase", Azure's "Waiting for author"); a stripe shows the worst one. Reviewed marks a review the author pushed past. Search by every word, fold or hide a repository per tab, j/k and Enter, / to search. An account that fails shows its error while the others load. List, blocker, check, stack, search and watcher logic is ported from bb-github-pr-dashboard (MIT).
- Per forge: GitHub reads GraphQL search (GitHub Enterprise at /api/graphql); GitLab its own scopes, with Reviewed meaning merge requests you review and approved (GitLab has no reviewed-by filter) and blockers from the detailed merge status; Gitea the cross-repository search, adding branches, conflicts, size and head status for open tabs; Azure the projects of the organization (the first 30), split by your vote, with no Assigned tab and no CI state (build policies are not read; the tab says so), and a total only when no page was full.
- Alerts: a background check, every 5 minutes by default and not more often than every 2, alerts when CI starts failing on one of your open pull requests (GitHub, GitLab, Gitea) or someone comments or reviews (GitHub); the first check of an account only records where things stand. Alerts appear as toasts, in a New since you last looked list and as a count on **Мои PR**, and go out through Push notifications when it is installed. Settings choose what alerts and how.
- GitLab CI on gitlab.com (live check): the job trace drops the runner's stream prefixes (01O, 00O, 01E+), so the error is found again, including an ERROR line without a colon; a job of a stage the pipeline has not reached yet reads Waiting for an earlier stage, not Queued.
- Links from forges are kept only over https on the account's own server, for GitHub too; a slower answer for a tab left behind no longer replaces the current one; toasts close on their own or with ×.
- The connections list names GitLab accounts.

## 0.5.0 — 2026-11-27

- **GitLab** (gitlab.com and self-managed, including a non-standard port): connect an account with a personal access token; the wizard offers GitLab self-managed for other servers. Member projects in the catalog, nested groups included.
- GitLab merge requests: list, details with the diff, discussion without system notes and the head pipeline; create, comment, request a reviewer (a server that keeps one reviewer reports it), reopen, and merge pinned to the reviewed head. A server older than GitLab 15.7 shows the diff as unsupported. A merge request from a fork is marked as such.
- GitLab CI/CD in the Actions tab: pipelines with All, Active and Failed filters; jobs named by stage; the job trace while the job runs, opened at the job's own `ERROR:` line rather than the runner's closing "Job failed" line, with section markers and colours removed; Run pipeline with the variables `.gitlab-ci.yml` describes (`description` and `options`, after an optional `spec:` header); retry failed jobs and cancel, each after confirmation; GitLab has no re-run of all jobs, and the tab says so instead of starting a new pipeline on another commit. A pipeline stopped at a manual job is shown as stopped, not queued. A failed job states GitLab's failure reason; large pipelines and variable lists are read page by page. A CI configuration kept in another project gives no form; the pipeline still runs with its defaults.
- GitLab issues with labels, and CI/CD variables by name, type, protection, masking and environment. Variable values are never read out; without the Maintainer role the tab says so.
- The test stand serves one run; reusing a stand is refused, as its tokens stay bound to the previous run's servers.

## 0.4.0 — 2026-11-27

- **History** tab: the commit graph over all branches, tags and remotes with labels for HEAD, branches and tags; uncommitted changes on top; a commit's files and patches (merges against their first parent); older commits on demand; refreshes when refs or the working tree change. Git runs read-only on the copy's own host. The lane layout and Git output parsing come from plugins/git-history (MIT).
- CI logs open at the meaningful error rather than the runner's closing "Process completed with exit code" line, and a failed GitHub job shows its annotations with file and line; agents get them too.
- The Active filter also catches a run that has just started before GitHub's filtered list shows it, and a queued run says how long it has waited ("Queued for N min"), for example a re-run GitHub keeps in its queue.

## 0.3.0 — 2026-11-27

- **CI/CD** in the repository's Actions tab for GitHub Actions, Gitea Actions and Azure Pipelines: runs with All, Active and Failed filters; a run with its jobs and steps; the job log opened at the error line (polled while Gitea and Azure stream it; GitHub publishes it when the job ends); re-run failed or all jobs and cancel through a confirmation; Run workflow with the inputs its `workflow_dispatch` declares (Azure runs with its defaults); Ask agent opens one investigation thread per run attempt on the working copy; Send to threads and failure notifications deliver the error excerpt as fenced, untrusted text. A job that never started shows the forge's own explanation. Operations an older Gitea lacks are reported as unsupported.
- A server with a configured account is recognised as that account's forge without probing.
- The panel header reads **Makosh Git**.
- CI hand-off safety: runs go only to threads of the working copy's own project; every forge-supplied name, branch, link and log line reaches an agent inside one fenced, size-bounded untrusted block; forge links are kept only over https on the forge's own origin; a confirmed write is refused if the copy was linked to another repository after its preview; failure notifications are remembered only once delivered, and a retried Azure build that fails again is a new failure.
- The projects scan arranges repositories as a tree: a repository inside another project's folder is listed under that project instead of as a top-level project. The preview counts top-level and nested projects separately and returns the tree.
- Fixed (present since 0.1.0): staging through the plugin copied the Git index with a fresh timestamp. A same-size edit made in the same second as the last index write then looked unchanged: staging that file as a hunk failed with `INVALID_PATH`, and staging any other file wrote an index in which the edit stayed hidden from `git status`, `git diff` and `git commit -a` until the file changed again. Index copies now keep their modification time.

## 0.2.0 — 2026-11-27

- Display name is now **Makosh Git**. Plugin id, CLI and agent tool names are unchanged.
- Working copies detect their forge from `origin`: SSH aliases through `ssh -G` (host name only), well-known forges by name, other servers through a cached, credential-free version probe.
- The account is picked automatically (GitHub: owner, organization member, then visibility; other forges: by server) and the repository is linked; an ambiguous choice is asked in the repository panel.
- SSH and HTTPS remotes of one repository now match for CI/CD, issues and variables.
- GitLab is recognised as a forge kind (a server named `gitlab.*` that does not answer is shown as GitLab, unreachable); its API arrives in a later release.
- **Projects folder** and exclusion settings with a preview of the projects found and the folders skipped.
- Accounts saved by 0.1.0, their Vault references and repository links are read unchanged.

## 0.1.0

- First release.
