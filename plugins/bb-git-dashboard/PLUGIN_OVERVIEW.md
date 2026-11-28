## Git in BB

Git opens on an overview of what needs you, as a list or a board, by category. Projects is one table of the attached copies with views, fetch and pull. Attach copies from project sources, environments or a trusted path. Stage files and hunks, commit, push after a dialog, and manage branches and worktrees. Merge or rebase after a preview of the conflicts, then resolve them in an editor.

## Forge and account detection

Each working copy is matched to its forge from its `origin` remote (SSH aliases through `ssh -G`). Well-known forges are recognised by name, other servers once through their public version endpoint, asked anonymously from the copy's host. The account is chosen automatically by owner, organization or server; when two fit equally, the repository panel asks.

## Projects folder and catalog

The **Projects folder** setting (default `~/projects`) and its exclusion list define the projects: a folder with `.git`; worktrees and submodules belong to their parent; hidden folders, `node_modules`, `vendor` and `references` are skipped. **Каталог** lists them beside every account's repositories, marks what is cloned, clones into a category, fetches or pulls chosen projects, and makes a **New project** from a scaffold (Python, Go, BB plugin or your own) and its private repository.

## History

The History tab of a working copy, also a **Git History** tab in a thread and an optional thread header button, draws the commit graph over all branches, tags and remotes grouped by day, lists uncommitted changes on top, and opens a commit's files and patches.

## Line review

**Review**, in Git or a thread's tab, shows a working copy's diff. Comment on lines, files or the whole diff, suggest and apply changes, and send threads to the copy's agent, which answers each with `bb git-dashboard review`. AI runs review, summarize, explain or fix in their own threads; @reviewer asks the reviewer. It follows the copy, keeps drafts, marks Viewed, reverts and finds.

## My PRs

**My PRs** lists the pull requests of every connected GitHub, GitLab, Gitea and Azure DevOps account by tab and repository, each with its states in words, and chips that count and filter what blocks them. Search (on GitHub the whole merged or closed history), fold or hide repositories, j/k moves. Alerts on failing CI and new comments come as toasts, a count and Push notifications.

## Pull requests and issues

A pull request opens with its Markdown discussion and Jira links, checks, files (list, side by side, Shiki highlighting in BB's code theme) with line threads, and commits. Comment, reply, resolve, delete your comments, review, request reviewers, edit, close and merge, each confirmed first, where the forge allows. Link it to a thread, ask or explain it; Fix with agent hands a thread or failed check to an agent; its answers wait as drafts. github.com PR links open here. Issues open, close, reopen and are created.

## CI/CD

A copy's and a thread's **CI/CD** tab list GitHub Actions, Gitea Actions, GitLab CI/CD or Azure Pipelines runs with filters; a run opens as a page at its failed job's error line, to re-run, cancel or run a workflow after a confirmation. **Templates** write a pipeline for the copy's stack to a new branch with a pull request. **CI/CD** in Git sums up every linked repository. Ask agent, Send to threads and `bb git-dashboard ci` pass runs to agents as fenced, untrusted text.

## Remote repositories

Connect GitHub, GitLab, Azure Repos or Gitea accounts. Repository tabs show Code, CI/CD, issues and variables where supported. Secret and variable values stay in the provider. Review clone, fetch, push and PR actions before confirming them. HTTPS Git uses the account’s macOS Keychain entry; New project adds it. API tokens go to Makosh Credential Vault when enabled, with a fallback copy in BB’s secret settings.

Grant agents read or local write access and review their publication and worktree requests in BB. Pinned tabs keep their target.
