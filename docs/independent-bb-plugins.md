# Independent BB plugins

These packages retain their upstream IDs and branding and are not part of the Makosh application. No GitHub forks or releases were published.

## Requested plugins

All 28 requested IDs were running after installation. This verifies activation, not every UI workflow. The existing local Russian translation was retained.

| ID | Upstream |
| --- | --- |
| terminals | https://github.com/gpambrozio/bb-plugins |
| file-gateway | https://github.com/VKirill/bb-plugin-file-gateway |
| markdown-editor | https://github.com/danielbachhuber/bb-plugins |
| wikilinks | https://github.com/classicrob/obsidian-at-home |
| workspaces | https://github.com/wishcreator/bb-plugin-workspaces |
| dev-servers | https://github.com/darknoon/bb-plugins |
| dev-bar | https://github.com/danielbachhuber/bb-plugins |
| terminal-jobs | https://github.com/ryanbbrown/bb-plugin-terminal-jobs |
| launchd-jobs | https://github.com/gpambrozio/bb-plugins |
| git-history | https://github.com/yusuf8834/bb-git-history |
| plannotator | https://github.com/patleeman/bb-plugins |
| firstmate-crew | https://github.com/gpambrozio/bb-plugins |
| team | https://github.com/kirei4ik/bb-plugin-team |
| subagents | https://github.com/imyeskela/bb-plugin-subagents |
| ultragoal | https://github.com/braedonsaunders/bb-plugin-ultragoal |
| visual-workflows | https://github.com/dmitriikapustin/bb-plugins-by-kapustin |
| project-instructions | https://github.com/Hazihell/bb-plugin-project-instructions |
| skills-sync | https://github.com/Hazihell/bb-plugin-skills-sync |
| context-health | https://github.com/MacHatter1/bb-context-health |
| hooks | https://github.com/MacHatter1/bb-plugin-hooks |
| automation-groups | https://github.com/dmitriikapustin/bb-plugins-by-kapustin |
| plan-progress | https://github.com/mrsu-smirnov/bb-plugin-plan-progress |
| autorouter | https://github.com/jjcm/bb-plugin-autorouter |
| sql | https://github.com/yazydzhi/bb-plugin-sql |
| tokenomics | https://github.com/danielbachhuber/bb-plugins |
| model-pricing | https://github.com/gpambrozio/bb-plugins |
| notifications-pro | https://github.com/kr3t3n/bb-plugin-notifications-pro |
| ru | https://github.com/nick8cyber/bb-addons |

## Migration

All directly installed, non-catalog plugins now load from this repository. Existing BB Community catalog installations retain their managed sources and updates; copies of their installed source packages are present here. Existing disabled plugins remain disabled.

The monorepo shared dependencies needed by the Scott Sunarto packages are vendored inside their own plugin folders. No root npm workspace was added.

## Configuration and verification

- Obsidian at Home uses project **Obsidian Main**, whose source is the existing local vault. No notes or LiveSync configuration were changed. Vault path is stored in BB, not this repository.
- The mismatched Obsidian skill ID was corrected; 149 tests, typecheck and build passed. Vault suggestions and file listing were read successfully.
- Autorouter automatic routing is disabled. Skills Sync scheduled fetching is disabled. Hooks starts with no user-defined hooks.
- Tokenomics serializes an unknown limit size as null; the previously failing live RPC returned valid JSON after the fix.
- New packages were built and activated. Complete visual and functional testing of all packages has not been performed.

## Existing third-party packages

| ID | Original source | Current source |
| --- | --- | --- |
| account-pool-balanced | git:https://github.com/OXI-717/bb-plugins.git@semver:account-pool-balanced/:^0.4.1 | BB managed catalog |
| action-topbar | git:https://github.com/MateoCerquetella/bb-plugins.git@semver:action-topbar/:^0.1.5 | ./plugins/action-topbar |
| agent-icons | git:https://github.com/ponomr/bb-plugin-agent-icons.git@semver:^0.2.0 | BB managed catalog |
| agent-instructions | path:/Users/avm/projects/Personal/bb-smsunarto-plugins/plugins/agent-instructions | ./plugins/agent-instructions |
| agent-plugins | git:https://github.com/patleeman/bb-plugins.git@semver:agent-plugins/:^0.3.0 | BB managed catalog |
| agent-traces | git:https://github.com/charpeni/bb-plugins.git@semver:agent-traces/:^1.0.0 | BB managed catalog |
| ai-usage | npm:@goodit/bb-plugin-ai-usage@>=0.12.0 <1.0.0 | BB managed catalog |
| android-emulator | git:https://github.com/nicolay-i/bb-plugin-android-emulator.git@semver:^0.1.1 | BB managed catalog |
| animation | git:https://github.com/MacHatter1/bb-plugin-animation.git@semver:^0.3.0 | ./plugins/animation |
| app-preview | git:https://github.com/hungv47/bb-plugin-app-preview.git@semver:^0.2.9 | BB managed catalog |
| at-plugin | git:https://github.com/brsbl/bb-plugins.git@semver:at-plugin/:^0.1.0 | BB managed catalog |
| bb-github-pr-dashboard | git:https://github.com/ahsan7162/bb-github-pr-dashboard.git@semver:^0.3.0 | BB managed catalog |
| beautiful-chat | git:https://github.com/diip3sh/bb-plugin-beautiful-chat.git@semver:^0.1.0 | BB managed catalog |
| chat-sidebar | git:https://github.com/seoperin/bb-plugin-chat-sidebar.git@semver:^0.2.0 | BB managed catalog |
| codex-realtime | git:https://github.com/gpambrozio/bb-plugins.git@semver:codex-realtime/:>=0.1.0 | BB managed catalog |
| copy-session-id | git:https://github.com/patleeman/bb-plugins.git@semver:copy-session-id/:^0.1.0 | BB managed catalog |
| cua-driver | git:https://github.com/juanbermudez/bb-plugin-cua-driver.git@semver:^0.1.0 | BB managed catalog |
| desktop-browser-agent | git:https://github.com/qwadrox/bb-plugin-desktop-browser-agent.git@semver:^0.5.0 | BB managed catalog |
| dictation-shortcuts | git:https://github.com/architawr/bb-plugin-dictation-shortcuts.git@semver:^0.2.1 | BB managed catalog |
| diff-review | git:https://github.com/gpambrozio/bb-plugins.git@semver:diff-review/:>=0.5.1 | BB managed catalog |
| docker | path:/Users/avm/projects/Personal/bb-plugin-docker-local | ./plugins/docker |
| dockside | git:https://github.com/MateoCerquetella/bb-plugins.git@semver:dockside/:^0.1.0 | BB managed catalog |
| genui | path:/Users/avm/projects/Personal/bb-smsunarto-plugins/plugins/genui | ./plugins/genui |
| gh-copilot | git:https://github.com/ai-ecoverse/bb-gh-copilot.git@semver:^1.0.0 | BB managed catalog |
| gigaam | git:https://github.com/AiXenix/bb-plugin-gigaam.git@semver:^0.1.0 | BB managed catalog |
| gitea | git:https://github.com/Nick-Motion/bb-plugin-gitea.git@semver:^1.0.2 | BB managed catalog |
| github-actions | git:https://github.com/pers0na2dev/bb-github-actions.git@semver:^0.1.1 | BB managed catalog |
| gtd-sidebar | path:/Users/avm/projects/Personal/bb-smsunarto-plugins/plugins/gtd-sidebar | ./plugins/gtd-sidebar |
| handoff | git:https://github.com/vburojevic/bb-plugin-handoff.git@semver:>=0.7.0 | BB managed catalog |
| hotspot | git:https://github.com/Hazihell/bb-plugin-hotspot.git@semver:^0.1.0 | BB managed catalog |
| image-preview | git:https://github.com/Dwite/bb-plugin-image-preview.git@semver:^0.1.0 | BB managed catalog |
| impromptu-ui | git:https://github.com/danielbachhuber/bb-plugins.git@semver:impromptu-ui/:^0.1.0 | BB managed catalog |
| inline-review | git:https://github.com/rdanhau/bb-plugin-inline-review.git@semver:^1.0.0 | BB managed catalog |
| kodaforge | git:https://github.com/Kodaks94/bb-plugin-kodaforge.git@>=0.4.0 <1.0.0 | ./plugins/kodaforge |
| makosh-ai | path:/Users/avm/Library/Application Support/Makosh BB Backend/plugins/ai | ./plugins/makosh-ai |
| makosh-mail | path:/Users/avm/projects/Personal/bb-main/.worktrees/live/plugins/mail | ./plugins/makosh-mail |
| makosh-navigation | path:/Users/avm/projects/Personal/bb-main/.worktrees/navigation-customizer/plugins/navigation | ./plugins/makosh-navigation |
| makosh-sidebar | path:/Users/avm/projects/Personal/bb-main/plugins/sidebar | ./plugins/makosh-sidebar |
| makosh-taskboard | path:/Users/avm/projects/Personal/bb-main/plugins/taskboard | ./plugins/makosh-taskboard |
| mcp-hub | git:https://github.com/fgbm/bb-plugin-mcp-hub.git@semver:^0.1.0 | BB managed catalog |
| memory-explorer | git:https://github.com/d-asensio/bb-plugin-memory-explorer.git@semver:>=0.1.0 <1.0.0 | BB managed catalog |
| next-prompt | git:https://github.com/CrazyCoder/bb-plugin-next-prompt.git@semver:>=0.4.0 | BB managed catalog |
| next-step | git:https://github.com/rutracker152/bb-plugin-next-step.git@b650928fb34c8d146edfa332b53c6aabebccc9d3 | BB managed catalog |
| plugin-updates | git:https://github.com/frankieshakes/bb-plugin-updates.git@semver:^0.1.1 | BB managed catalog |
| prompt-shaper | git:https://github.com/brsbl/bb-plugins.git@semver:prompt-shaper/:^0.1.2 | BB managed catalog |
| read-aloud | git:https://github.com/csells/bb-plugins.git@semver:read-aloud/:^0.1.1 | BB managed catalog |
| read-aloud-local | path:/Users/avm/projects/Personal/bb-read-aloud-local | ./plugins/read-aloud-local |
| ru | path:/Users/avm/projects/Personal/bb-plugin-ru | ./plugins/ru |
| scott-secrets | path:/Users/avm/projects/Personal/bb-smsunarto-plugins/plugins/scott-secrets | ./plugins/scott-secrets |
| session-history | git:https://github.com/neonick/bb-plugin-session-history.git@semver:^0.1.0 | BB managed catalog |
| skills | git:https://github.com/gpambrozio/bb-plugins.git@semver:skills/:^0.4.0 | ./plugins/skills |
| source-control | path:/Users/avm/projects/Personal/bb-smsunarto-plugins/plugins/source-control | ./plugins/source-control |
| specs | git:https://github.com/peteabu/bb-plugin-specs.git@semver:^0.1.0 | BB managed catalog |
| steel-browser | path:/Users/avm/projects/Personal/bb-main/plugins/steel-browser | ./plugins/steel-browser |
| thread-images | git:https://github.com/kartollikaa/bb-plugin-thread-images.git@semver:^0.1.3 | BB managed catalog |
| tree-sidebar | git:https://github.com/chadbailey59/bb-plugin-tree-sidebar.git@semver:^0.1.0 | BB managed catalog |
| tree-sidebar-local | path:/Users/avm/projects/Personal/bb-tree-sidebar-local | ./plugins/tree-sidebar-local |
| voice-mode | git:https://github.com/steveafrost/bb-plugin-voice-mode.git@semver:>=0.1.5 | BB managed catalog |
| wiki | git:https://github.com/himynameisjonas/bb-plugin-wiki.git@semver:^0.1.0 | BB managed catalog |
| worktree-ports | git:https://github.com/to-infinity-labs/bb-plugin-worktree-ports.git@semver:^0.1.0 | BB managed catalog |
