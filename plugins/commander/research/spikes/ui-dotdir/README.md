# UI spike A: `@dotdirfm/ui` inside a BB navPanel

Stage 0, 2026-11-27. A throwaway plugin, not part of Commander.

## Setup

| Item | Value |
| --- | --- |
| Host | macOS 27.0.1 arm64 |
| BB | 0.50.1 test instance, own data dir (`$BB_THREAD_STORAGE/test-bb`), ports 5910/5911, `BB_SKIP_ONBOARDING=1`, `--bundled --no-in-app-updates` |
| Runtime SDK | 0.6.157 (plugin pins 0.6.132; BB warns and loads it) |
| Package | `@dotdirfm/ui@0.1.34` from npm, installed with `npm install --ignore-scripts` |
| Bridge | `fake-bridge.ts`: in-memory tree; copy/move/delete/search/pty refuse |
| Browser | headless Chrome via `bb browser-automation`, 1440×900 |

The working BB installation was not touched.

## What happened

1. Mounts as a React component in `slots.navPanel` with BB's React (no
   second runtime; `react`, `react-dom`, `jotai` are external in the package).
   Screenshot: `screens/01-dotdir-in-navpanel.jpg`.
2. Boot fails silently ("Loading...") until the bridge serves DotDir's own
   config files (`~/.config/settings.json`, `.data/extensionSettings.json`,
   `.data/extensions/extensions.json`): it does not handle ENOENT and leaves
   unhandled rejections (`ui-layout.json` still throws on every load).
3. Package types are broken: `dist/lib/DotDir.d.ts` re-exports `Bridge`
   from `../features/bridge`, which does not exist in `dist/`, so `Bridge`
   is `any` for consumers.
4. Bundle: `app.js` 5.7 MB, `app.css` 368 KB (Monaco, xterm included; cannot
   be switched off through props).
5. Own palette (Catppuccin), ignores BB theme tokens.
6. Keyboard probe (listener on `window` capture registered before DotDir
   mounts, plus `window` bubble):
   - **F5 pressed in an `<input>` outside the DotDir root** was
     `preventDefault` + `stopPropagation`ed and opened DotDir's
     "Copy 1 item" dialog, which took focus. Screenshot:
     `screens/02-f5-from-outside-input-opens-copy.jpg`.
   - **"zq" typed with focus on a BB sidebar element** ended up in DotDir's
     command line (`/home/spike> zq`).
   - Printable keys typed into the outside input stayed there.

## Verdict

Spike A fails the stage 0 criteria. Embedding works mechanically, but
DotDir captures keys and text outside its own root, which would break BB's
composer, terminal and shortcuts; licence of the needed packages is unclear
(see `../../donors/dotdir.md`); theming and bundle size do not fit. DotDir
stays a reference (Bridge shape, conflict protocol, F-key map), not a base.

## Not checked

- Real file operations through a backend bridge (the fake bridge refuses).
- BB's own shortcuts while DotDir is focused (Cmd+K was pressed while
  DotDir's modal dialog was open, so the result says nothing).
- Panel-side `experimental_tab` mount.
