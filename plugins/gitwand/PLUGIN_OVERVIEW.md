Makosh GitWand brings the GitWand Git client into BB: the same interface and
the same Rust backend as the GitWand desktop app, opened next to a thread.

## What you get

- A **GitWand** tab in each thread, opened from the thread's header or the
  command palette. It opens the thread's working tree: status, staging,
  commits, history and graph, branches, merges with conflict resolution,
  stash, tags, worktrees and submodules.
- GitWand's integrated terminal, running in the repository.
- A **GitWand** page in the sidebar for any local repository.
- A settings section with the runtime version, the backend state, whether
  `git`, `gh` and `glab` are on the PATH, and Restart, Roll back and Check
  for updates, and an Install button when the update channel offers a build.

Forge sign-in (GitHub without the `gh` CLI, Bitbucket, Azure DevOps, Gitea)
keeps credentials in the macOS Keychain, as the desktop app does. GitLab works
through `glab`.

## Requirements

GitWand runs from a runtime archive: the `gitwand-bridge` backend and the
built interface. Runtimes come from a signed update channel (**Update channel
URL** and **Update signing key** in the plugin settings) or, for development,
from **Development runtime directory** pointing at a runtime built with the
plugin's `scripts/build-runtime.ts`. No public channel is published yet. macOS on Apple silicon only for
now. BB must be open on this computer (`http://127.0.0.1` or
`http://localhost`).

GitWand is made by Laurent Guitton and published under the MIT license:
https://github.com/devlint/GitWand
