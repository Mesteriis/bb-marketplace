# MCP Каталог — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** плагин BB «MCP Каталог»: поиск MCP-серверов в официальном реестре, проверка агентом, коллекция принятых серверов в `bb-marketplace`, установка из неё на мост Agent Plugins и управление всеми серверами моста с одного экрана.

**Architecture:** новый плагин `plugins/mcp-catalog` по правилам `docs/architecture.md`: чистое ядро (`src/core`, zod-схемы, порты), UI на props (`src/ui`), адаптеры BB (`src/adapters/bb`: CLI `bb agent-plugins`, git, файлы, реестр, треды). Мост не меняется, кроме команды `enable|disable` в форке `plugins/agent-plugins`.

**Tech Stack:** TypeScript, React 19, zod 4, vitest, `@get-bb/plugin-sdk` 0.6.132 (как в `plugins/navigation`), `bb plugin build`.

**Spec:** `docs/superpowers/specs/2026-11-26-mcp-catalog-design.md` (копия из хранилища треда кладётся в ветку в задаче 0).

## Global Constraints

- Имена по `docs/architecture.md`: папка `plugins/mcp-catalog`, пакет `bb-plugin-makosh-mcp-catalog`, id `makosh-mcp-catalog`, запись коллекции `.bb/plugins.json` — `mcp-catalog`, тег `mcp-catalog/vX.Y.Z`.
- `engines`: `bb >=0.49`, `bbPluginSdk >=0.6.132`; зависимости и `devDependencies` — как у `plugins/navigation`.
- `src/core` и `src/ui` без `@get-bb/*`, `node:*`; `tests/architecture.test.ts` скопирован из `navigation`.
- Все тексты интерфейса, отчётов и сообщений об ошибках — по-русски.
- Секрет никогда не попадает в git, логи, снапшоты RPC, фронтенд и повторный показ формы.
- Версии закреплены: npm `пакет@X.Y.Z`, PyPI `пакет==X.Y.Z`, Docker `образ@sha256:…`; «latest» и диапазоны отклоняются.
- Ставить можно только запись из `origin/main:mcp-collection/` с совпадающим `serverJsonSha256`.
- Коллекция: `mcp-collection/<name>/{server.json,review.md,entry.json}` и `mcp-collection/index.json`.
- Данные каталога: пакеты `<dataDir>/packages/<name>/`, ключи `<dataDir>/env/<name>.env` (0600).
- После каждого изменения: `npm run check`; перед «готово»: `npm run build` и `node ../../scripts/check-manifests.mjs`.
- Коммиты — в ветке `feat/mcp-catalog` рабочего дерева; слияние и push в `main` — только по слову владельца.

## Review Focus

1. Запись реестра с несколькими `packages` или без версии — каталог не угадывает: агент проверки выбирает одну, генератор отклоняет незакреплённую версию (тест в задаче 3).
2. Нет `npx`/`uvx`/`docker` в PATH процесса BB — понятная ошибка до установки, без попытки поставить (тест в задаче 6).
3. Повторная установка или правка ключей — форма показывает «задано», пустое поле не стирает значение (тест в задаче 5).
4. Грязная основная копия `bb-main` или не `main` при «Принять» — отказ с причиной, ничего не коммитится (тест в задаче 7).
5. Имя сервера совпадает с уже стоящим пакетом из infra — установка отказывает, а не перезаписывает (тест в задаче 5).

---

### Task 0: Рабочее дерево и документы

**Files:**
- Create: `docs/superpowers/specs/2026-11-26-mcp-catalog-design.md`, `docs/superpowers/plans/2026-11-26-mcp-catalog.md` (копии черновиков, подготовленных вне репозитория)

- [ ] **Step 1:** создать рабочее дерево `bb-main` на ветке `feat/mcp-catalog` от `origin/main` (навык `superpowers:using-git-worktrees`).
- [ ] **Step 2:** скопировать оба документа, закоммитить: `docs: MCP catalog design and plan`.

### Task 1: Команда `enable|disable` в мосте

**Files:**
- Modify: `plugins/agent-plugins/server.ts` (список `commands` у `bb.cli.register` около строки 1196; обработчик рядом с `approve` около строки 1339)
- Test: `plugins/agent-plugins/src/server.test.ts`

**Interfaces:**
- Produces: `bb agent-plugins enable <id> <serverId> [--json]` и `disable …` → stdout JSON `{"enabled": boolean, "status": string, "lastError": string|null}`, код 0; без аргументов — код 2 и `Usage: bb agent-plugins enable|disable <id> <serverId> [--json]`; ошибка `setMcpEnabled` — код 1 и текст ошибки в stderr.

- [ ] **Step 1: тест** `it("disables and enables an MCP server from the CLI")`: поставить фикстурный пакет как в тесте idle-stop (строка 140), вызвать CLI `disable <id> docs --json` через харнесс, ожидать `{enabled:false}` и `snapshot.mcpServers[0].enabled === false`; затем `enable` → `true`. Второй тест: `disable` без `serverId` → `exitCode 2`.
- [ ] **Step 2:** `npm run check` в `plugins/agent-plugins` — FAIL.
- [ ] **Step 3:** две записи в `commands` и обработчики, вызывающие существующую `setMcpEnabled(id, serverId, enabled)`.
- [ ] **Step 4:** `npm run check` — PASS; `npm run build`.
- [ ] **Step 5:** README моста: строка про `enable|disable` в разделе CLI; `LOCAL_FORK.md`: пункт «локальное изменение: CLI enable/disable, предложено апстриму». Коммит `agent-plugins: CLI enable/disable for one MCP server`.

### Task 2: Каркас плагина и модель реестра

**Files:**
- Create: `plugins/mcp-catalog/{package.json,tsconfig.json,vitest.config.mts,PLUGIN_OVERVIEW.md,server.ts,app.tsx}`, `components/`, `lib/` (скопировать из `plugins/navigation`), `tests/architecture.test.ts` (копия), `src/core/registry.ts`, `src/core/registry.test.ts`
- Modify: `.bb/plugins.json`, `marketplace.json`, README-таблица плагинов

**Interfaces:**
- Produces (`src/core/registry.ts`):
  - `RegistryServer` (zod) — подмножество `server.json` 2025-10-17: `name`, `description`, `version`, `websiteUrl?`, `repository?{url,source}`, `packages?[{registryType:"npm"|"pypi"|"oci", identifier, version?, transport:{type}, environmentVariables?[{name,description?,isRequired?,isSecret?,default?}], packageArguments?[…]}]`, `remotes?[{type:"streamable-http"|"sse", url, headers?[…]}]`; неизвестные поля сохраняются (`passthrough`).
  - `interface RegistryPort { search(query: string, cursor?: string): Promise<{ servers: RegistryServer[]; nextCursor?: string }> }`
  - `parseRegistryPage(json: unknown): { servers: RegistryServer[]; nextCursor?: string }` — берёт `servers[].server` и `metadata.nextCursor`, битые записи пропускает.

- [ ] **Step 1: тест** `parseRegistryPage` на фикстуре из реального ответа (`v0/servers?search=github&limit=2`, сохранить в `src/core/fixtures/registry-page.json`): 2 сервера, `nextCursor` = значение из фикстуры; запись без `name` пропущена.
- [ ] **Step 2:** FAIL. **Step 3:** реализация. **Step 4:** `npm run check` PASS, `node ../../scripts/check-manifests.mjs` PASS.
- [ ] **Step 5:** коммит `mcp-catalog: plugin skeleton and registry model`.

### Task 3: Генератор пакета моста

**Files:**
- Create: `src/core/package-gen.ts`, `src/core/package-gen.test.ts`, `src/core/shim.ts` (текст шима как строка; источник — шим `legacy-stdio-shim.py` из пакетов MCP в репозитории инфраструктуры владельца, внести в `THIRD_PARTY_NOTICES.md` не нужно — код владельца)

**Interfaces:**
- Consumes: `RegistryServer`.
- Produces:
  - `CollectionEntry` (zod, `src/core/collection.ts` — создать здесь): `{ name: string; version: string; serverJsonSha256: string; choice: { kind:"package"; index:number } | { kind:"remote"; index:number }; ociDigest?: string; notes?: string[]; acceptedAt: string }`
  - `generatePackage(server: RegistryServer, entry: CollectionEntry, paths: { envFile: string }): Record<string, string>` — ключи: `plugin.json`, `mcp.json`, `bin/run.sh`, `bin/shim.py`; для remote — только `plugin.json` и `mcp.json` с `{"type":"streamable-http","url":…}`.
  - Команды запуска: npm → `npx -y <id>@<version>`; pypi → `uvx <id>==<version>`; oci → `docker run --rm -i <id>@<ociDigest>`; `run.sh` начинается с `set -a; . "<envFile>"; set +a` и запускает через `python3 bin/shim.py`.
  - Ошибки (`throw new Error`, тексты по-русски): версия пустая, `latest` или содержит `^~*<>| `; oci без `ociDigest`; remote с секретным заголовком (`headers[].isSecret`) — «удалённые адреса с секретными заголовками пока не поддерживаются».

- [ ] **Step 1: тесты** `generates npm launcher pinned to version`, `generates uvx launcher`, `generates docker launcher pinned to digest`, `remote without secret headers has no launcher`, `rejects latest and ranges`, `rejects oci without digest`, `rejects remote with secret header`; в каждом — точные строки команды из списка выше.
- [ ] **Step 2–4:** FAIL → реализация → PASS. **Step 5:** коммит.

### Task 4: Коллекция и её проверка

**Files:**
- Create: `src/core/collection.ts` (дополнить), `src/core/collection.test.ts`
- Modify: `scripts/check-manifests.mjs` (проверка `mcp-collection/index.json`)

**Interfaces:**
- Produces:
  - `CollectionIndex` (zod): `{ servers: Array<{ name: string; version: string; path: string }> }`
  - `interface CollectionPort { readIndex(): Promise<CollectionIndex>; readFile(path: string): Promise<string> }` — читает **только** `origin/main` после `fetch`.
  - `loadAcceptedEntry(port: CollectionPort, name: string): Promise<{ server: RegistryServer; entry: CollectionEntry; review: string }>` — проверяет `sha256(server.json) === entry.serverJsonSha256`, иначе ошибка «запись коллекции повреждена: хэш server.json не совпадает».
  - `sha256Hex(text: string): Promise<string>` через `crypto.subtle` (без `node:`).

- [ ] **Step 1: тесты** с фейковым `CollectionPort`: верная запись загружается; изменённый `server.json` → ошибка с этим текстом; имени нет в индексе → «сервера нет в коллекции».
- [ ] **Step 2:** в `check-manifests.mjs`: у каждой записи индекса есть три файла, `entry.json` валиден, хэш совпадает. Тест-фикстура в `scripts/` не нужна — проверка на пустой коллекции проходит.
- [ ] **Step 3–4:** реализация, `npm run check` и `check-manifests` PASS. **Step 5:** коммит.

### Task 5: Стоящие серверы и установка

**Files:**
- Create: `src/core/inventory.ts`, `src/core/install.ts`, тесты рядом

**Interfaces:**
- Produces:
  - `interface BridgePort { list(): Promise<BridgePlugin[]>; show(id: string): Promise<{ mcpServers: BridgeServer[] }>; install(path: string): Promise<{ id: string }>; update(id: string): Promise<void>; remove(id: string): Promise<void>; approve(id: string, serverId: string): Promise<void>; auth(id: string, serverId: string): Promise<{ url?: string }>; setEnabled(id: string, serverId: string, enabled: boolean): Promise<void> }` — `BridgePlugin`/`BridgeServer` повторяют поля `bb agent-plugins list|show --json` (`id,name,sourceIntent,status,lastError`; `serverId,type,status,lastError,approved,enabled`).
  - `interface SecretsPort { state(name: string): Promise<Record<string, "set"|"missing">>; write(name: string, values: Record<string,string>): Promise<void>; remove(name: string): Promise<void> }` — `write` с пустой строкой оставляет прежнее значение.
  - `interface PackagesPort { write(name: string, files: Record<string,string>): Promise<string /*dir*/>; remove(name: string): Promise<void> }`
  - `buildInventory(plugins, servers, catalogRoot: string): InventoryRow[]` — `InventoryRow = { pluginId, pluginName, serverId, status, enabled, approved, origin: "catalog"|"infra"|"other", lastError }`; `origin` по `sourceIntent` (`path:<catalogRoot>/packages/` → catalog, `path:` с `/bb-mcp-packages/` → infra).
  - `installFromCollection(deps, name, values): Promise<{ pluginId: string; needsApproval: true }>` — `loadAcceptedEntry` → проверка, что имени нет среди стоящих (иначе «сервер с таким именем уже стоит») → `secrets.write` → `generatePackage` → `packages.write` → `bridge.install`.
  - `removeCatalogServer(deps, row)` — только `origin==="catalog"`: `bridge.remove`, `packages.remove`, `secrets.remove`.
  - `updateFromCollection(deps, row)` — для `origin==="catalog"`, когда версия в коллекции новее стоящей: `loadAcceptedEntry` → `generatePackage` → `packages.write` → `bridge.update(row.pluginId)`; ключи не трогаются. В инвентаре строка получает `updateAvailable: string | null` (версия из коллекции).

- [ ] **Step 1: тесты** (фейковые порты): инвентарь помечает три происхождения; `updateFromCollection` перегенерирует пакет и вызывает `bridge.update`, не трогая `secrets`; установка вызывает порты в указанном порядке; повтор с пустым значением не стирает ключ; имя занято пакетом infra → ошибка, `bridge.install` не вызван; удаление infra-строки → ошибка «серверы из infra удаляются в infra».
- [ ] **Step 2–4:** FAIL → реализация → PASS. **Step 5:** коммит.

### Task 6: Адаптеры BB

**Files:**
- Create: `src/adapters/bb/bridge-cli.ts`, `env-files.ts`, `packages-dir.ts`, `registry-http.ts`, `collection-git.ts`, `launchers.ts`, тесты рядом

**Interfaces:**
- Produces реализации портов задач 2–5 и:
  - `checkLaunchers(kind: "npm"|"pypi"|"oci"): Promise<{ ok: true; path: string } | { ok: false; message: string }>` — ищет `npx`/`uvx`/`docker` в `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, каталогах `mise` и `PATH`; сообщение «не найден npx: поставьте Node.js» и т. п.
  - `bridge-cli.ts` — `execFile("bb", ["agent-plugins", …, "--json"])`, разбор JSON, ненулевой код → ошибка с stderr.
  - `env-files.ts` — `KEY=value` с экранированием, `chmod 0600`, атомарная запись через временный файл.
  - `collection-git.ts` — `git -C <repo> fetch origin main` и `git show origin/main:<path>`.

- [ ] **Step 1: тесты:** `env-files` создаёт файл 0600 и не теряет старый ключ при пустом значении; `bridge-cli` разбирает фикстуры вывода `list --json` и `show --json` (взять реальные, без секретов) и превращает код 1 в ошибку; `checkLaunchers` с подменённым списком каталогов возвращает `ok:false` и русское сообщение.
- [ ] **Step 2–4:** FAIL → реализация → PASS. **Step 5:** коммит.

### Task 7: Проверка и принятие в коллекцию

**Files:**
- Create: `src/core/review.ts`, `src/core/review.test.ts`, `src/adapters/bb/review-threads.ts`, `src/adapters/bb/collection-write.ts`, тесты

**Interfaces:**
- Produces:
  - `ReviewRecord = { name: string; version: string; branch: string; threadId: string; state: "reviewing"|"ready"|"failed"|"accepted"|"rejected"; error?: string }` (хранится в `bb.storage`).
  - `reviewPrompt(server: RegistryServer): string` — фиксированный русский текст: скачать закреплённую версию в пустую папку вне рабочего дерева, код не запускать, проверить по чек-листу `external-agent-pack-audit`, записать `mcp-collection/<name>/server.json`, `review.md`, черновик `entry.json` (с `choice`, `ociDigest` для oci, `serverJsonSha256`) и ничего не коммитить.
  - `interface ThreadsPort { spawnReview(prompt: string, branch: string): Promise<string /*threadId*/>; status(threadId: string): Promise<"running"|"done"|"failed"> }` — адаптер: `bb.sdk.threads.spawn` (проект `bb-main`, провайдер `claude-code`, модель `sonnet`, новое рабочее дерево на `branch`); если в серверном SDK нет `threads.spawn`, — CLI `bb thread spawn`.
  - `interface CollectionWritePort { branchHasEntry(branch, name): Promise<boolean>; accept(branch, name): Promise<void>; reject(branch): Promise<void> }` — `accept`: в рабочем дереве ветки `git add mcp-collection/<name>` и дописать индекс, коммит `mcp-collection: accept <name> <version>`; основная копия: проверить `main` и чистоту, `git merge --ff-only`/`--no-ff` ветки, `git push origin main`; при грязной копии или другой ветке — ошибка «основная копия bb-main не на main или с незакоммиченными правками», ничего не делать.
  - `advanceReview(rec, threads, write): Promise<ReviewRecord>` — `reviewing` → `ready` (тред done и `branchHasEntry`) / `failed` (тред failed или файлов нет).

- [ ] **Step 1: тесты** `advanceReview` для трёх исходов; `accept` с грязной копией (временный git-репозиторий в тесте адаптера) — ошибка и ни одного нового коммита в `main`; `reviewPrompt` содержит «код сервера не запускай» и имя с версией.
- [ ] **Step 2–4:** FAIL → реализация → PASS. **Step 5:** коммит.

### Task 8: RPC, экран и проверка в браузере

**Files:**
- Create: `src/core/contract.ts` (zod-схемы RPC), `src/ui/catalog-page.tsx`, `src/ui/installed-tab.tsx`, `collection-tab.tsx`, `search-tab.tsx`, `install-dialog.tsx`, `src/ui/catalog.css`, тесты UI
- Modify: `server.ts`, `app.tsx`, `PLUGIN_OVERVIEW.md`, `marketplace.json`

**Interfaces:**
- Produces RPC (`server.ts`, `bb.rpc.register`): `inventory()`, `setEnabled({pluginId,serverId,enabled})`, `approve`, `auth`, `remove({pluginId})`, `collection()`, `search({query,cursor?})`, `startReview({name,version})`, `reviews()`, `accept({name})`, `reject({name})`, `install({name,values})`, `secretsState({name})`. Ни один ответ не содержит значений секретов.
- Страница в боковой панели «MCP Каталог», иконка `Plug`; вкладки «Стоящие», «Коллекция», «Поиск»; кнопка «Обновить»; состояния загрузки, пусто, ошибка.

- [ ] **Step 1: тесты UI** (`@testing-library/react`): строка infra без кнопки «Удалить»; форма установки показывает «задано» для заданного секрета и пустое поле; поиск рисует «уже стоит» и «в коллекции».
- [ ] **Step 2–4:** FAIL → реализация → PASS; `npm run build`.
- [ ] **Step 5:** поставить локально `bb plugin install ./plugins/mcp-catalog --yes` в отдельной копии BB (`~/.bb-test`), открыть страницу через `bb browser-automation` на 1280 и 1440 px, проверить три вкладки, пустые и ошибочные состояния. Коммит.

### Task 9: Сквозная проверка и выпуск

- [ ] **Step 1:** в тестовой копии BB: найти в реестре небольшой сервер (например, официальный `io.github.modelcontextprotocol/time` или аналог на npm без ключей), «Проверить» → тред создан, отчёт готов → «Принять» в тестовой ветке (без push: `accept` с флагом `dryRun` адаптера для теста) → «Поставить» → сервер на мосту → «Одобрить» → `bb agent-plugins tools --server <name>` видит инструменты → через 10 минут статус `idle`.
- [ ] **Step 2:** `npm run check`, `npm run build`, `check-manifests` — PASS; README плагина и `PLUGIN_OVERVIEW.md` по-русски описывают текущее поведение.
- [ ] **Step 3:** показать владельцу итог и дифф; слияние в `main`, push и тег `mcp-catalog/v0.1.0` — только по его слову.
