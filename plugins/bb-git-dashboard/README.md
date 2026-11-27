# Makosh Git

Plugin ID and package name are both `bb-git-dashboard`; the display name is **Makosh Git**. The navigation entry is **Git**. Makosh Credential Vault is an optional integration.

The Git sidebar groups projects by the parent directory of their default BB source. Search by project or folder name above the independently scrolling list. Projects without a source appear under «Без папки».

## Build and install

From this directory, with Node 22.18+ and BB 0.50.1+:

```sh
npm ci
npm run check
npm run build
```

For a prebuilt `bb-git-dashboard-0.2.0.tgz`, unpack it into a new directory, enter `package/` and run `npm install --omit=dev --ignore-scripts`. A BB path install still resolves the host entry's Zod dependency from the package directory.

Run `bb plugin install "$PWD" --yes` from a **test profile** to install the prepared directory. Check for `bb-git-dashboard` in `bb plugin list --json`, then open **Git** in BB Web. The acceptance artifacts include an isolated profile launcher and browser scenario for BB 0.50.1. Installing or removing a plugin in an owner's BB profile requires their go-ahead.

## Project workspace

Open **Git** for the global catalog. Filter by project in BB’s native left sidebar, or search the catalog by repository, branch, host or path. Use **+ Подключить копию** to choose a project source or environment. Confirming it opens the project catalog with its worktrees. Choose the manual path option for a different working copy or local bare source. Each registered repository lists its main and linked working trees. A discovered but unregistered copy can be attached before inspecting its changes. **Code** shows the repository’s attached worktrees, their branches and status. Select a copy to see its changes, staging area, diff, history and branches. Worktrees that share one Git administration directory on the same host appear under one repository.

Use **+ Worktree** to select a project source or ready environment, or attach an absolute trusted path on the selected host. Previously attached copies are matched to BB projects by exact host and path. Copies without an unambiguous project appear under **Unassigned** and can be attached from the intended project. Linked worktrees can also be opened from **Code → Worktrees**. To clone from a local bare repository, supply the bare source and a new destination whose parent already exists.

**Actions**, **Issues** and **Variables** read data for the selected repository. The panel detects the forge and account from the working copy’s `origin` and connects the repository on its own; when the choice is ambiguous it asks for the account. A provider account and repository can still be chosen by hand from the connection form. The plugin verifies that the provider repository is the working copy’s `origin`, comparing SSH and HTTPS forms of the same repository. HTTPS fetch and push still require the HTTPS `origin` itself. GitHub and supported Gitea instances expose CI/CD runs, issues, repository variables and secret names. GitLab exposes pipelines, issues and CI/CD variables by name, type, protection, masking and environment, never their values; reading variables needs the Maintainer role. Azure Repos exposes builds filtered by the Git repository. Azure Boards and variable groups are project-scoped. The views display up to 30 entries per list. Secret values are never returned. Run and issue links open the provider’s own views when the provider supplies a link on its configured origin.

**History** draws the commit graph of a working copy, also as the **Git History** tab of a thread (New tab, or the thread header button set by `historyHeaderShortcut`). `historyGraph` off lists commits without lanes. Find in loaded commits searches only what is loaded; Load older commits extends it. A patch is read up to 1.5 MB and cut at a whole line beyond that.

**CI/CD** in the Git header sums up the latest runs of every linked repository, one copy per repository. A thread's **CI/CD** tab shows the thread's working copy and adds **Send to this thread**. `ciFallbackProject` is the project whose threads investigate and receive runs of copies outside any BB project; such a thread starts in the project's default environment, not in the copy. `ciAnalysisModel` sets the model of new investigation threads. Send to threads remembers its last five recipients per copy in the browser.

`bb git-dashboard ci list|show|workflows|run|rerun|cancel` works from a BB thread on that thread's working copy: reads need the Read grant, and writes need Stage and commit plus the owner's approval of the previewed write in the thread. Workflow inputs are checked against the workflow's declared ones before anyone is asked.

## Line review

**Review** reads a working copy's diff on its own host: `uncommitted` (HEAD against the working tree, untracked files included), `staged`, `unstaged`, `branch` (commits since the base's merge base), `all` (the merge base against the working tree), `commit` (against its first parent) or a `range` (`a..b` from their merge base, `a...b` from where a merged branch forked). The base defaults to `origin/HEAD`, then `main`, then `master`. Comments are kept in the plugin's SQLite database, one review per copy and view. Send to agent writes one message into a thread whose environment is the copy; the agent may answer only the comment threads whose last send went to its own thread (`bb git-dashboard review …` with the calling thread, or the `git_review_*` tools), and a thread it leaves unanswered at the end of a turn that began after the send shows "No reply". Apply suggestion reads the file (a regular text file up to 1 MB inside the copy, no links) and writes it back through a temporary file only if its SHA-256 is still the one read.

## My PRs

**Мои PR** in the Git header opens the pull requests of every connected account. GitHub uses GraphQL search; GitLab the global merge request list by scope (Reviewed lists merge requests you review and approved: GitLab has no reviewed-by filter); Gitea `/repos/issues/search` plus each open pull request's details and head status; Azure the pull requests of each project of the organization (the first 30). A tab shows a total only when every account that answered can count it. Alerts come from a background check, configured in the plugin settings `inboxNotifyCi`, `inboxNotifyComments`, `inboxToasts`, `inboxDesktop`, `inboxBadge`, `inboxIgnore` and `inboxEveryMinutes` (2–60, default 5); the check keeps one baseline per account in plugin storage and stores the last 50 alerts. Push notifications are sent through the `push-notifications` plugin when it is installed.

## Pull requests and issues

A pull request page is addressed as `pr/<account>/<number>/<repository path>` in the Git panel and opens from My PRs. It reads GitHub through GraphQL (detail) and REST (files), GitLab through the merge request, its discussions, approvals, diffs and commits, Gitea through the pull request, its issue comments, reviews and review comments, statuses, files and `.diff`, and Azure DevOps through the pull request, its threads, statuses, commits and latest iteration's changes. Writes go through a preview that is confirmed once within five minutes and refused when the head moved: GitHub line comments and reviews are pinned to the head commit; GitLab line comments are diff discussions anchored with the merge request's diff refs, approvals carry the head sha and the draft state is the title's `Draft:` prefix; Gitea line comments and reviews use the reviews API with the head commit and the draft state is the title's `WIP:` prefix; Azure approve and reject are reviewer votes and a merge is a completion that Azure finishes later. Fix with agent finds projects whose git remote is the repository and sends the prompt to the newest open thread on the pull request's branch, else starts a thread in the first such project's default environment. Issues are read and written for GitHub, GitLab and Gitea; Azure Boards are outside the repository. Only the pull request or issue itself must be readable: a failed part (discussions, reviews, commits, statuses, your own user) is named on the page. A read refused by a rate limit that names its reset within two minutes is tried again by the page after that many seconds.

## Accounts and transport

In **Git → Connections → Add connection**, enter a Git server address or repository URL. The wizard recognizes public GitHub, GitLab and Azure DevOps URLs and extracts the Azure organization when it is present. Choose the provider for a self-hosted server, including GitLab self-managed. The wizard verifies the token by reading provider metadata, then lists the repositories on the first page before you save. The Azure wizard asks for the Git username used by the transport. The token is persisted only after you select **Save connection**. With Makosh Credential Vault enabled, Git Dashboard writes to Vault and keeps a fallback copy in its built-in secret settings.

For manual configuration, the plugin’s BB settings accept two JSON values. Account declarations are ordinary metadata. API tokens belong in **Provider API tokens by account ID**, a BB secret setting.

```json
[
  {"id":"gh-a","kind":"github","label":"GitHub A","origin":"https://api.github.com","username":"alice"},
  {"id":"azure-test","kind":"azure","label":"Azure Test","origin":"https://dev.azure.com","organization":"example-org","username":"tester"},
  {"id":"gitea-test","kind":"gitea","label":"Gitea Test","origin":"https://git.example.invalid","username":"tester"},
  {"id":"gitlab-test","kind":"gitlab","label":"GitLab Test","origin":"https://gitlab.example.invalid:8443","username":"tester"}
]
```

The token value is a JSON object keyed by these IDs. When Vault is enabled, the dashboard migrates pre-existing tokens on load or on first use of an account. It inserts only when the Vault reference is absent and verifies the encrypted record by reading it back. The record is bound to the account ID, provider, API origin, organization and username. When Vault is missing or disabled, the dashboard uses the copy in BB’s secret settings. An enabled but locked or failing Vault reports an error. If a previously verified record disappears, the dashboard does not recreate it from the fallback copy. Use a distinct ID for each account and grant only the provider permissions it needs. Use the canonical HTTPS instance origin. Azure targets Azure DevOps Services and takes the organization separately. Gitea targets the v1 API at the origin root, GitLab the v4 API at the origin root. A GitLab token needs the `read_api` scope to read and `api` for merge request and pipeline actions. Repository, account and origin selected for an operation are displayed before confirmation.

Git transport credentials are separate from API tokens. Provision the account's Git credential on the selected execution host using the macOS Git OS Keychain helper. The helper entry must be scoped by HTTPS protocol, host, exact repository path and username. HTTPS Git transport currently supports macOS hosts with this helper. Configure the account using the username that uniquely identifies the corresponding keychain record. A repository created from **New project** is pushed the same way: once the forge has made it with the account, the plugin saves the account's token in the Keychain for that repository's exact address and the account's username (`git credential approve` with the host's own `git`, the token on stdin only, so the push finds it and macOS does not ask for access), then pushes main. The preview says so before confirming, and the activity log records the entry without its value. The entry is read back through the same `git` and helper; if the Keychain did not keep it, main is not pushed, the repository stays empty with origin set, and the answer says why; nothing is saved for a repository whose creation was not confirmed. A self-hosted forge on a private certificate authority: set `MAKOSH_GIT_CA_FILE` for BB to its CA bundle, which HTTPS Git then verifies against instead of the system one. Commit author configuration is separate from both credentials. Existing local `user.name` and `user.email` are used when present. The dashboard can supply an author for a single commit.

To disable an account, remove its declaration and secret map entry in BB and delete the matching repository-scoped Git credential from that host. Configuration changes invalidate pending publication previews. Refresh the catalog after changing the account's access. Previous operations retain non-secret audit metadata.

## Boundaries

- Choose repositories whose local Git configuration you control. Attach verifies a canonical root and ties the registration to the filesystem identities of the worktree and Git administration directories. Git rejects nonstandard config keys, uses an isolated environment, and disables hooks, external filters, alternate network schemes, redirects, and submodule recursion. Same-user processes with shell access can still modify Git or the filesystem independently.
- Local index edits use Git's index lock. Commits use a copied index and compare-and-swap the expected ref. Merge, rebase and cherry-pick sequences are finished outside the dashboard. The plugin does not expose reset, clean, force push or policy bypass. Git status and patch output have bounded UTF-8 buffers.
- Agent access defaults to revoked and is tied to a specific thread and registered copy. Publication and new agent work each require a separate confirmation in BB. Changes sent through the app or an agent tool use the same backend. A closed tab, disabled plugin, or unmanaged environment removal leaves checked-out files in place.
- Azure can return an asynchronous completion. The activity view distinguishes that from a completed merge. Azure supplies changed paths in its REST PR API. For a textual comparison, select a working copy with both commit objects. The initial Azure adapter accepts mutations of same-repository PRs. GitHub and Gitea return provider diff and check details as available under the selected credentials.
- Unknown outcomes are recorded without a retry. Inspect the remote branch or PR before choosing a new action. Publication confirmations are short-lived and expire on server reload. The durable journal contains the outcome, actor and non-secret destination and revisions.
- BB's native tab API supplies context and pinned tabs. A Chertog tile integration is outside this package. The provider credential flows, agent session, parallel live identity test and review-agent isolation need a live test environment for acceptance.

Catalog discovery accepts BB branch ownership metadata, GitHub CLI remote metadata, credential helper declarations and per-worktree configuration. It checks configuration keys in both repository and worktree scopes. Only identity lookup and worktree enumeration use this policy. File status, changes and transport still require the stricter operation policy.

The sidebar folds single-child directory chains and lets you expand nested folders. Open the project’s ⋯ button to inspect each BB source and its host, hide the project from Git Workspace, unlink a source in BB, or move its local Git folder to the macOS Trash. Hidden projects can be restored at the bottom of the list. Moving a folder requires its full path and leaves the BB source registration available to unlink. Repositories with linked worktrees must be handled separately.
