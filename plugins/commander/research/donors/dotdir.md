# Донор: DotDir (dotdirfm/dotdir)

Источник: `research/upstream/dotdir`, commit d40a482444ca3b85255439d415721e739b424685 (по `sources.lock.json`; в распакованном
дереве нет `.git`, соответствие SHA проверить нельзя, проверен только archiveSha256 в lock-файле как заявленный).
Только чтение кода; ничего не устанавливалось и не запускалось. README и CLAUDE.md апстрима считаются заявлениями, а не фактом:
ниже везде помечено «найдено в коде» или «заявлено».

Пути ниже относительно корня апстрима. `ui` = `packages/ui/lib`.

## 1. Структура и лицензии

pnpm-монорепо (`pnpm-workspace.yaml`: `packages/*`, catalog strict) плюс корневое Tauri-приложение (`src/`, `src-tauri/`).

| Пакет | Версия | Лицензия (источник) | Роль |
| --- | --- | --- | --- |
| корень `dotdir` (package.json:1-4) | 0.1.4 private | НЕТ (ни поля, ни LICENSE) | Tauri-оболочка, `src/main.tsx`, `tauriBridge.ts`, `wsBridge.ts` |
| `@dotdirfm/ui` (packages/ui/package.json:42) | 0.1.34 | ISC (только поле) | компонент `DotDir`, весь UX |
| `@dotdirfm/commands` (:37) | 0.1.0 | ISC (только поле) | реестр команд, keybindings |
| `@dotdirfm/file-list` (:39) | 0.1.0 | ISC (только поле) | FileList, Breadcrumbs |
| `@dotdirfm/terminal` (:39) | 0.1.0 | ISC (только поле) | xterm-терминал |
| `@dotdirfm/extension-api` (:32) | 0.1.6 | ISC (только поле) | типы расширений |
| `@dotdirfm/fss` (:7; README:232) | 0.0.6 | MIT (поле и README) | CSS-подобные стили файлов |
| `@dotdirfm/ui-bridge` | 0.1.0 | НЕ УКАЗАНА | интерфейс `Bridge` |
| `@dotdirfm/ui-focus` | 0.1.0 | НЕ УКАЗАНА | слои фокуса |
| `@dotdirfm/ui-utils` | 0.1.0 | НЕ УКАЗАНА | path, cx, ComposeProviders, styleHost |
| Rust `dotdir`, `dotdir-core` (Cargo.toml) | 0.1.0 | НЕ УКАЗАНА | backend, copy/move/delete/search/watch |

Файлов LICENSE/COPYING/NOTICE в дереве нет (find по всему дереву, кроме node_modules). Автор в package.json: Mikhail Isupov.
Вывод по лицензии: ISC и MIT заявлены только в метаданных, без текста лицензии и без строки copyright; три TS-пакета
(`ui-bridge`, `ui-focus`, `ui-utils`, то есть самый нужный нам контракт) и весь Rust без лицензии = «все права защищены»
по умолчанию. Лицензию одного пакета на другие переносить нельзя. До письменного подтверждения автора (issue/PR с
добавлением LICENSE) копировать код ui-bridge/ui-focus/ui-utils/Rust нельзя; ISC/MIT-пакеты можно использовать,
сохранив заявленные имя и лицензию, но отсутствие copyright-строки остаётся юридической неопределённостью.

## 2. Контракт Bridge

`packages/ui-bridge/src/bridge.ts`, интерфейс `Bridge` (найдено в коде). Единственная точка связи UI с нативом; реализаций две
в корне: `src/tauriBridge.ts` (invoke/listen) и `src/wsBridge.ts` (JSON-RPC 2.0 поверх WebSocket, бинарные кадры для fs.read и
PTY, автопереподключение с backoff, heartbeat). Выбор реализации: `'__TAURI_INTERNALS__' in window` (src/main.tsx).

Методы:
- `fs`: `entries(dir)->FsEntry[]`, `stat`, `exists`, `readFile->ArrayBuffer`, `open/read/close` (fd), `watch(watchId,dir)`,
  `unwatch`, `onFsChange`, `writeFile(text)`, `writeBinaryFile`, `createDir`, `removeFile?`, `moveToTrash(paths[])`.
- `fs.copy|move`: `start(sources,destDir,options)->id`, `cancel(id)`, `resolveConflict(id, resolution)`, `onProgress(cb)`.
  `fs.delete`: `start/cancel/onProgress`. `fs.search`: `start/cancel/onProgress`. `fs.rename.rename(source,newName)`.
- `pty`: `spawn/write/resize/close/onData/onExit/setShellIntegrations?`.
- `utils`: `getHomePath`, `getMountedRoots`, `getAppDirs`, `getEnv`, `debugLog?`, `openExternal?`.
- `systemTheme`: `get`, `onChange`. `extensions.install`: `start/cancel?/onProgress/onRequest?/emitRequest?`.
- Опциональные: `window?` (getCurrentState/create/showCurrent/closeCurrent/exitApp/onStateChanged), `onReconnect?`,
  `fsProvider?` (WASM-провайдеры ФС: load/listEntries/readFileRange).

Типы: `FsEntry{name,kind(11 значений),size,mtimeMs,mode,nlink,hidden,linkTarget?}`; `CopyOptions{conflictPolicy(ask|overwrite|skip|
rename|append|onlyNewer), copyPermissions, copyXattrs, sparseFiles, useCow, symlinkMode, disableWriteCache}`;
`ConflictResolution` = overwrite|skip|rename(newName)|overwriteAll|skipAll|cancel; события прогресса — размеченные union
(`progress|conflict|done|error`).

Что требует нативного: `pty.*` (портативный pty), `moveToTrash` (crate trash), `getMountedRoots`, `window.*` (Tauri window),
`fsProvider` (wasmtime), `extensions.install` (Rust: загрузка и распаковка zip), `systemTheme` (WebView), fs.open/pread по fd,
xattr/CoW/sparse в copy. Всё это в браузере реализуется только на стороне сервера.

Реализуемость поверх RPC в браузере: да, и это уже сделано апстримом: `wsBridge.ts` + `src-tauri/src/serve.rs`
(`dispatch` с методами `fs.entries`, `fs.stat`, `fs.writeFile`, `fs.moveToTrash`, `utils.getMountedRoots` и т.д.; axum `/ws`,
`/vfs/*path`). Для BB нужен адаптер Bridge -> BB plugin RPC/события; события (watch, progress, conflict) требуют серверного
push-канала; бинарные данные (readFile/read) надо возвращать ArrayBuffer. Контракт плоский и сериализуемый, это сильная сторона.
Замечание: `Bridge` не имеет понятия профилей/прав/корней — любая абсолютная строка пути доверяется бэкенду. В BB нужна
песочница путей на стороне сервера плагина.

## 3. React и зависимости UI

- React: peerDependency `^19.0.0` у ui, ui-bridge, ui-focus, ui-utils, commands, file-list, terminal; catalog `react ^19.2.4`.
  `react` и `react-dom` в `vite.config.ts` пакета ui помечены external (rolldownOptions.external), то есть второй React в
  сборку НЕ попадает. Также external: jotai, jsonc-parser, marked. Но `monaco-editor`, `@xterm/xterm`, `@tanstack/react-virtual`,
  `react-icons`, `semver`, `vscode-textmate/oniguruma` — dependencies, попадут в бандл. Использует React 19 API `use()`
  (ui-bridge/src/appDirs.ts), `inert`, Suspense.
- State: jotai `^2.19` (глобально общий пакет-external; своё `<Provider>` в DotDir.tsx:99, чужой store не используется).
  CLAUDE.md заявляет запрет `getDefaultStore()`; grep по коду совпадений не дал.
- Стили: CSS Modules (`*.module.css`), собираются в один `dist/dotdir.css` (exports `./dotdir.css`, sideEffects css).
  Тема через CSS-переменные на `.dotdir-root` (`ui/styles/base.module.css`: --bg, --fg, --accent ... захардкожены Catppuccin-тона).
  Сброс `:where(.dotdir-root, .dotdir-root *)` (скоуп корня). Корень `<div data-dotdir-style-host="true">` (DotDir.tsx:87);
  `ui-utils/src/styleHost.ts` находит его через `document.querySelector`, иначе падает на `document.documentElement`.
- Виртуализация: `@tanstack/react-virtual` + собственная многоколоночная (`file-list/src/FileList/FileList.tsx:16` ROW_HEIGHT=26,
  `ColumnsScroller.tsx`, `ScrollableContainer.tsx`).
- Порталов (`createPortal`) в коде нет; диалоги и палитра рендерятся внутри дерева (`DialogHolder`, `CommandPalette` в app.tsx).
- Глобальные побочные эффекты (найдено grep'ом), опасные для чужого host:
  - `ui/features/commands/useCommandRouting.ts:27-28`: keydown capture на root + на `window` (capture) для Tab и F1-F12 при
    `focusContext.is("panel")`, без проверки, что событие внутри root. Перехватывает F-клавиши BB при фокусе «panel».
  - `ui/features/command-line/CommandLine/CommandLine.tsx:321`: `window` keydown, печатные символы вне редактируемых элементов
    `preventDefault`+`stopPropagation` и уходят в командную строку (только пока `visible`).
  - `ui/components/KeyBar/KeyBar.tsx:117-119`: window keydown/keyup/blur (индикация модификаторов, безвредно).
  - `ui/dialogs/dialogHotkeys.tsx:120` и `HelpDialog.tsx:22`: `document` keydown capture (Alt+буква в диалогах; глобально).
  - `ui/features/extensions/ExtensionContainer.tsx:443`: window keydown capture.
  - `file-list/src/FileList/FileList.tsx:203`: window keyup (безвредно).
  - `ui/components/NestedPopoverMenu/NestedPopoverMenu.tsx:197`: `document.documentElement.dataset.nestedMenuDirection` + View Transitions.
  - `ui/features/extensions/builtins/MonacoEditorSurface.tsx:122,626,685,808`: `document.body.appendChild` host, `<style>` в
    `document.head`, наблюдатель за `documentElement` style.
  - `ui/features/terminal/useTerminalState.ts:29,43`: `localStorage`; `useWorkspaceSessionProcess.ts:201`: `beforeunload`.
  - `ui/features/file-system/vfs.ts:41`: `__TAURI_INTERNALS__`, `window.location.origin`, URL вида `/vfs/...`.

## 4. Двухпанельный UX (что и где)

- Панели/вкладки: `ui/components/PanelGroup`, `PanelTabs/PanelTabs.tsx`, `Tabs/Tabs.tsx`; модель `ui/entities/tab/model/{types,tabsAtoms}.ts`
  (две стороны left/right, `FileListTab` с `path, entries, activeEntryName, selectedEntryNames, parent`; `PreviewTab`),
  `ui/features/panels/{useFileListPanel,panelControllers}.ts(x)`. Вкладки панели могут быть просмотрщиком/редактором файла.
- История навигации: НЕ найдена (поиск history/back/goBack ничего не дал). Есть `parent` в состоянии вкладки и
  `FILELIST_GO_TO_PARENT`/`GO_HOME`. История назад/вперёд придётся писать самим.
- Выделение: `selectedEntryNames` в состоянии вкладки; Shift-выделение через `prevSelectRef` (FileList.tsx:195-205);
  действия в `file-list/src/FileList/fileListActions.ts`, `useFileListCommands.ts` (332 стр.). Insert/Space и т.п. — не проверено.
- F-клавиши: `ui/features/commands/registerKeybindings.ts` (список keybinding'ов с `when`-условиями): F3 просмотр, F4 правка,
  F5 копия, F6 перенос (по паттерну; строки 242+), F7 mkdir (:113), F8 в корзину (:240), F9 настройки, F10 выход/закрытие окна,
  F11 расширения, F1 палитра. Реестр: `packages/commands`; контексты `focusPanel`, `listItemIsFile`, `dialogOpen`. Пользовательские
  биндинги: `commands/userKeybindings.ts`, диалог `KeybindingsDialog.tsx`.
  Внимание: F1/F9/F10/F11 заняты поведением DotDir, надо переопределять.
- Очередь операций: ОТСУТСТВУЕТ. `ui/features/file-ops/useFileOperations.ts` (649 стр.) держит один активный
  `activeCopyIdRef/activeMoveIdRef/activeDeleteIdRef`, прогресс в модальном диалоге (`CopyProgressDialog`, `DeleteProgressDialog`).
  `ActionQueue` (file-list/src/FileList/actionQueue.ts) — только сериализация UI-действий, не очередь файловых операций.
- Конфликт-диалоги: `ui/dialogs/ConflictDialog.tsx` (132 стр.), событие `conflict` в useFileOperations.ts:398-408 (copy) и :536-546
  (move) -> `bridge.fs.*.resolveConflict`. Диалоги конфигурации: `CopyConfigDialog`, `MoveConfigDialog`; поиск: `FindFilesDialog`,
  `FindFilesResultsDialog`; `RenameDialog`, `MakeFolderDialog`, `SettingsDialog`, `PathAutocompleteInput`.
- Прочее встроенное: командная строка, терминал (xterm + pty), панель расширений, просмотрщик/редактор (Monaco), палитра, KeyBar.

## 5. Расширения

- Манифест: `package.json` в стиле VS Code с `contributes`: `languages, grammars, themes, iconTheme(s), commands, keybindings, viewers,
  editors, fsProviders, shellIntegrations` (`ui/features/extensions/extensions.ts:56-138`; план в `docs/viewer-editor-extensions-architecture.md` — заявлено).
  Viewer/Editor: `{id,label,patterns,mimeTypes?,entry(JS),priority?}`.
- Runtime: (а) viewer/editor UI грузится в `<iframe>` с URL из VFS (`ExtensionContainer.tsx:1019-1025`), атрибут
  `sandbox="allow-same-origin allow-scripts allow-top-navigation-to-custom-protocols"`, связь через postMessage RPC (`HostApi` в
  `packages/extension-api/src/index.ts`: readFile/writeFile/executeCommand/getTheme...). (б) VS Code-совместимый extension host в
  Web Worker (`extensionHost.worker.ts`, шим `vscodeShim/*`, LSP-мост в Monaco), `new Worker` в `extensionHostClient.ts:403`.
  (в) fsProviders — WASM (wasmtime в Rust, `src-tauri/src/fsprovider.rs`; в браузере `browserFsProvider.ts:87` вставляет `<script>`).
- Модель доверия: НЕ найдено ни подписей, ни контрольных сумм, ни системы разрешений (grep sha/signature/checksum/permission по
  marketplaces и extensions_install.rs пусто). Установка из маркетплейсов `dotdir.dev` и `open-vsx.org`
  (`marketplaces/*.ts`). `allow-same-origin`+`allow-scripts` в iframe: в Tauri origin отдельный (`vfs://`), но в web-режиме iframe
  отдаётся с того же origin (`/vfs/_ext/...`), и такой sandbox не защищает от выхода (контент может снять sandbox/обратиться к
  родителю). Для BB это неприемлемая модель: расширения, исполняемый код из сети. Вывод: расширения не брать.
- `window` message handler: `ExtensionContainer.tsx:838`.

## 6. Файловые операции

Выполняются в backend (Rust), UI только оркестрирует.
- `src-tauri/dotdir-core/src/copy.rs` (896 стр.): движок копирования с прогрессом, отменой, политиками конфликта,
  `override_all` (:583-584), CoW, sparse, xattr. `move_op.rs` (343), `delete.rs` (98), `search.rs` (318; globset, regex, grep-*),
  `watch.rs` (322; notify), `ops.rs` (578; entries/stat/fd), `proto.rs` (420; бинарный протокол elevated helper).
- Elevated-helper (`src-tauri/src/elevate.rs`, `rpc.rs`) — привилегированный демон для root-операций (Unix). В BB не нужен.
- Тесты: фронтенд — vitest: `ui-focus/tests/focus.test.ts`, `ui/tests/commands.keybindings.test.ts`, `terminal/tests/TerminalSession.test.ts`,
  `file-list/tests/actionQueue.test.ts`, `commands/tests/commands.test.ts`, 12 файлов в `fss/tests`. Rust: `#[test]` только в
  `ops.rs` (9), `proto.rs` (7), `watch.rs` (6); в `copy.rs`, `move_op.rs`, `delete.rs`, `search.rs` тестов нет (grep `#[test]` = 0).
  Нет тестов useFileOperations, ConflictDialog, DotDir.tsx, интеграционных. CI (`.github/workflows/ci.yml`) делает `tsc --noEmit`
  и Tauri-сборку; `pnpm test`/cargo test не вызываются (найдено в коде; CLAUDE.md заявляет «No test suite», что расходится с наличием тестов).
- Сервер без аутентификации: `serve.rs:67-71` `ws_handler` без проверки Origin/токена, `vfs_handler` (:767) отдаёт файлы по абсолютному
  пути; по умолчанию bind 127.0.0.1 (:924). Для BB это неприемлемо как есть.

## 7. Отделимость от Tauri

- Пакеты `packages/*` не импортируют `@tauri-apps` (grep по packages: единственное совпадение — `ui/features/commands/useBuiltInCommands.ts:87`
  `import { isTauri } from "@tauri-apps/api/core"`, плюс `vfs.ts:41` проверка `__TAURI_INTERNALS__`). Остальные Tauri-места — в корне:
  `src/main.tsx`, `src/tauriBridge.ts`, `src/auth.ts`, `src/useAuth.ts`, `src/components/AccountWidget.tsx` (аккаунт/deep-link),
  `src-tauri/src/lib.rs` (1280 стр.), `pty.rs`, `fsprovider.rs`, `extensions_install.rs`.
- Поправка: `ui/package.json` не объявляет `@tauri-apps/api`, хотя `useBuiltInCommands.ts:87` его импортирует (скрытая зависимость
  в собранном бандле; нужно вырезать при вендоринге).
- `dotdir-core` — чистая Rust-библиотека без Tauri (Cargo.toml: notify, globset, regex, grep-*, libc, xattr, windows-sys,
  параметр tempfile в dev), но без лицензии и без тестов на основной движок.
- Публичная поверхность `@dotdirfm/ui`: `DotDir` (props `bridge`, `widget`, `resolveVfsUrl`; ref `focus()`), никаких
  конфигураций для отключения терминала/расширений/Monaco/командной строки.

## 8. Риски встраивания в React-host BB

1. Второй React не нужен: React external, peer ^19. Но нужно подтвердить, что BB даёт React 19 и один экземпляр (проверить в BB SDK; не проверялось).
2. Монолит: `DotDir` включает терминал, Monaco (форкнутый `monacoEntry.ts`), extension host worker, LSP, маркетплейс. Нельзя взять «двухпанельный менеджер» без
   этого; пакет `ui` тянет Monaco/xterm/vscode-textmate и воркеры (размер бандла, CSP, workers в плагине BB).
3. Глобальный перехват клавиатуры (см. п.3): window capture для F1-F12/Tab и печатных символов. Требует форка/патча хуков, чтобы
   слушатели вешались на корень, а не на `window`. Контракт ui-focus (`shouldRouteCommandEvent` проверяет `root.contains`) частично
   корректен, но `handleWindowKeyDown` обходит эту проверку.
4. Глобальные DOM-побочки: Monaco в `document.body`/`head`, `documentElement.dataset`, `localStorage`, CSS-переменные тёмной темы
   (нет связи с темой BB; нужен слой маппинга переменных).
5. Лицензия: три ключевых пакета и Rust без лицензии; остальные ISC/MIT без текста.
6. Bridge не покрывает: историю, очередь операций, права и корни; серверная часть апстрима без аутентификации.
7. Безопасность расширений: iframe `allow-same-origin`+`allow-scripts`, нет подписей.
8. Зависимости catalog: TypeScript ~6.0, Vite 8, tsdown — свежие мажорные, возможна несовместимость с тулчейном BB.
9. Монорепо `workspace:*` и `catalog:` — вендоринг потребует переписывания зависимостей (корень нашего репо без workspace по правилам AGENTS.md).

## Таблица: функция -> файл/символ -> лицензия -> найдено/заявлено -> адаптация -> риски

| Функция | Файл / символ | Лицензия | Найдено/заявлено | Адаптация | Риски |
| --- | --- | --- | --- | --- | --- |
| Контракт Bridge | `ui-bridge/src/bridge.ts` `Bridge`, типы | НЕТ (не указана) | найдено | взять как референс формы API, написать свой контракт `CommanderPort` | копировать нельзя без лицензии |
| WS-реализация Bridge | `src/wsBridge.ts`, `serve.rs dispatch` | корень без лицензии | найдено | референс протокола (JSON-RPC + бинарные кадры) | нет auth/Origin |
| Компонент DotDir целиком | `packages/ui/lib/DotDir.tsx` | ISC (поле) | найдено | не брать целиком | монолит, Monaco, терминал, расширения |
| Список файлов (колонки, виртуализация) | `file-list/src/FileList/*` | ISC (поле) | найдено | кандидат на адаптацию/форк | глобальный window keyup; CSS Modules; зависит от fss/commands |
| Вкладки панелей | `Tabs.tsx`, `PanelTabs.tsx`, `entities/tab` | ISC (ui) | найдено | референс модели | привязано к jotai-атомам и preview-вкладкам |
| Реестр команд и keybindings (`when`) | `packages/commands`, `registerKeybindings.ts` | ISC (поле) | найдено | кандидат: чистый TS, тесты есть | F-клавиши по умолчанию заняты |
| Слои фокуса | `packages/ui-focus` | НЕТ | найдено | референс идеи | лицензия |
| Конфликт-диалог/протокол | `ConflictDialog.tsx`, `ConflictResolution`, `useFileOperations` | ISC (ui) | найдено | референс сценария (overwrite/skip/rename/all/cancel) | один активный op, нет очереди |
| Движок copy/move/delete | `dotdir-core/src/{copy,move_op,delete}.rs` | НЕТ | найдено | референс; использовать как Rust-helper нельзя без лицензии | нет тестов на copy/move/delete |
| watch/search | `dotdir-core/src/{watch,search}.rs` | НЕТ | найдено | референс | лицензия |
| История навигации | — | — | не найдено | писать самим | — |
| Очередь операций | — | — | не найдено | писать самим | — |
| FSS (стили файлов) | `packages/fss` | MIT (поле+README) | найдено, 12 тестов | необязательно; можно взять | нет текста лицензии/copyright |
| Терминал | `packages/terminal`, `pty.rs` | ISC (поле) | найдено | вне MVP | pty на сервере |
| Расширения | `ExtensionContainer.tsx`, `extensionHost.worker.ts` | ISC (ui) | найдено | НЕ брать | исполняемый чужой код, same-origin sandbox |

## Оценка «спайк A» (DotDir UI через адаптер Bridge в navPanel BB)

| Критерий | Результат | Основание |
| --- | --- | --- |
| Встраиваемость в navPanel BB | ЧАСТИЧНО | компонент React с `bridge`-пропом, `ref.focus()`, корень 100%×100%; но монолит (Monaco, терминал, воркеры), тёмная палитра, нет опций отключения |
| Совместимость React | ПРОХОДИТ при условии React 19 в BB | React/react-dom external, peer ^19; jotai external (общий пакет, но свой Provider) |
| Фокус/клавиатура без глобального перехвата | НЕ ПРОХОДИТ как есть | `useCommandRouting.ts:28` window capture F1-F12/Tab; `CommandLine.tsx:321` window keydown глотает печатные символы; document capture в диалогах; нужен форк хуков |
| Лицензия | НЕ ПРОХОДИТ | нет LICENSE; ui-bridge/ui-focus/ui-utils и Rust без лицензии; ISC/MIT только в package.json |

Итог: спайк A в форме «взять `@dotdirfm/ui` целиком» НЕ проходит (клавиатура, лицензия, монолит). Рекомендация: DotDir как
РЕФЕРЕНС UX и контракта; писать собственный UI и порт `CommanderPort`. Если автор добавит LICENSE (ISC) для всех пакетов,
пересмотреть выборочный вендоринг: `file-list` (FileList, Breadcrumbs), `commands` (реестр команд с when-контекстами),
`fss`, форм-факторы диалогов конфликта; с обязательной заменой window-слушателей на root-scoped, удалением Tauri-импорта
и вырезанием расширений/Monaco/терминала.

Что брать (после уточнения лицензии): `packages/commands` (чистый TS, с тестами), `packages/file-list` (виртуализация колонок),
`packages/fss` (MIT, по желанию). Только референс: Bridge/wsBridge/dispatch, `useFileOperations` (протокол конфликтов и прогресса),
`registerKeybindings.ts` (раскладка F-клавиш и `when`), `dotdir-core` (алгоритмы copy/move/search, без копирования кода). Не брать:
расширения/iframe/worker/LSP, Monaco, терминал, elevated helper, `src/auth*`, Tauri-оболочку, `serve.rs` как есть.

## Непроверенное

- Совпадение распакованного дерева с SHA d40a4824 (нет .git).
- Insert/Space-выделение и Total Commander-подобные клавиши (+/-/*), сортировка панелей: не исследовались построчно.
- Версия React в BB и способ подключения CSS/воркеров в плагине BB.
- Полнота grep по глобальным слушателям: искались `addEventListener` на window/document, не `onKeyDown` через `ref`.
