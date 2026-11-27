## Git in BB

Open Git from BB navigation and choose a project and repository in the tree. Attach working copies from the project’s sources, ready environments or a trusted path on a selected machine. Inspect staged, unstaged and untracked changes, stage individual text hunks, commit the index, compare commits, and manage branches and linked worktrees.

## Forge and account detection

Each working copy is matched to its forge from the `origin` remote. SSH host aliases are resolved with `ssh -G` on the copy's host, reading only the host name. GitHub, GitLab and Azure DevOps are recognised by name; other servers are identified once through their public version endpoint, asked from the working copy’s host without credentials (loopback and private addresses are never asked), and the answer is cached for 30 days (one day for unknown or unreachable servers). The account is chosen automatically: on GitHub the account that owns the repository, then a member of its organization, then the only account that can see it; on other forges the account of that server. When two accounts fit equally, the repository panel asks which one to use. GitLab is recognised but not yet connected.

## Projects folder

The **Projects folder** setting (default `~/projects` on the scanned host) and its exclusion list define which folders count as projects: a folder with a `.git` directory is a project, a repository inside another project's folder is listed under that project, a linked worktree or a submodule belongs to its parent, and hidden folders, `node_modules`, `vendor` and `references` are skipped. A preview counts the top-level and nested projects found, returns them as a tree and lists what was skipped and why.

## CI/CD

The Actions tab of a connected repository lists GitHub Actions, Gitea Actions or Azure Pipelines runs with All, Active and Failed filters. A run shows its jobs and steps and opens the failed job's log at its error line. Re-run failed or all jobs, cancel a run, or run a workflow with the inputs it declares; every change is shown for confirmation first. Ask agent opens an investigation thread on the working copy with the error excerpt, Send to threads passes the same excerpt to chosen threads, and failure notifications send each new failed run to them. Log text reaches agents as fenced, untrusted data.

## Remote repositories and pull requests

Connect GitHub, Azure Repos or Gitea accounts. Repository tabs show Code, CI/CD runs, issues and variables where supported by the selected provider. Secret values stay in the provider. Browse repositories and pull requests, read discussion and checks, and review clone, fetch, push and PR actions before confirming them. HTTPS Git transport uses the selected account’s credential in the execution host’s macOS Keychain. The connection wizard stores API tokens in Makosh Credential Vault when enabled and keeps a fallback copy in BB’s secret settings.

The thread’s Git panel resolves its registered working copy. Grant agents read or local write access and review their publication and worktree requests in BB. Pinned tabs keep their selected worktree or pull request when the selection in Git changes.
