Makosh GitWand brings the GitWand Git client into BB: the same interface and
the same Rust backend as the GitWand desktop app, opened next to a thread.

## What you get

- A **GitWand** tab in each thread, opened from the thread's header or the
  command palette. It opens the thread's working tree: status, staging,
  commits, history and graph, branches, merges with conflict resolution,
  stash, tags, worktrees and submodules.
- GitWand's integrated terminal, running in the repository.
- A **Repositories** dialog inside GitWand (the **+** menu next to the tabs,
  or the start screen): every git repository under your project folders and
  every repository your `gh` accounts (your own and your organizations') and
  your `glab` GitLab memberships can see, with search. Local ones open; a
  remote one that is already cloned opens its clone; the others open
  GitWand's clone dialog with the URL filled in, and you choose the folder.
  The remote list is cached and fetched again only with **Refresh**.
- In the same dialog, repositories with a local clone show their branch,
  ahead/behind and changes, loaded as they scroll into view. **Fetch** and
  **Pull** run on the selected repositories or, without a selection, on the
  ones shown; Pull asks first and lists them. **Pull requests** lists the
  open pull requests of the selected repositories.
- A **GitWand** page in the sidebar for any local repository.
- A settings section with the runtime version, the backend state, whether
  `git`, `gh` and `glab` are on the PATH, and Restart, Roll back and Check
  for updates, and an Install button when the update channel offers a build.

Forge sign-in (GitHub without the `gh` CLI, Bitbucket, Azure DevOps, Gitea)
keeps credentials in the macOS Keychain, as the desktop app does. GitLab works
through `glab`.

Settings **Project folders** (default `~/projects`), **Search depth** (how
deep a `.git` may sit, like `find -maxdepth`, default 4) and **GitLab hosts**
(default `gitlab.com`) choose what the Repositories dialog lists. Forge
tokens stay with `gh` and `glab`; the plugin passes each account's token only
to that account's own `gh` call and never shows or logs it.

## Requirements

GitWand runs from a runtime archive: the `gitwand-bridge` backend and the
built interface. Runtimes come from a signed update channel (**Update channel
URL** and **Update signing key** in the plugin settings) or, for development,
from **Development runtime directory** pointing at a runtime built with the
plugin's `scripts/build-runtime.ts`. Runtimes are published for macOS
(Apple silicon and Intel) and Linux x64. BB must be open on this computer
(`http://127.0.0.1` or `http://localhost`).

GitWand is made by Laurent Guitton and published under the MIT license:
https://github.com/devlint/GitWand
