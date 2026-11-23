# BB Git Dashboard

Plugin ID and package name are both `bb-git-dashboard`. The navigation entry is **Git**. Makosh Credential Vault is an optional integration.

The Git sidebar groups projects by the parent directory of their default BB source. Search by project or folder name above the independently scrolling list. Projects without a source appear under «Без папки».

## Build and install

From this directory, with Node 22.18+ and BB 0.50.1+:

```sh
npm ci
npm run check
npm run build
```

For a prebuilt `bb-git-dashboard-0.1.0.tgz`, unpack it into a new directory, enter `package/` and run `npm install --omit=dev --ignore-scripts`. A BB path install still resolves the host entry's Zod dependency from the package directory.

Run `bb plugin install "$PWD" --yes` from a **test profile** to install the prepared directory. Check for `bb-git-dashboard` in `bb plugin list --json`, then open **Git** in BB Web. The acceptance artifacts include an isolated profile launcher and browser scenario for BB 0.50.1. Installing or removing a plugin in an owner's BB profile requires their go-ahead.

## Project workspace

Open **Git** for the global catalog. Filter by project in BB’s native left sidebar, or search the catalog by repository, branch, host or path. Use **+ Подключить копию** to choose a project source or environment. Confirming it opens the project catalog with its worktrees. Choose the manual path option for a different working copy or local bare source. Each registered repository lists its main and linked working trees. A discovered but unregistered copy can be attached before inspecting its changes. **Code** shows the repository’s attached worktrees, their branches and status. Select a copy to see its changes, staging area, diff, history and branches. Worktrees that share one Git administration directory on the same host appear under one repository.

Use **+ Worktree** to select a project source or ready environment, or attach an absolute trusted path on the selected host. Previously attached copies are matched to BB projects by exact host and path. Copies without an unambiguous project appear under **Unassigned** and can be attached from the intended project. Linked worktrees can also be opened from **Code → Worktrees**. To clone from a local bare repository, supply the bare source and a new destination whose parent already exists.

**Actions**, **Issues** and **Variables** read data for the selected repository. Choose a provider account and repository from the connection form. The plugin verifies that the provider clone URL matches the working copy’s HTTPS `origin`. GitHub and supported Gitea instances expose CI/CD runs, issues, repository variables and secret names. Azure Repos exposes builds filtered by the Git repository. Azure Boards and variable groups are project-scoped. The views display up to 30 entries per list. Secret values are never returned. Run and issue links open the provider’s own views when the provider supplies a link on its configured origin.

## Accounts and transport

In **Git → Connections → Add connection**, enter a Git server address or repository URL. The wizard recognizes public GitHub and Azure DevOps URLs and extracts the Azure organization when it is present. Choose the provider for a self-hosted server. The wizard verifies the token by reading provider metadata, then lists the repositories on the first page before you save. The Azure wizard asks for the Git username used by the transport. The token is persisted only after you select **Save connection**. With Makosh Credential Vault enabled, Git Dashboard writes to Vault and keeps a fallback copy in its built-in secret settings.

For manual configuration, the plugin’s BB settings accept two JSON values. Account declarations are ordinary metadata. API tokens belong in **Provider API tokens by account ID**, a BB secret setting.

```json
[
  {"id":"gh-a","kind":"github","label":"GitHub A","origin":"https://api.github.com","username":"alice"},
  {"id":"azure-test","kind":"azure","label":"Azure Test","origin":"https://dev.azure.com","organization":"example-org","username":"tester"},
  {"id":"gitea-test","kind":"gitea","label":"Gitea Test","origin":"https://git.example.invalid","username":"tester"}
]
```

The token value is a JSON object keyed by these IDs. When Vault is enabled, the dashboard migrates pre-existing tokens on load or on first use of an account. It inserts only when the Vault reference is absent and verifies the encrypted record by reading it back. The record is bound to the account ID, provider, API origin, organization and username. When Vault is missing or disabled, the dashboard uses the copy in BB’s secret settings. An enabled but locked or failing Vault reports an error. If a previously verified record disappears, the dashboard does not recreate it from the fallback copy. Use a distinct ID for each account and grant only the provider permissions it needs. Use the canonical HTTPS instance origin. Azure targets Azure DevOps Services and takes the organization separately. Gitea targets the v1 API at the origin root. Repository, account and origin selected for an operation are displayed before confirmation.

Git transport credentials are separate from API tokens. Provision the account's Git credential on the selected execution host using the macOS Git OS Keychain helper. The helper entry must be scoped by HTTPS protocol, host, exact repository path and username. HTTPS Git transport currently supports macOS hosts with this helper. Configure the account using the username that uniquely identifies the corresponding keychain record. Commit author configuration is separate from both credentials. Existing local `user.name` and `user.email` are used when present. The dashboard can supply an author for a single commit.

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
