Makosh GitWand brings the GitWand Git client into BB: the same interface and
the same Rust backend as the GitWand desktop app, opened next to a thread.

## Status

This is the package skeleton. It installs and starts, but shows nothing yet:
the GitWand runtime (the `gitwand-bridge` backend and the built interface),
the thread tab and the sidebar page come in the next steps.

## What it will do

- Open the thread's working tree in GitWand: status, staging, commits,
  history and graph, branches, merges with conflict resolution, stash, tags,
  worktrees and submodules.
- Run GitWand's integrated terminal.
- Keep forge credentials in the macOS Keychain, as the desktop app does, and
  work with GitHub (without the `gh` CLI), Bitbucket, Azure DevOps, Gitea and
  GitLab (through `glab`).
- Update the GitWand runtime from a signed channel, with a rollback button.

GitWand is made by Laurent Guitton and published under the MIT license:
https://github.com/devlint/GitWand
