# Changelog

## 0.7.0 — 2026-11-27

- **Pull request page** for GitHub, GitLab, Gitea and Azure DevOps, opened from My PRs (click or Enter; ↗ still opens the forge; [ and ] step through the list): header with state, branches, size, blockers, reviewers and labels; Overview with the description and discussion; Checks with what failed; Files with the patch, line threads under their lines and Wrap long lines; Commits; Comments with every review thread.
- Writes, each previewed and confirmed, refused when the head moved since the preview and offered only where the forge can: comment; reply and resolve or unresolve a thread; comment on a line or a Shift-selected range (GitLab and Gitea anchor a range on its last line); a review as comment, approve or request changes with pending line comments; request a reviewer; rename and edit the description; ready for review or draft; close or reopen; merge, squash or rebase by the forge's methods. Not offered: request-changes reviews on GitLab (its API has none); line comments, patches and the draft state on Azure DevOps (its API returns no line diff and does not change the draft state); rebase-merge on GitLab.
- **Fix with agent** on a review thread or a failed check, or **Fix all with agent**: the prompt goes to the newest thread on the pull request's branch in a project whose remote is the repository, on any forge, else a new thread starts there.
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
