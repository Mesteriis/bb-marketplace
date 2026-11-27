## Git in BB

Open Git from BB navigation and choose a project and repository in the tree. Attach working copies from the project’s sources, ready environments or a trusted path on a selected machine. Inspect staged, unstaged and untracked changes, stage individual text hunks, commit the index, compare commits, and manage branches and linked worktrees. Merge or rebase after a preview of the conflicts, then resolve them in an editor.

## Forge and account detection

Each working copy is matched to its forge from its `origin` remote (SSH aliases through `ssh -G`). Well-known forges are recognised by name, other servers once through their public version endpoint, asked anonymously from the copy's host. The account is chosen automatically by owner, organization or server; when two fit equally, the repository panel asks.

## Projects folder and catalog

The **Projects folder** setting (default `~/projects`) and its exclusion list define the projects: a folder with `.git`; worktrees and submodules belong to their parent; hidden folders, `node_modules`, `vendor` and `references` are skipped. **Каталог** lists them beside every account's repositories, marks what is cloned, clones into a category, and fetches or pulls chosen projects.

## History

The History tab of a working copy, also a **Git History** tab in a thread and an optional thread header button, draws the commit graph over all branches, tags and remotes grouped by day, lists uncommitted changes on top, and opens a commit's files and patches. Find in loaded commits by subject, hash, author or ref. It reads Git on the copy's own host without changing anything.

## Line review

**Review**, in Git or a thread's tab, shows a working copy's diff. Comment on lines, files or the whole diff, suggest and apply changes, and send threads to the copy's agent, which answers each with `bb git-dashboard review`. AI runs review, summarize, explain or fix in their own threads; @reviewer asks the reviewer. It follows the copy, keeps drafts, marks Viewed, reverts and finds.

## My PRs

**Мои PR** lists the pull requests of every connected GitHub, GitLab, Gitea and Azure DevOps account by tab, each led by what blocks it, with tiles on Open. Search (on GitHub the whole merged or closed history), fold or hide repositories, j/k moves. Alerts on failing CI and new comments come as toasts, a count and Push notifications.

## Pull requests and issues

A pull request opens with its Markdown discussion and Jira links, checks, files (list, side by side, Shiki highlighting in BB's code theme) with line threads, and commits. Comment, reply, resolve, delete your comments, review, request reviewers, edit, close and merge, each confirmed first, where the forge allows. Link it to a thread, ask or explain it; Fix with agent hands a thread or failed check to an agent; its answers wait as drafts. github.com PR links open here. Issues open, close, reopen and are created.

## CI/CD

The Actions tab and a thread's **CI/CD** tab list GitHub Actions, Gitea Actions, GitLab CI/CD or Azure Pipelines runs with tiles and filters, open a failed job's log at its error line, and re-run, cancel or run a workflow after a confirmation. **CI/CD** in Git sums up every linked repository. Ask agent, Send to threads and `bb git-dashboard ci` pass runs to agents as fenced, untrusted text.

## Remote repositories

Connect GitHub, GitLab, Azure Repos or Gitea accounts. Repository tabs show Code, CI/CD, issues and variables where supported. Secret and variable values stay in the provider. Review clone, fetch, push and PR actions before confirming them. HTTPS Git uses the account’s credential in the host’s macOS Keychain. API tokens go to Makosh Credential Vault when enabled, with a fallback copy in BB’s secret settings.

The thread’s Git panel resolves its registered working copy. Grant agents read or local write access and review their publication and worktree requests in BB. Pinned tabs keep their worktree or pull request.
