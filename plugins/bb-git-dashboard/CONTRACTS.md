# BB contracts used by BB Git Dashboard

The target installation is BB 0.50.1, Plugin SDK 0.6.157, Git 2.55.0. The matching upstream BB tag is `desktop-v0.50.1` at `a08e116566d1785bc04578a866df8a0359157dd4`. The module paths below are relative to that BB revision. The public package's bundled declarations, rather than private imports, define the build contract.

| Surface | SDK symbol and status | Evidence |
| --- | --- | --- |
| Standalone navigation | `packages/plugin-sdk/src/app-contract.ts`, `PluginSlots.navPanel`, public | Clean BB Web opened `/plugins/bb-git-dashboard/git` without a thread. |
| Thread panel and pinned views | Same source, `PluginSlots.experimental_tab`, `ExperimentalPanelController.openTab`, experimental | Pinned worktree opened in browser QA. PR pinning and context-bound thread controls compile. |
| Agent tools and approvals | `packages/plugin-sdk/src/backend-contract.ts`, `PluginAgents.registerTool`, `PluginUi.requestInput`, public; `PluginSlots.pendingInteraction` in app contract | Tool and interaction registrations load. The clean profile's unsigned Codex provider returned HTTP 401 before agent execution. |
| Selected host | `packages/plugin-sdk/src/host-contract.ts`, `experimental_defineHostEntry`; backend `PluginHosts.experimental_client`; transport `apps/server/src/services/plugins/plugin-host-rpc.ts`, experimental | Separate host bundle built; live BB routed attach, diff, stage, commit, fetch and push to the test daemon on the selected host. No alternate host is chosen for errors. |
| Existing worktree | `packages/sdk/src/areas/threads.ts`, `ThreadsArea.spawn`; SDK `CreateThreadRequest.environment` with `workspace.type: unmanaged`, public | CLI in clean profile resolved an existing linked worktree to its canonical path and preserved the marker through thread archive, thread delete and environment delete. Agent file read requires a signed-in test provider. |
| Secrets | `packages/plugin-sdk/src/backend-contract.ts`, `PluginSettings.define` with `secret: true`, public | Live settings schema loads. Tests cover API credential selection and sanitization against an HTTP double. Git credentials are resolved independently by Git on macOS; a real Keychain and provider-identity scenario remains unverified. |
| State and reload | Same backend source, `PluginStorage.kv`, `PluginRealtime.publish`, public; app SDK `useRealtime` | Local and publication journal state is persisted. Stopped in-flight requests surface a durable unknown outcome, and process-local previews expire on reload. A cold-reload browser scenario with a pending provider write remains unverified. |

The compact views use BB's own tab registry. Registering this plugin in a Chertog tile would require a supported integration beyond these slots. The standalone dashboard and thread tab use only BB itself.

Provider references: [GitHub REST pull requests](https://docs.github.com/en/rest/pulls/pulls), [GitHub review requests](https://docs.github.com/en/rest/pulls/review-requests), [Azure Git REST 7.1](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/), [Gitea 1.24 API](https://docs.gitea.com/api/1.24/). Local commands were exercised against system Git. Contents from all providers and local repositories are treated as data.
