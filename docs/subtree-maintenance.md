# Subtree maintenance

The public aggregate is `Mesteriis/bb-marketplace`. The local directory remains `bb-main`; its existing commits are ancestors of the aggregate. Each package remains independent, with its own dependencies and build commands. No root npm workspace is introduced.

`subtrees.json` records the original repository (`upstream` in its maintenance clone), original subdirectory and revision, maintained fork (`origin`), extracted branch and aggregate prefix. A GitHub fork is made per original repository. A monorepo fork can contain several `marketplace/<plugin-id>` branches, each extracted using `git subtree split --prefix=<original-directory> <revision>` and then patched with the local integration. The aggregate imports those branches with `git subtree add --squash`. This preserves the aggregate history and leaves the plugin's source history in its fork branch.

## Clone and attach remotes

```sh
git clone https://github.com/Mesteriis/bb-marketplace.git
cd bb-marketplace
node scripts/configure-subtree-remotes.mjs
bb marketplace add git:github.com/Mesteriis/bb-marketplace@main
```

The marketplace ID is `mesteriis`; for example `bb plugin install unified-inbox@mesteriis`. Adding a marketplace does not reinstall plugins or change their settings. Existing local installations continue using `bb-main/plugins/<id>`.

## Pull a maintained fork

Start with a clean checkout and read the package's README and license. For example:

```sh
git subtree pull --prefix=plugins/unified-inbox plugin-unified-inbox marketplace/unified-inbox --squash
```

Run that plugin's documented checks and build before committing or installing it. To contribute aggregate changes back to its fork:

```sh
git subtree push --prefix=plugins/unified-inbox plugin-unified-inbox marketplace/unified-inbox
```

## Update from the author

Use an independent maintenance clone. Its `origin` is the Mesteriis fork and `upstream` is the author repository from the registry. Fetch `upstream`, split the original subdirectory into a temporary branch (for a standalone repository use its original branch directly), and merge that into `marketplace/<plugin-id>`. Resolve conflicts while keeping the local integration, run its checks, push the maintained branch to `origin`, then pull the subtree into the aggregate. Do not pull an entire author monorepo into a plugin prefix.

## Publication boundary

Dependency directories, build output, credentials, databases, browser profiles and machine-specific configuration are not collection content. Inspect `git diff --cached` and scan for secrets before publishing. The root license covers original collection code, while imported packages retain their own licenses and notices.
