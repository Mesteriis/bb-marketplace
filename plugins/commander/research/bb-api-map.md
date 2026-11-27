# Карта BB API для плагина Commander (makosh-commander)

Только чтение и анализ. Ничего не собиралось и не устанавливалось.

## 0. Источники и версии (важно)

Обозначения путей:

- `DTS` = `/Users/avm/projects/Personal/bb-main/plugins/mail/node_modules/@get-bb/plugin-sdk/bundled-types/` (SDK 0.6.132: `package.json:3`).
  `app.d.ts` = `DTS/bb-plugin-sdk-app.d.ts` (фронтенд, `@get-bb/plugin-sdk/app`); `sdk.d.ts` = `DTS/bb-plugin-sdk.d.ts` (корень: бэкенд + типы клиента);
  `host.d.ts` = `DTS/bb-plugin-sdk-host.d.ts`; `process.d.ts` = `DTS/bb-plugin-sdk-process.d.ts`.
- `UP` = `.../plugins/commander/research/upstream/get-bb` (upstream main, commit b0ddaad7; `packages/plugin-sdk/package.json` = 0.6.205, `apps/desktop/package.json` = 0.50.1).
  Тега/коммита 0.50.1 в upstream нет (нет .git), поэтому main может опережать 0.50.1.
- `INST` = `/Users/avm/Library/Application Support/Makosh BB Backend/runtime/node_modules/bb-app` — реально установленный BB 0.50.1
  (`~/.bb/bb-app-runtime.json`: version 0.50.1, surface web). Собранный бандл, читал grep-ом.

Три разные версии SDK:

| Что | Версия | Доказательство |
|---|---|---|
| Декларации репозитория (контракт для типизации) | 0.6.132 | `DTS/../package.json:3` |
| SDK, который реально подставляет установленный BB 0.50.1 | **0.6.157** | `INST/server/dist/start-server.js` (`PLUGIN_SDK_VERSION = "0.6.157"`); в upstream `UP/packages/domain/src/plugin-sdk-version.ts:1` = 0.6.205 |
| Upstream main | 0.6.205 | там же |

Совместимость: `UP/apps/server/src/services/plugins/sdk-compat.ts:4-11` — `engines.bbPluginSdk` проходит, если мажор совпадает и running >= floor диапазона.
Значит плагин на 0.6.132 грузится в BB с 0.6.157.

Различия, найденные поиском символов в `INST` (grep по бандлу) и в `DTS`:

- Есть в 0.6.157, нет в декларациях 0.6.132: `experimental_hideFromNavigation`, `experimental_headerTitle` (у navPanel). В 0.6.132 есть только `headerContent` (`app.d.ts:20083`). Используйте с приведением типов или поднимайте SDK.
- Есть в main, НЕТ в установленном 0.50.1: `PluginCommandRegistration.experimental_keyScope` (`UP/packages/plugin-sdk/src/app-contract.ts:4107,4120`),
  `experimental_useCommandShortcut`, `experimental_matchesShortcutKey`, `bb.storage.experimental_directory()` (`UP/.../backend-contract.ts:215,2095`), `experimental_useActiveComposer`.
  Эти символы нельзя использовать, пока пользователь на 0.50.1.
- Есть и в 0.6.132 d.ts, и в 0.50.1: `experimental_tab`, `experimental_appOverlay`, `experimental_openFilePreview`, `experimental_openTerminal`, `experimental_websocket`,
  `experimental_retainWorker`/`experimental_watch`/`experimental_onWorkerExit` (host entry), `experimental_caller`, `experimental_discoverRpc`, `experimental_saveFile`, `experimental_useFixedTabTarget`, `experimental_lineRange`.

## 0.1 Какой SDK BB подставляет в рантайме

- Server entry: спецификаторы `@get-bb/plugin-sdk` и устаревший `@bb/plugin-sdk` резолвятся в `plugin-sdk-runtime.js` самого сервера, `better-sqlite3` — хостовый (`UP/apps/server/src/services/plugins/plugin-runtime.ts:114-144`, `:1371-1378`).
  Плагин не несёт свой SDK в рантайме. `zod` бандлится плагином (общий zod только у builtin: `plugin-runtime.ts:147-160`).
- Frontend (`bb.app`): `bb plugin build` НЕ бандлит `react`, `react-dom`, `react/jsx-runtime`, radix-порталы (dialog, popover, select, dropdown-menu, context-menu, tooltip и др.), `sonner`, `vaul`, `@pierre/diffs`; они подставляются через `globalThis.__bbPluginRuntime`
  (`UP/packages/plugin-build/src/runtime-shims.mjs:71-89`). То есть второго React-рантайма нет, хуки и контекст общие с хостом. Версия React хоста в main: `^19.3.1` (`UP/apps/app/package.json`); в установленном 0.50.1 слот `__bbPluginRuntime` присутствует (`INST/app/dist/assets/plugin-frontend-*.js`), точную версию React не проверял.
- `bb.host` (опционально): `bb plugin build` собирает `dist/host.js` (≤256 MiB, см. п.5); хелперы SDK вшиваются (`UP/.../references/backend-foundation.md:312-336`).
- SDK-экспорты рантайма: `defineRpcContract`, `experimental_defineHostEntry`, `PLUGIN_CLI_OUTPUT_MAX_BYTES`, `defineCli`, `cliCommand`, `PluginCliError`; остальное — типы (`UP/.../references/quickstart.md:205-213`).

## 1. UI

### 1.1 Страница плагина (полноэкранная)

- `app.slots.navPanel(registration)` — `app.d.ts:22590`; тип `PluginNavPanelRegistration` около `app.d.ts:19992-20090`
  (upstream `UP/packages/plugin-sdk/src/app-contract.ts:1080`).
  Поля: `id, title, icon, path, component, experimental_sidebar?, experimental_usePageTitle?, experimental_useBadge?, headerContent?`.
  Маршрут `/plugins/<pluginId>/<path>/*`, компонент получает `{ subPath }` (процент-кодированный, `app.d.ts:19230`). Навигация внутри: `useBbNavigate().toPluginPanel(path, { subPath, replace })` (`app.d.ts:23882`).
  Хост сам оборачивает страницу в App panel (вкладки Browser и Terminal); вторую панель монтировать нельзя (`UP/.../references/frontend-core-slots.md`, раздел navPanel).
  Тело страницы без отступов, скролл свой.
- `experimental_sidebar` (`app.d.ts:20057`) заменяет список тредов, пока открыт маршрут панели (подходит для дерева закладок/дисков). Escape = «Back to app», вызывайте `preventDefault()` на своём Escape.
- `experimental_hideFromNavigation`: только 0.6.157+ (нет в d.ts 0.6.132).

### 1.2 Панель рядом с тредом и вкладки

- `app.slots.experimental_tab(...)` — `app.d.ts:22592-22593`, тип `ExperimentalTabRegistration` `app.d.ts:20161`.
  `context: { kind: "thread" }` (props `{ threadId, environment: {id}|null }`) или `{ kind: "nav-panel", panelId }` (props `{ subPath }`).
  `availability: "fixed"` (закреплённая, не закрывается) или `"action"` (запускалка, JSON `params`, `run`). `useVisible`, `layout: "padded"|"flush"`, `experimental_target.validate` для fixed-вкладок.
- Управление панелью: `experimental_useAppPanel()` (`app.d.ts:24149`) → `ExperimentalPanelController` (`app.d.ts:23776`): `openTab/toggleTab/close`, возвращают boolean (false = хост отклонил, исключений нет).
  `experimental_useFixedTabTarget` (`app.d.ts:24159`), `experimental_usePanelTabs` (список всех открытых вкладок, включая терминалы и вкладки других плагинов).
- Тред-вкладки получают threadId, но проект/окружение/хост нужно дочитывать самим через `useSdk()` (`threads.get`, `environments.get`).
- Корневой экран New thread: `experimental_newThreadPanelAction` (`app.d.ts:22594`).

### 1.3 Модалки, порталы, оверлеи

- Модалки: vendored shadcn `Dialog` (`bb plugin new` кладёт в `components/ui/`, использует `lib/portal-scope`; на узком экране Dialog становится нижней шторкой) — `UP/.../references/frontend-hooks-and-ui.md:245-330`.
  Radix-порталы шарятся с хостом (dismissable-layer, focus, scroll-lock общие).
- Постоянный плавающий UI на уровне окна: `app.slots.experimental_appOverlay({ id, component })` (`app.d.ts:22583`, `ExperimentalAppOverlayRegistration` `app.d.ts:19951`); хост даёт только монтирование, позиция/фокус на плагине.
- Тосты: `import { toast } from "sonner"` (шим на тосты BB). Ошибки SDK: `experimental_showErrorToast`. Буфер: `experimental_copyToClipboard` (`app.d.ts:24427`); скачивание: `experimental_saveFile({fileName,url}|{fileName,blob})` (`app.d.ts:24440`).
- Файловая ссылка/просмотр: `experimental_FileLink` (`app.d.ts:24458`), `experimental_SourceCode`, `experimental_FilePreview`, `experimental_Diff` (`app.d.ts:24510`).
- Content scripts (полный доступ к DOM, не песочница): `app.contentScripts.register({id, mount})` (`app.d.ts:22830`), mount ≤10 с, отмена через `signal`.

### 1.4 CSS и токены

- Tailwind компилируется против живых CSS-переменных темы хоста: классы `bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `text-destructive`. Нельзя объявлять свои `@theme` цвета и литералы `oklch()/gray` (`UP/.../references/frontend-hooks-and-ui.md`, блок «Styling»).
- Статический `app.css` живёт, пока есть слот/портал/контент-скрипт плагина; это не глобальный стиль. Глобальная палитра — через `bb.themes` в манифесте.
- Монтирования и порталы нужно помечать plugin id (`data-bb-plugin`, `data-bb-plugin-root`) через `lib/portal-scope` (`UP/.../references/quickstart.md:182-190`).
- Код-тема (для Monaco-подобных движков): `experimental_useCodeTheme()` (`app.d.ts:24416`).

### 1.5 Клавиатура и глобальные хоткеи

Как BB обрабатывает клавиши (upstream, для сверки с main):

- `UP/apps/app/src/components/commands/AppCommandProvider.tsx:403-433` — `handleKeyboardEvent`: пропускает событие, если `event.defaultPrevented`, IME-композиция или `event.repeat`; ищет совпадение по привязкам; при совпадении вызывает `preventDefault()` и `stopPropagation()`.
- Слушатели: bubble-фаза `window` keydown (`:461`) и отдельный capture-слушатель только для навигации панелями/окнами (`panel.previousTab/nextTab`, `pane.focus.*`, `:441-460`) — эти capture-комбинации плагин перехватить не может.
- Перед ними React-обработчик плагина срабатывает раньше (корень React ниже `window`), поэтому `onKeyDown` + `event.preventDefault()` на своей панели блокирует глобальные команды BB (по условию `defaultPrevented`, `:405`).
- Открытая модалка отключает привязки с `none: modalOpen` (`:103-110`: `[aria-modal="true"]`, `[role="dialog"][data-state="open"]`) — собственный Dialog плагина автоматически гасит глобальные хоткеи.
- Desktop-меню (Electron) шлёт команды по IPC `onAppCommand` (`:468-474`) и обходит DOM-обработчик; их отменить из плагина нельзя.

API плагина для хоткеев:

- `app.commands.register({ id, title, defaultShortcut?, isAvailable?, run })` — `app.d.ts:22329-22356` (`PluginCommandRegistration`), `PluginCommandShortcut` `app.d.ts:22321`. Попадает в палитру Mod+Shift+P и в Settings → Keyboard (ребинд пользователем, ключ `plugin:<plugin-id>/<command-id>`).
- В 0.50.1 (0.6.157) и 0.6.132 `defaultShortcut` должен быть аккордом Command/Control/Alt либо F-клавишей; голая клавиша отвергается при настройке плагина
  (`UP/packages/plugin-sdk/src/internal/plugin-app-registration-collector.ts:282,689-717`). `experimental_keyScope: "pluginPage"` с голыми клавишами (`UP/.../app-contract.ts:4107`, правило `usePluginCommandBindings.ts:37-42`: all `mainSurface, pluginPage`, none `modalOpen, editableFocus`) есть только в main, не в 0.50.1.
  Следствие: стрелки, Tab, Space, Insert, Enter, голые буквы нужно обрабатывать собственным `onKeyDown` на сфокусированном контейнере страницы; F5/F6/F7/F8 можно объявить командами (F-клавиши разрешены).
- Контексты: `currentContext` (`AppCommandProvider.tsx:303-308`) вычисляет `editableFocus`, `terminalFocus`, `browserFocus`, `modalOpen`. Общие (не composer) плагинские команды получают `{ all: [mainSurface], none: [modalOpen] }` — то есть срабатывают и в поле ввода, и, по документации, терминал оставляет себе немодифицированные клавиши и Ctrl+буква (`UP/.../references/frontend-renderer-slots.md:270-273`).
- Composer-команды (`app.composer.experimental_registerCommand`, `app.d.ts:22719`) неактивны при фокусе в терминале/браузере/модалке (`usePluginCommandBindings.ts:33-36`). Commander их не использует, но так видно: плагин, не объявляющий composer-цель, composer не «перехватывает».
- Проверка конфликтов: одинаковые дефолты двух плагинов остаются непривязанными (`app.d.ts:22338` комментарий); пользовательские переопределения переживают reload.

Риск перехвата composer/терминала: страница плагина и фокус терминала — разные DOM-поддеревья; `onKeyDown` на контейнере Commander не видит клавиши из terminal-вкладки и composer. Но команды с модификатором, объявленные через `app.commands.register`, глобальны (`mainSurface`) и сработают при фокусе в composer. Используйте `isAvailable` (синхронно и дёшево) для ограничения контекстом `useBbContext().experimental_pluginPanel` (только main; в 0.6.132 `BbContext` = `{projectId, threadId}`, `app.d.ts:23860`) либо проверкой, что фокус на странице Commander, самим.

## 2. RPC и realtime

- Контракт: `defineRpcContract` (`sdk.d.ts:151`, 27500; runtime-экспорт, `UP/packages/plugin-sdk/src/rpc-contract.ts`). Схемы Standard Schema v1 (zod 4).
- Регистрация: `bb.rpc.register(contract, handlers, { experimental_discoverable?, experimental_description? })` — `sdk.d.ts:20488-20515`; `UP/.../backend-contract.ts:997`. Эндпоинт `POST /api/v1/plugins/<id>/rpc/<method>` (`UP/apps/server/src/routes/plugins.ts:995-1100`). Вход проверяется до хэндлера, выход до сериализации, результат — строго JSON (нет bigint, Uint8Array, class instance, NaN).
  Бинарные данные только base64 в JSON.
- Клиент: `useRpc<typeof contract>().call(method, input)` (`app.d.ts:24042`), `experimental_useRpcQuery/KeyedQuery/Mutation/Refresh` (`app.d.ts:24047`) с тегами и оптимистичными обновлениями; чтения свежие 2 с, без поллинга (`app.d.ts:23945` комментарий).
- Ошибки: коды `invalid_json, invalid_input, handler_error, invalid_output, non_json_result, unknown_method, plugin_not_found, plugin_not_running, invalid_caller, forbidden_origin, unsupported_media_type, ...` (`UP/packages/plugin-sdk/src/rpc-contract.ts:17-36`); отказы `experimental_PluginRpcRefusal {forbidden|not_found|conflict|invalid}`.
- Realtime: `bb.realtime.publish(channel, payload)` (`sdk.d.ts:20516`) — эфемерный `plugin-signal` ВСЕМ подключённым клиентам без подписок по каналам, ничего не хранится (`UP/apps/server/src/ws/hub.ts:1176-1190`; `UP/packages/plugin-sdk/src/internal/host-policy.ts:3199-3219`).
  Фронтенд: `useRealtime(channel, handler)` (`app.d.ts:24071`), `useRealtimeConnectionState()` (`app.d.ts:24078`); после reconnect нужно перечитать состояние (сигналы не повторяются).
  Для Commander: публиковать только инвалидации и прогресс (id задачи, проценты), не содержимое каталогов и не пути (канал виден всем клиентам и не фильтруется).
- Лимиты: явного лимита размера для RPC-тела с фронтенда и для realtime-payload в `routes/plugins.ts` и `hub.ts` не нашёл (`req.text()` без ограничения). Реальные ограничения: серверный запрос `callRpc` отваливается через 75 с (`UP/packages/sdk/src/response.ts:4`), ответ host-RPC ≤8 MiB, вход ≤32 MiB (п.3). Больше ~1–2 MiB в одном JSON не планировать.
- `bb.sdk.plugins.callRpc` и `experimental_discoverRpc` — `sdk.d.ts:18371-18379`.

## 3. Data plane для больших файлов

Что есть:

- `bb.http.route(method, path, handler, { auth })` — `sdk.d.ts:20466-20482`; `UP/.../backend-contract.ts:968`. Монтируется на `/api/v1/plugins/<id>/http/<path>`, ТОЧНОЕ совпадение (`:` и `*` — литералы), хэндлер Hono, может вернуть `Response` со стримом.
  Автор: `local` (по умолчанию: Origin = локальное приложение BB), `token` (`x-bb-plugin-token` или `?token=`), `none`.
  Важное ограничение `local`: мутирующий запрос обязан иметь `content-type: application/json`, иначе 415 (`UP/apps/server/src/browser-request-guard.ts:200-213`) — из браузера нельзя залить бинарное тело `application/octet-stream` на `local`-роут. `token`-токен фронтенду недоступен (он секрет `bb plugin token`).
- `bb.http.experimental_websocket(path, handler, { auth })` — `sdk.d.ts:20484`; сообщения `string | Uint8Array`, закрытие кодом 1012 при reload. Здесь та же авторизация (для браузера нужен `local`).
- Роуты ядра, которыми можно пользоваться напрямую из фронтенда (same-origin fetch), без кода в плагине:
  - `GET /api/v1/hosts/:id/files/<absolute path>` — стрим байтов файла ЛЮБОГО подключённого хоста с Range, ETag и If-None-Match (`UP/packages/server-contract/src/public-api.ts:1031-1036`; `UP/apps/server/src/routes/files.ts` блок `publicApiRoutes.hosts.file`; чанки по 64 KiB через RPC к демону — `UP/packages/host-daemon-contract/src/commands.ts:485`, `HOST_FILE_CHUNK_MAX_BYTES`; `UP/apps/server/src/services/hosts/daemon-file-stream.ts`).
    Подходит для просмотра картинок/видео/pdf и скачивания (`experimental_saveFile({fileName, url})`).
  - `files.createPreview({ hostId?, rootPath, ttlMs? })` → `/api/v1/file-previews/<id>/<relpath>` (TTL 10 мин, `UP/apps/server/src/routes/files.ts:51,328-352`) — безопасный базовый URL для набора связанных файлов.
- Загрузки, выгрузки:
  - `sdk.files.write` — JSON с base64/utf8, не более 25 MiB (`UP/apps/host-daemon/src/command-handlers/file-write.ts:70`; чтение JSON `files.read` ≤25 MiB (изображения 10 MiB), `file-read.ts:21-22`). Атомарность и CAS: `expectedSha256`.
  - Загрузки больше 25 MiB и межхостовое копирование ядро не поддерживает; `packages/file-transfer` (`@bb/file-transfer`) — приватный workspace-пакет, SDK его не экспортирует, а сборка host entry запрещает импорт `@bb/*` (`backend-foundation.md:325-337`).
    Остаётся host entry с собственным кодом: чтение и запись на хосте (Node `fs`), передача кусками через RPC (≤8 MiB на ответ, ≤32 MiB на вход), либо стрим через `core`-роут для чтения.
  - Plugin-уровень стримов к демону нет: «Plugins do not receive daemon streaming or socket primitives; use bounded calls, pagination, and host signals» (`UP/.../references/backend-foundation.md:341-343`).
- Установленный в системе плагин `file-gateway` (навык file-gateway, MCP `bb_file_gateway`) умеет перенос файлов между машинами, но в upstream его нет, его контракт RPC не проверял; как зависимость использовать нельзя без отдельной проверки.

## 4. Хранение

- `bb.storage.kv`: `get/set/delete/list(prefix?)`, значение ≤256 KB (`sdk.d.ts:19824-19830`; проверка `UP/apps/server/src/services/plugins/plugin-api.ts:746`). Хранится в bb.db.
- `bb.storage.database()` — собственный SQLite (better-sqlite3, WAL, busy_timeout 5000) в `<dataDir>/plugins/<id>/data.db` (`sdk.d.ts:19843`); `bb.storage.migrate(db, statements)` append-only (`sdk.d.ts:19850`). Закрывается при reload.
- Каталог файлов плагина `bb.storage.experimental_directory()` — только main (`UP/.../backend-contract.ts:215`), нет в 0.6.132 и 0.50.1. На 0.50.1: хранить в SQLite (BLOB/кеши) либо на хосте в `experimental_paths.dataDir` (host entry, `host.d.ts` блок `ExperimentalHostPaths`), `bb.server.experimental_dataDir` — только чтение (`sdk.d.ts:21434`).
- Секреты: `bb.settings.define({ key: { type: "string", secret: true } })` — файл 0600 в `<dataDir>/plugins/<id>/secrets/`, не в БД и не во фронтенд (`sdk.d.ts:19757-19758`; `useSettings()` секреты исключает, `app.d.ts` комментарий около `useSettings`). Читать только на сервере. Для Commander (SFTP/SSH пароли) секреты по-хостово нужны динамически; settings с `secret` — статические дескрипторы. Динамические креды: kv зашифровать нельзя без ключа, а `makosh-credential-vault` (установлен) — отдельный плагин (см. навык credential-vault).
- Статус: настройки типов `string|number|boolean|select|project` с `experimental_schema` (zod), `onChange` (`UP/.../references/backend-foundation.md:45-110`).

## 5. Процессы

- Host entry (`bb.host` в `package.json`): отдельный Node 22 ESM воркер на каждом хосте (демоне), через типизированный RPC: `experimental_defineHostEntry({ contract, experimental_signals, handlers, dispose })` (`host.d.ts` около строк 120-160; `UP/packages/plugin-sdk/src/host-contract.ts`), клиент `bb.hosts.experimental_client({ contract, experimental_signals })` (`sdk.d.ts:21501,21589`), вызов `host.call(method, input, { hostId, signal, timeoutMs })`.
  - Контекст: `signal` (вызов), `lifecycle.signal` (весь воркер), `experimental_paths.{dataDir,tempDir}`, `experimental_emitSignal`, `experimental_watch` (нативный watcher демона: debounce 10–5000 мс, ≤256 watch на воркер), `experimental_retainWorker()`.
  - Лимиты (`UP/.../references/backend-foundation.md:282-293`): старт ≤10 с, простой 5 мин → стоп, 256 активных вызовов, вход ≤32 MiB, ответ ≤8 MiB, таймаут вызова по умолчанию 30 с (`plugin-api.ts:507,1137`: максимум 30 мин), grace отмены 5 с, `dispose` ≤5 с, артефакт ≤256 MiB.
- `experimental_spawnHostProcess/forkHostProcess/execHostFile/execHostFileCallback/hostToolchain` — `process.d.ts:30-61`; импорт `@get-bb/plugin-sdk/process`. Это тонкая обёртка над `node:child_process` с обновлением PATH и Windows-шимами (`UP/packages/process-utils/src/host-process.ts:31-84`): НЕ управляет временем жизни, не убивает детей.
- Жизненный цикл: воркер запускается `fork(..., { stdio: ["ignore","pipe","pipe","ipc"] })`, не detached; при остановке шлёт `{type:"dispose"}`, через 5 с `child.kill("SIGKILL")` только воркеру (`UP/apps/host-daemon/src/plugin-host-manager.ts:467-478,1000-1015`). Дочерние процессы воркера (helper-бинарь) в группу не включены: при SIGKILL воркера они осиротеют.
  Поэтому helper надо запускать с `{ detached: false }`, убивать в `lifecycle.signal.abort` и `dispose`, а при удалении своих каталогов использовать `experimental_killProcessesWithCwdUnder({ directories })` (`@get-bb/plugin-sdk/host`, `host.d.ts:667`).
  Unhandled: stdout/stderr воркера идут в лог плагина (`bb plugin logs`).
- Helper-бинарь: артефакт хоста — один бандл `dist/host.js`; отдельные нативные бинарники не поставляются. Варианты: вшить в бандл (≤256 MiB, разворачивать в `dataDir`), скачивать при первом запуске (ответственность плагина), использовать системные утилиты с PATH.
- Серверная часть (`bb.server` entry) исполняется в процессе сервера BB, полный доверенный Node: можно `node:child_process`, но жизненный цикл на вас: `bb.background.service(name, { start(signal) })` (restart с backoff, `sdk.d.ts:20525-20546`) и `bb.onDispose(hook)` (LIFO, `sdk.d.ts:21748`).

## 6. Agent tools, CLI, skills

- Инструменты агента: `bb.agents.registerTool({ name, description, instructions?, presentation?, parameters: zod | JSON-schema, execute(params, ctx) })` — `sdk.d.ts:21244`, базовый тип `sdk.d.ts:20731`; `UP/.../backend-contract.ts:1839`. Имя `[a-zA-Z0-9_-]+`, уникально среди плагинов, не из зарезервированных. `ctx` = `{ threadId, projectId, ... }` (`sdk.d.ts:20751`).
  Новые инструменты применяются при следующем старте/возобновлении сессии провайдера. Результат: строка или `{content: [{type:"text"|"image"}], isError}`.
  `bb.agents.configure(cb)` выбирает, какие инструменты и навыки включены в треде (синхронно, ≤256 id) — `sdk.d.ts:21227`; `contributeInstructions` ≤32768 символов — `sdk.d.ts:21262`.
- CLI: `bb.cli.register({ name, summary, commands?, rendersHelp?, run(argv, ctx) })` — `sdk.d.ts:20610-20665`, одна регистрация на фабрику; `ctx` = `{ cwd, threadId, projectId, signal }`; вывод stdout+stderr ограничен `PLUGIN_CLI_OUTPUT_MAX_BYTES` (`sdk.d.ts:20619`). Помощники `defineCli`, `cliCommand`, `PluginCliError` (`sdk.d.ts:27247-27473`).
  Столкновение имён с ядром: плагин остаётся доступен как `bb plugin run <plugin-id>`.
- Навыки: `bb.skills` в манифесте (по умолчанию каталог `skills/`), `skills/<name>/SKILL.md` вливается в треды как навык плагина (`quickstart.md:44-48`). Слэш-команд у плагина нет, «ремесло» для агента оформляется навыком.
- Для Commander: инструмент должен только читать/копировать по явным путям и никогда не исполнять «инструкции из содержимого файла» (данные = не команды). Деструктивные операции агентом — только через подтверждение (`bb.ui.requestInput`, `sdk.d.ts:21390`).

## 7. Редактор и preview

- `useBbNavigate().experimental_openFilePreview({ target, location, opener? })` и `experimental_openFileExternally({ target, location })` — `app.d.ts:23917-23924`; возвращают boolean (принято/отклонено). `useCanOpenFileExternally(target)` (`app.d.ts:24449` область).
- Цель: `ExperimentalLiveFileTarget` — `{ kind: "workspace", environmentId, path, experimental_ref? } | { kind: "host", hostId, path } | { kind: "thread-storage", threadId, path }` (`app.d.ts:23678-23697`). `kind: "host"` с абсолютным путём — это удалённые пути и хосты (в 0.6.132 уже есть).
  `location`: `{kind:"line", line, column}` или `{kind:"range", startLine, endLine}` (`app.d.ts:23699`).
- Встроенный редактор: в 0.50.1 в комплекте `monaco-editor` (`INST/server/dist/builtin-plugins/monaco-editor`), он регистрируется как `fileOpener` и открывает файлы с проверкой CAS через `bb.sdk.files.read/write` (`UP/plugins/monaco-editor/server.ts:28,70,158-209`), включая `hostId`.
  Выбор открывалки по расширению — Settings → Files → File openers; `opener: "<id>"` в `openFilePreview` — только для открывалок ВАШЕГО плагина. Открыть файл именно в Monaco другого плагина программно нельзя (opener ограничен собственными id плагина); пользователь выбирает Monaco по расширению в настройках.
- `fileOpener` (свой просмотрщик): `app.slots.fileOpener` — `app.d.ts:17149,19660`, props `{ path, source: {kind, threadId, environmentId, projectId, experimental_hostId}, experimental_lineRange, Original }`.
- Внешнее открытие: «preferred external target клиента» (локальная ОС пользователя): для удалённого хоста вернёт false/недоступно (`useCanOpenFileExternally`).
- Для Commander F3/F4: `experimental_openFilePreview({ target: {kind:"host", hostId, path}, location: null })`; редактирование — через уже стоящий Monaco (по расширению). Fallback: собственный `fileOpener` или `experimental_FilePreview`/`experimental_SourceCode` + `files.write` с CAS.

## 8. Терминал

- Создание сеанса: `useSdk().terminals.create({ cols, rows, scope, title?, start?, id? })` (`app.d.ts:18575`, args около `:18530-18560`). `scope`: `{kind:"thread", threadId} | {kind:"environment", environmentId} | {kind:"host_path", hostId, cwd: string|null}` — хост явный, серверного дефолта нет.
  Дальше `input({terminalId, dataBase64})`, `output`, `resize`, `rename`, `restart`, `close({mode:"force"|"if-clean"})`.
- Показ во вкладке: `useBbNavigate().experimental_openTerminal({ terminalId })` — `app.d.ts:23931`; Promise<boolean>. Страница плагина принимает любой терминал, тред-поверхность только терминалы своего треда, закрытие вкладки закрывает терминал.
- Для Commander («Ctrl+O/открыть терминал здесь»): `terminals.create({scope:{kind:"host_path", hostId, cwd: активная_панель}})` → `experimental_openTerminal`. Для локальных сессий хост = `primaryHostId` из `sdk.system.config()`.

## 9. Mentions, связь с тредом, хосты и окружения

- Контекст UI: `useBbContext()` → `{ projectId, threadId }` (`app.d.ts:23860,24105`; в main добавлен `experimental_pluginPanel`). У страницы плагина нет неявного проекта или треда. Тред-вкладка получает `{ threadId, environment: {id}|null }`.
- Команды палитры получают `{ threadId, projectId }` + `navigate`, `panel`, `composer`, `sdk`, `threadRequests` (`PluginCommandContext`, `app.d.ts:24908`).
- Хосты и окружения: `sdk.hosts.list/get/directory/pathsExist/pickFolder` (`sdk.d.ts:17969-17984`), `sdk.environments.list({hostId, projectId, path...})/get/paths` (`sdk.d.ts:17760-17800`), `sdk.threads.get` → `environmentId`/`hostId`, `threads.storageLocation` (`sdk.d.ts:19342`).
  `hosts.directory({hostId, path?})` возвращает только `{directory, parent, entries:[{kind,name,path}], roots}` — без размера, времени, прав, признака симлинка (`UP/packages/host-daemon-contract/src/commands.ts:737-750`). `files.listPaths` — рекурсивный нечёткий список относительных путей (не листинг каталога).
- Файловые операции на хосте доступны ФРОНТЕНДУ напрямую: `useSdk().files` = `read, write, list, listPaths, mkdir, move, remove, createPreview` (`app.d.ts` тип `PluginBrowserBbSdk` `:20606`; `FilesArea` `sdk.d.ts:17866-17876`), `hostId` необязателен (по умолчанию локальный хост сервера), `rootPath` — ограничение корнем, `move` не перезаписывает существующую цель, `remove` для непустых каталогов требует `recursive: true`.
  Нет: stat, chmod/chown, copy, rename-с-overwrite, симлинки, трэш, du, hash больших файлов.
- Mentions (упоминания в composer): серверно `bb.ui.registerMentionProvider({id, label, triggers, search, resolve})` (`sdk.d.ts:21401`; search time-box 2 с; resolve выполняется при отправке и может блокировать отправку). Для передачи файла агенту из Commander: `useComposer().insert([...parts])` / `useComposers()` (`app.d.ts:24174`; insert принимает mention kind `path`) либо провайдер упоминаний.
- `sdk.threads.spawn({projectId, environment, prompt, pluginMetadata, visibility})` — запуск агента по выбранным файлам (origin = "plugin", id плагина проставляется).

## 10. Межплагинный вызов и идентификация вызывающего

- `bb.sdk.plugins.callRpc({ pluginId, method, input, outputSchema })` — `sdk.d.ts:18379`; таймаут 75 с (`UP/packages/sdk/src/response.ts:4`).
- Вызываемый плагин получает вторым аргументом хэндлера `{ experimental_caller, experimental_signal }`: `experimental_caller` = `{kind:"plugin", pluginId} | {kind:"client"}` (`sdk.d.ts:160-176`; `UP/packages/plugin-sdk/src/rpc-contract.ts:288-294`).
- Идентификация проверяемая: каждому загруженному плагину выдаётся одноразовый токен (32 байта random), сервер сопоставляет `x-bb-plugin-caller` с pluginId (`UP/apps/server/src/services/plugins/plugin-rpc-caller.ts:10,29-45`); неизвестный токен → 403 `invalid_caller` (`UP/apps/server/src/routes/plugins.ts:1008-1018`). В установленном 0.50.1 механизм есть (`INST/server/dist/start-server.js:192608-192641,218126-218133`).
  Клиентский вызов (фронтенд, CLI, агенты, сам BB) всегда `{kind:"client"}`: отличить UI Commander от другого клиента или агента нельзя. Для привилегированных RPC Commander проверяйте `caller.kind === "plugin" && caller.pluginId === "<id>"` и бросайте `experimental_PluginRpcRefusal({code:"forbidden"})`.
- Плагин является полностью доверенным серверным кодом: «Namespace IDs are not ownership or authorization boundaries» (`backend-sdk.md`), поэтому проверка caller — гигиена, не граница безопасности.

## 11. Жизненный цикл

- `bb.onDispose(hook)` — LIFO (`sdk.d.ts:21748`); `bb.onInstall(handler)` — один раз после установки (`sdk.d.ts:21758`).
- Reload: фабрика выполняется на кандидате; при падении остаётся предыдущая регистрация. После успеха старое поколение гасится: WebSocket закрываются кодом 1012, `ctx.signal` CLI и `experimental_signal` RPC абортятся, host-воркеры останавливаются, сервисы получают сигнал и до 5 с на остановку (зависший помечает плагин degraded), hooks dispose, затем 5 с на завершение in-flight HTTP/RPC/CLI/событий; дальше ожидающие вызывающие получают ошибку, а сам хэндлер продолжает работать, пока сам не остановится по сигналу (`UP/.../references/backend-ui-lifecycle.md:90-115`).
  Disable, удаление, выключение сервера идут той же последовательностью.
- Долгие задачи: сервер не хранит и не возобновляет фоновые операции плагина — после reload/restart задача либо оборвана, либо осиротела. Нужны: контрольные точки в SQLite, идемпотентные шаги, `bb.background.service`, опрос статуса RPC (задачи >75 с оформлять как job + polling, `backend-sdk.md`).
  Host-вызов: `host.call(..., { signal, timeoutMs ≤ 30 мин })`; воркер хоста умирает по idle (5 мин) если нет активного вызова, watch или `experimental_retainWorker()` lease. Краш воркера → `experimental_onWorkerExit` (после ручного reconnect надо пересинхронизироваться).
- Frontend: бандл с `signal`/контент-скриптами: старое поколение сначала аборт и dispose, потом новое; slot-компоненты при выгрузке страницы эффектами очистки не освобождаются, поэтому сохраняйте состояние по мере изменения.

## Список experimental_*, нужных Commander, ограничения и fallback

| Символ | Источник (0.6.132) | Ограничения | Fallback |
|---|---|---|---|
| `app.slots.experimental_tab` | `app.d.ts:22592` | вкладки только в thread и nav-panel контекстах | страница `navPanel` без вкладки; панель как `experimental_appOverlay` |
| `experimental_useAppPanel` / `ExperimentalPanelController` | `app.d.ts:24149,23776` | boolean вместо исключений | проверять результат, показывать свой UI |
| `experimental_useFixedTabTarget`, `experimental_target` | `app.d.ts:24159,19998` | цель живёт сессию, не перечитывается из БД | хранить в kv/URL subPath |
| `experimental_sidebar` (navPanel) | `app.d.ts:20057` | Escape = Back to app | отдельное дерево внутри страницы |
| `experimental_usePageTitle`, `experimental_useBadge` | `app.d.ts:20065` | badge: count XOR text (≤8), `label` обязателен | не показывать |
| `experimental_hideFromNavigation`, `experimental_headerTitle` | нет в d.ts, есть в 0.6.157 | типов нет | приведение типов `as never`, либо опустить |
| `experimental_openFilePreview` / `openFileExternally` | `app.d.ts:23917-23924` | boolean; opener только свой; внешнее открытие локально для клиента | `experimental_FilePreview`, свой `fileOpener` |
| `experimental_openTerminal` | `app.d.ts:23931` | терминал должен существовать; закрытие вкладки = закрытие терминала | сеанс через `terminals.create` + свой вывод |
| `experimental_FileLink`, `experimental_SourceCode`, `experimental_Diff`, `experimental_FilePreview` | `app.d.ts:24458,24510` | только live-цели | собственный рендер |
| `experimental_saveFile` | `app.d.ts:24440` | URL должен быть на сервере BB; «started» ≠ завершено | `<a download>` на роут ядра |
| `experimental_copyToClipboard` | `app.d.ts:24427` | возвращает boolean | показать тост об отказе |
| `experimental_useRpcQuery/KeyedQuery/Mutation/Refresh` | `app.d.ts:24047-24056` | свежесть 2 с без поллинга | `useRpc().call` + `useRealtime` |
| `experimental_caller` / `experimental_signal` (RPC context) | `sdk.d.ts:168-176` | `client` неразличим | токен-квитанция внутри плагина |
| `experimental_PluginRpcRefusal` | `sdk.d.ts` (export) | коды forbidden, not_found, conflict, invalid | обычный throw |
| `bb.http.experimental_websocket` | `sdk.d.ts:20484` | авторизация как у HTTP; браузеру нужен `local` | SSE/длинный poll через `bb.http.route` |
| `bb.hosts.experimental_client`, `experimental_defineHostEntry`, `experimental_watch`, `experimental_retainWorker`, `experimental_onWorkerExit`, `experimental_signals` | `sdk.d.ts:21501,21589`; `host.d.ts` | лимиты п.5; воркер на хост | только `sdk.files` (без stat) |
| `experimental_spawnHostProcess` и др. | `process.d.ts:61` | нет управления временем жизни | свой реестр процессов, kill в dispose |
| `experimental_killProcessesWithCwdUnder` | `host.d.ts:667` | SIGTERM/SIGKILL процессов по cwd | вручную по PID |
| `experimental_appOverlay` | `app.d.ts:22583` | без chrome и фокуса от хоста | Dialog внутри страницы |
| `experimental_newThreadPanelAction` | `app.d.ts:22594` | только корневой экран | — |
| `bb.storage.experimental_directory` | нет в 0.6.132 и 0.50.1 | main only | SQLite или host `dataDir` |
| `bb.ui.registerMentionProvider` (не experimental) | `sdk.d.ts:21401` | 2 с, resolve блокирует отправку | `useComposer().insert` |
| `PluginCommandRegistration.experimental_keyScope` | нет в 0.6.132 и 0.50.1 | main only | собственный `onKeyDown`, F-клавиши как команды |
| `experimental_useCommandShortcut`, `experimental_matchesShortcutKey` | main only | — | свои подсказки, `event.code` |

## Пробелы SDK и минимальные предложения для ядра

1. Нет метаданных каталога (размер, mtime, mode, симлинк, owner) в `hosts.directory`/`files.*`. Предложение: расширить `directoryEntrySchema` (`UP/packages/host-daemon-contract/src/commands.ts:737-743`) опциональными `sizeBytes, modifiedAtMs, mode, isSymlink` либо добавить `host.stat`/`host.list_dir` (контракт демона и `FilesArea`).
2. Нет copy и overwrite-move, нет chmod. Предложение: `host.copy_path` и флаг `overwrite` в `host.move_path` (`commands.ts:577-585`).
3. Нет потоковой загрузки больших файлов: `files.write` ≤25 MiB base64 (`file-write.ts:70`), `local`-HTTP отвергает не-JSON тела (`browser-request-guard.ts:200-213`). Предложение: роут ядра `PUT /api/v1/hosts/:id/files/<path>` по образцу существующего GET (`public-api.ts:1031`) с Range/If-Match и чанками демона, либо опция `auth: "local"` с `allowBinaryBody`.
4. Нет стримов и сокетов к демону для плагинов (`backend-foundation.md:341-343`). Предложение: `ExperimentalHostRpcContext.experimental_openStream` либо ограничение 8 MiB ответа поднять и дать стрим-метод в контракте.
5. Плагин не знает свою страницу как «сфокусированную» и не может объявить голые клавиши в 0.50.1. Предложение: бэкпорт `experimental_keyScope: "pluginPage"` (main: `app-contract.ts:4107`) в SDK 0.6.157+ релиз BB.
6. `useBbContext().experimental_pluginPanel` и `experimental_useCommandShortcut` — также main only; нужен релиз BB с SDK >= актуального main.
7. Нет `bb.storage.experimental_directory()` в 0.50.1 для файловых артефактов сервера. Предложение: релиз с main.
8. Время жизни дочерних процессов воркера: SIGKILL убивает только воркер. Предложение: запускать воркер в отдельной process group (`detached: true`) и убивать группу в `stopWorker` (`plugin-host-manager.ts:1011-1014`).
9. Идентификация клиента: `experimental_caller.kind="client"` не отличает UI конкретного плагина от других клиентов. Предложение: подписанный заголовок `x-bb-plugin-origin` для запросов из бандла плагина, выдаваемый хостом.
10. Realtime без фильтрации по каналу и без размера: публикуется всем клиентам (`hub.ts:1176-1190`). Предложение: серверная подписка `useRealtime(channel)` с ACL или лимит payload.
11. `experimental_openFilePreview({ opener })` принимает только открывалки собственного плагина. Предложение: разрешить `opener: "<pluginId>/<openerId>"` для явного «открыть в Monaco».
12. Нет единой точки «запустить фоновую задачу, пережившую reload». Предложение: `bb.background.experimental_job` с персистентным состоянием.

## Что осталось непроверенным

- Версия React в установленном 0.50.1 (в main 19.3.1).
- Явный лимит размера RPC-тела с фронтенда и размера realtime-сообщения: в `routes/plugins.ts` и `hub.ts` ограничений не нашёл, в рантайме не мерил.
- Внутренности `file-gateway` (не входит в upstream).
- Работа клавиш внутри нативных меню Electron (Desktop-приложение) — только по коду `onAppCommand`.
- Все утверждения о 0.50.1 выведены из grep по собранному бандлу `INST`, живой запуск не выполнялся.
