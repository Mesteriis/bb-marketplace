# Changelog

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
