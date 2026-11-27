# Контракт Remote Hub для Commander (SFTP): исследование и предложение

Только чтение. Пути относительно `plugins/remote-hub` (id в package.json: `bb-plugin-makosh-remote-hub`, версия 0.1.0, SDK 0.6.132). Id плагина Commander: `makosh-commander`. Перед реализацией проверить фактический id Remote Hub в BB (`bb plugin list`): в package.json лежит имя пакета, а id, под которым BB зовёт плагин, может отличаться.

## 1. Текущая модель

### Профиль
- `src/core/profile.ts:71-137` `profileFieldsSchema` (strict, секретов нет): name, protocol (`ssh|rdp|pve`), group, tags, favorite, color, host, port (null = по умолчанию), username, domain (RDP), authType (`agent|key|password|token`), identityFile (абсолютный путь, не ключ), credentialRef, rdpWidth/Height, rdpOptions, pveTrust.
- `src/core/profile.ts:163-182` `profileSchema` добавляет: id (uuid), executionHostId (`local`), origin (`manual|imported`), createdAt/updatedAt, lastOpenedAt, recentErrors (только коды), provenance (источник импорта), needsConfig.
- `needsConfig` означает, что импортированный алиас идёт через ProxyJump, Match и т.п. Для такого профиля секрет сохранить нельзя (`src/core/credential.ts:164-167`).
- Хранение: SQLite плагина, явные колонки без JSON-блоба (`src/adapters/bb/profile-sqlite.ts:1-6`, `:12-37`).

### Credential reference и секреты
- Ссылка: `rh-cred:v1:<executionHostId>:<uuid>` (`src/core/credential.ts:169`). Метаданные (`credentialMetaSchema`, `:20-30`): ref, kind (`password|passphrase`), label, bind. В SQLite лежат только метаданные и ссылка.
- Сам секрет лежит в macOS Keychain, service `remote-hub`, account = ref (`helper/src/keychain.rs:19-27`). Внутри элемента хранится конверт `{magic, v, bind, secret}` (`:85-98`, `:156-170`). Элемент без bind не используется (`Unbound`, `:44`).
- Bind (`helper/src/binding.rs:10-30`): `endpoint {protocol, host, port, user, domain, certFingerprint}` или `key {path}`. Helper сам сверяет bind с целью соединения, TS-проверка не единственная (`binding.rs:1-6`).
- Только helper читает секрет обратно. TS-сторона секрет сохраняет и удаляет, но не получает (`credential.ts:1-4`, `keychain.rs:3-5`). Секрет не попадает ни в RPC-ответ, ни в лог, ни в аудит, ни в строку профиля (`docs/security.md:3-6`).
- Keychain-операции идут в коротком дочернем процессе `--keychain-op`, секрет передаётся по stdin-пайпу, интерактив Keychain отключён (`helper/src/ipc.rs:264-287`, `keychain.rs:5-9`). Plaintext-фолбэка нет.
- Владелец вручную выдаёт доступ через "Allow access" (`ipc.rs:289-`; RPC `credential_allow`, `rpc-handlers.ts:276-281`).

### Как helper получает секрет для SSH (askpass)
- Сессия со сохранённым секретом: `-F none`, `PreferredAuthentications=password` или `publickey`, `NumberOfPasswordPrompts=2`. Для ключа ещё `-i`, `IdentitiesOnly=yes`, `IdentityAgent=none` (`src/core/ssh-args.ts:115-150`, `helper/src/ssh_args.rs:228-285`).
- `SSH_ASKPASS_REQUIRE=force`. `SSH_ASKPASS` указывает на симлинк `remote-hub-askpass` в приватной директории 0700, сокет 0600 (`helper/src/askpass.rs:1-30`, `:227-237`).
- Секрет отдаётся, только если одновременно верно (`askpass.rs:14-27`, `:369-453`):
  - у соединения тот же uid (`peer_uid`);
  - родитель клиента — процесс ssh именно этой сессии;
  - nonce сессии верен (одноразовый, `prepare`/`register`, `:228-247`);
  - строка запроса равна ожидаемой, вычисленной по argv сессии;
  - bind элемента совпадает с bind сессии.
  Отдаётся один раз. Повторный запрос означает отказ сервера, и ssh останавливается до ответа.
- Остальные промпты (yes/no, keyboard-interactive) уходят пользователю через UI и не сохраняются (`askpass.rs:23-26`).
- Процесс helper: `experimental_spawnHostProcess`, бинарь проверяется по checksum (`src/adapters/bb/helper-process.ts:16`, `:182-200`, `:271`), управляющий протокол по stdin/stdout.

### Host keys / known_hosts
- Сессия со сохранённым секретом читает только overlay `~/Library/Application Support/Remote Hub/known_hosts` (`helper/src/known_hosts.rs:1-8`, `:30-37`). Путь задаёт helper, не запрос. Проверки владельца, прав и симлинков: `:64-69`.
- `knownHostsFile` с секретом отклоняется (`ssh-args.ts:78-84`, `ssh_args.rs:267-268`). Опции `StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null`, `LocalCommand`, `ProxyCommand`, `ForwardAgent` запрещены; произвольных `-o` нет (`ssh-args.ts:31-43`).
- Неизвестный хост вызывает confirm-промпт ssh. Он идёт владельцу через askpass и UI, и ответ "yes" дописывает ключ в overlay (копия сессии, затем merge: `sessions.rs:101`, `:439`, `:527`).
- В overlay принимаются только строки с обычными ключами, без `@cert-authority` и `@revoked` (`known_hosts.rs:1-8`, `:19-28`). Страница умеет добавить строки (импорт), показать и забыть хост (`known_hosts_list`/`known_hosts_forget`, `rpc-handlers.ts:219-220`).
- Агент не может одобрить новый или изменённый host key (`docs/security.md:23-25`).

### ssh-agent / ключи
- Профиль с `authType: "agent"`: секрет не сохраняется (`credential.ts:163`). Сессия идёт без `-F none`, значит читает пользовательскую конфигурацию и использует `SSH_AUTH_SOCK` (в allowlist окружения, `ssh-args.ts:104-110`).
- Ключ с passphrase в Keychain: `-i` + `IdentitiesOnly=yes` + `IdentityAgent=none`, passphrase идёт через askpass (`ssh_args.rs:233`).
- Разбор `~/.ssh/config`: `src/core/ssh-config.ts:1-7` — пассивный парсер, ничего не исполняет. Match, ProxyJump, ProxyCommand, канонизация, HostKeyAlias помечаются флагами и не разрешаются (`ssh-config.test.ts:87-91`). Include идёт только через колбэк, с проверкой циклов и глубины.
- Опциональный `ssh -G` (`src/core/import-book.ts:42`, `:223-230`, `:320-352`; `src/adapters/bb/fs-source-reader.ts:185-188`) выполняется только по явному выбору пользователя, по умолчанию выключен, и только для выбранных записей. Он **исполняет Match exec**, о чём прямо сказано в комментарии `import-book.ts:322-325`. После него выдаётся новый scan id.

### Модель доверия (кратко)
- Владелец доверяет Remote Hub и его helper. Секрет не покидает helper и Keychain.
- Агенты работают через зарегистрированные инструменты. Доступ даётся владельцем по профилю на странице и проверяется на каждом вызове (`src/core/agent-access.ts:1-5`, `:72-76`): уровни none < observe < input < exec; `connect` разрешён с `input`.
- SFTP, scp и subsystem в Remote Hub нет вообще (поиск по src, helper, docs пуст). Спавн ssh жёстко валидируется: `-tt` для терминала, `-T` + команда для exec (`ssh_args.rs:85-90`, `ssh-args.ts:182-195`). Для SFTP нужен новый вид спавна (`-s sftp`) со своей валидацией.
- Известное ограничение (`docs/security.md:12-20`): хост отдаёт для всех вызывающих кроме другого плагина `kind: "client"`. Страницу владельца, `bb plugin rpc call` из шелла и агента с шеллом отличить нельзя. Поэтому согласие, живущее только в RPC-слое, не защищает от агента с доступом к шеллу владельца.

## 2. Почему ownerOnly отказывает плагинам

- `src/adapters/bb/rpc-handlers.ts:33-45` `ownerOnly(handlers)` оборачивает каждый обработчик. Если `ctx.experimental_caller.kind === "plugin"`, бросается `experimental_PluginRpcRefusal({code: "forbidden", message: "this RPC is for the Remote Hub page, not for other plugins"})`.
- Применено ко всему набору: `return ownerOnly({...})` (`rpc-handlers.ts:146`), включая `profile_list` (`:205`), `credential_*`, `agent_access_set`, `ssh_open` и остальные. Сейчас никакой RPC Remote Hub не открыт другим плагинам.
- Контекст: `RpcCallContext` (`rpc-handlers.ts:24-26`), второй аргумент обработчика. Тест: `rpc-handlers.test.ts:328`, `:454-455`.
- SDK 0.6.132 (`bundled-types/bb-plugin-sdk.d.ts:156-170`, `:20495-20516`):
  - `ExperimentalPluginRpcCaller = {kind:"plugin", pluginId} | {kind:"client"}`.
  - Комментарий SDK: "the host verifies that with a per-load token only the server knows". Плагин-вызывающий проходит через `bb.sdk.plugins.callRpc({pluginId, method, input, outputSchema})` (`:18379`, `PluginRpcArgs` `:18282`).
  - Все остальные (app, CLI, агенты, сам BB) идут как `client`.
  - Результат: **id вызывающего плагина надёжно известен вызываемому** (токен проверяет хост, подделать из другого плагина нельзя). Но обратного нет: `client` не отличить от страницы владельца.
  - Исключения при отказе: `experimental_PluginRpcRefusal` с кодами `conflict|forbidden|invalid|not_found`. Другие коды не бросить.
  - Метод можно сделать видимым для discovery: `bb.rpc.register(contract, handlers, {experimental_discoverable, experimental_description})` (`:20511-20514`).
- Идентичность в WebSocket-хендлере: `ExperimentalPluginWebSocketContext = {request, url, headers}` (`bb-plugin-sdk.d.ts`, ищи `interface ExperimentalPluginWebSocketContext`). Caller id там **нет**. Значит поток данных нельзя привязать к плагину через `/attach`. Привязка возможна только токеном, выданным RPC-методом, где caller виден.
- Обход ownerOnly для узкого набора: новый обработчик не оборачивать `ownerOnly`, а в нём явно требовать `kind === "plugin"` и `pluginId` из allowlist-а согласий. Остальные методы остаются под `ownerOnly`.

## 3. Варианты контракта

Общие требования ко всем вариантам:
- Секрет никогда не идёт в RPC-ответ, событие, лог, аудит, ошибку или контекст модели.
- Caller id берётся только из `ctx.experimental_caller` (kind `plugin`). `client` отвергается для методов Commander, даже если "это страница": у страницы свои методы.
- Согласие даёт владелец в UI Remote Hub. Агент не может одобрить host key или согласие (как сейчас для host key, `docs/security.md:23-25`).

### a) Список профилей + грант, Commander-helper подключается сам, секрет по доверенному каналу
Схема: `sftp_profiles_list` отдаёт профили без секретов. `sftp_grant_request` создаёт грант на (профиль, pluginId). Commander-helper берёт секрет по гранту.

Плюсы:
- Commander владеет SFTP-логикой (парсинг, очередь, кэш), Remote Hub остаётся менеджером профилей.
- Самая гибкая реализация файловых операций.

Минусы и риски:
- Самый тяжёлый вариант. Нужен канал "Remote Hub helper → Commander helper", которого нет. Askpass-механизм работает только для потомков ssh этого helper-а (проверка родителя, nonce, `askpass.rs:14-27`). Для чужого процесса надо новое: либо секрет передаётся через Commander-сервер (он попадает в Node-процесс Commander, это расширение области, где живёт секрет, а `docs/security.md:3-6` обещает обратное), либо Remote Hub пишет секрет прямо в stdin дочернего процесса (по сути вариант b).
- Bind и Keychain-проверки (endpoint/key) придётся распространить на второй helper. Появляются два бинаря с правом читать Keychain; macOS-ACL элемента привязан к сборке helper-а Remote Hub (`NeedsApproval`, `keychain.rs:38-41`). Для helper-а Commander придётся дополнительно "Always Allow".
- Больше всего вероятность утечки: секрет живёт в чужом плагине (логи, crash dump, модель Commander).
- Отзыв: грант с TTL и привязкой к pluginId + profileId; отзыв делает владелец, но уже выданный секрет отозвать нельзя.
- Не рекомендуется.

### b) Remote Hub сам открывает SFTP-канал (свой helper), Commander получает операции или поток
Схема: Remote Hub helper запускает `ssh -s sftp` (новый тип спавна) с теми же защитами (askpass, `-F none`, overlay known_hosts, bind). Commander вызывает RPC `sftp_*` и получает листинги, чтения и записи.

Плюсы:
- Секрет и host keys остаются целиком в Remote Hub: ни в Commander, ни в RPC, ни в логах. Существующие защиты (askpass, bind, nonce, overlay) переиспользуются без изменений.
- Caller id нужен только для проверки гранта на каждом RPC. Простая модель.
- Один vault, как решил владелец.

Минусы и риски:
- Remote Hub растёт: SFTP-клиент (пакетный протокол, пути, права, симлинки), ограничения размеров, backpressure. Поверхность атаки helper-а увеличивается.
- Данные файлов идут через RPC (JSON) или через stream-токен (WebSocket по образцу `/attach`, `stream-socket.ts:71-73`, но там нет caller id, привязка только по одноразовому токену, TTL 30 с, `attach.ts`). Большие передачи лучше делать по токену, а не base64 в RPC.
- Отзыв: закрыть сессии гранта и удалить грант. Реализуется просто и сразу эффективно.
- Рекомендуется как основной вариант. Минимум для Commander: операции в лимитах, без шелла.

### c) Профиль + host key pin; аутентификация через ssh-agent или ключи на диске; без секретов в Commander
Схема: Remote Hub отдаёт host, port, user, identityFile и ожидаемый ключ хоста. Commander сам запускает ssh/SFTP с агентом.

Плюсы:
- Секреты в Commander не нужны вообще (агент/ключ без passphrase).
- Минимальные изменения Remote Hub: список профилей и grant.

Минусы и риски:
- Работает только для `authType: agent` и ключей без passphrase. Пароли и ключи с passphrase из Keychain недоступны, что отменяет основной смысл "один vault".
- Commander должен сам запускать ssh с ssh-config пользователя (в том числе Match exec и ProxyCommand, которые исполняет сам ssh) или с `-F none`; обе опции требуют своей модели. Host key pin придётся передавать как строку known_hosts и проверять самим. Это второй независимый слой проверки host keys, чего владелец хотел избежать.
- Агент (`SSH_AUTH_SOCK`) даёт любому процессу плагина все ключи агента; нет привязки к профилю (нет `IdentitiesOnly`, если не передать путь ключа).
- Подходит как дополнение к b для профилей с агентом, а не как основа.

## 4. Рекомендуемый минимальный контракт (вариант b, строго)

### Принципы
1. Новые методы не оборачиваются `ownerOnly`. Каждый явно требует `ctx.experimental_caller.kind === "plugin"` и `pluginId` с действующим согласием. Иначе `experimental_PluginRpcRefusal({code: "forbidden"})`. Все существующие методы остаются под `ownerOnly`.
2. Согласие на (pluginId, profileId, уровень) выдаёт только владелец в UI Remote Hub. Согласие в RPC-слое не создаётся и не расширяется (в том числе `client`-ом: это неотличимо от страницы, поэтому запрос на согласие всегда виден владельцу в UI, а не выполняется молча).
3. Секрет не покидает helper Remote Hub. Ответы содержат только метаданные.

### Схемы (zod-подобно)
```ts
const pluginId = z.string().min(1).max(128);          // только из ctx.experimental_caller, не из input
const profileRef = z.string().uuid();

// Методы (kind:"plugin" обязателен)
hub_sftp_profiles: {
  input: z.object({}).strict(),
  output: z.object({ profiles: z.array(z.object({
    id: profileRef, name: z.string(), group: z.string().nullable(),
    host: z.string(), port: z.number().int(), user: z.string().nullable(),
    authType: z.enum(["agent","key","password"]),
    consent: z.enum(["none","pending","granted","revoked","expired"]),
    hostKey: z.enum(["trusted","unknown","changed"]),
    needsConfig: z.boolean(),                         // true => SFTP недоступен
  })) }).strict(),
}
// Только профили protocol "ssh" без needsConfig; секрет-поля отсутствуют по схеме (.strict()).

hub_sftp_request_access: {
  input: z.object({ profileId: profileRef, reason: z.string().max(200).optional() }).strict(),
  output: z.object({ requestId: z.string().uuid(), state: z.enum(["pending","granted","denied"]) }).strict(),
}
// Создаёт запрос; ничего не выдаёт. Появляется в UI Remote Hub (диалог/баннер).

hub_sftp_open: {
  input: z.object({ profileId: profileRef }).strict(),
  output: z.object({ channelId: z.string().uuid(), generation: z.number().int(),
                     serverBanner: z.string().max(256).nullable() }).strict(),
}
// Проверяет грант и host key, открывает ssh -s sftp в helper Remote Hub. Секрет не возвращается.

hub_sftp_op: { // list | stat | read | write | mkdir | rename | remove | realpath
  input: z.discriminatedUnion("op", [ /* пути-строки, offset/length с лимитами */ ]),
  output: /* метаданные или { transferToken } для потока */,
}
hub_sftp_close: { input: z.object({ channelId: z.string().uuid() }).strict(), output: z.object({ closed: z.boolean() }).strict() }
hub_sftp_grants: { input: z.object({}).strict(), output: /* гранты, выданные этому pluginId: id, profileId, expiresAt, state */ }
```

### События (через `bb.realtime.publish`, только идентификаторы, как сейчас `docs/security.md:42-45`)
- `sftp.consent` {requestId, state}
- `sftp.channel` {channelId, state: "open"|"closed"|"revoked"|"hostkey_changed"}
- `sftp.transfer` {transferToken, bytes, done}

### Ошибки
Только `experimental_PluginRpcRefusal` с `code` из `forbidden|not_found|conflict|invalid`, и стабильным кодом в начале message (как `credentialRefusal`, `rpc-handlers.ts:56-`):
- `caller_not_plugin` (forbidden), `consent_required` (forbidden), `consent_revoked` (forbidden), `consent_expired` (forbidden)
- `profile_not_found` (not_found), `profile_needs_config` (conflict), `profile_not_sftp` (invalid)
- `host_key_unknown` / `host_key_changed` (forbidden): подключение отказывается, владелец решает в UI Remote Hub
- `keychain_locked`, `keychain_needs_approval`, `credential_missing` (как существующие коды)
- `channel_closed`, `limit_exceeded` (invalid), `transfer_token_expired` (not_found)

Сообщения не содержат пути ключей, тексты промптов, имена Keychain-элементов.

### Модель согласия и отзыва
- Согласие = (pluginId, profileId, уровень `read` | `write`, срок). Выдаёт владелец в UI Remote Hub отдельным диалогом, где видны имя плагина (`pluginId` из хоста) и профиль. Уровень по умолчанию `read`, TTL по умолчанию ограниченный (например 24 ч), без вечных грантов.
- Хранение: новая таблица SQLite (по образцу агентских грантов `src/core/agent-access.ts`, `agent-sqlite.ts`). Проверка на каждом вызове, без кэша возможностей (как `agent-access.ts:1-3`).
- Отзыв: одной кнопкой по (pluginId, profileId) и "отозвать всё". Отзыв закрывает открытые каналы (`sftp.channel` revoked) и гасит transferToken. Сам секрет у Commander не появлялся, поэтому отзывать нечего, кроме каналов.
- Аудит: каждый open/op/close, изменение гранта: кто (pluginId), профиль, операция, исход. Содержимое файлов и имена в аудит не пишутся (по образцу `agent-audit.ts`).
- Host key: первое подключение с неизвестным ключом поднимает владельцу тот же confirm (overlay known_hosts, `askpass.rs`, `known_hosts.rs`). Commander не может одобрить ключ. Для `-s sftp` без пользователя в UI открытие должно ждать решения с таймаутом (`UI_TIMEOUT` 120 с) или падать с `host_key_unknown`.

### Что изменить в Remote Hub (список, без правки)
1. `helper/src/ssh_args.rs`, `src/core/ssh-args.ts`: новый вид спавна `ssh -s sftp` (без `-tt`), те же правила: `-F none`, bind, askpass, overlay, никаких новых `-o`. Добавить в `validate_ssh_spawn` и `askpass_facts` соответствующий режим и тесты на отказ при посторонних опциях.
2. `helper/src/`: новый модуль SFTP-клиента поверх stdio ssh (пакеты, лимиты размеров, пути, симлинки, backpressure) и IPC-сообщения `sftp.*` (`protocol.rs`, `ipc.rs`, `src/core/protocol.ts`). Лимиты: одновременные каналы, размеры, глубина листинга.
3. `src/adapters/bb/helper-process.ts`, `service.ts`: методы `sftpOpen/op/close`, привязка канала к (pluginId, profileId, generation); закрытие при отзыве.
4. `src/core/rpc.ts` (схемы), `src/adapters/bb/rpc-handlers.ts`: новые `hub_sftp_*` вне `ownerOnly`, с общей проверкой `kind === "plugin"` и записи в `agent-access`-подобной таблице; `profile_list` и прочие остаются `ownerOnly`. `server.ts:117`: регистрация с `experimental_discoverable` только для новых методов.
5. Новый core-модуль согласий плагинов (по образцу `agent-access.ts`) + SQLite-миграция (`src/adapters/bb/migrations.ts`, append-only) и таблица аудита.
6. Новые owner-RPC для UI: список запросов, выдача, отзыв, "отозвать всё". Под `ownerOnly`.
7. UI (`src/ui/`): панель "Plugin access" (запросы, уровни, TTL, отзыв, активные каналы), баннер "Plugin X requests SFTP access to <profile>".
8. `src/adapters/bb/stream-socket.ts` (`/attach`) или новый маршрут для передачи файлов: одноразовый токен по образцу `attach.ts` (TTL, caps), привязанный к pluginId на стороне RPC, не WebSocket (там нет caller id).
9. `docs/security.md`, `PLUGIN_OVERVIEW.md`, `package.json` (`bb.description`), `marketplace.json`: описать контракт и честно указать ограничение `client`/`plugin` (раздел "Limit").
10. Тесты: отказ `client` на `hub_sftp_*`, отказ чужого pluginId, отзыв закрывает каналы, секрет не появляется в ответах (расширить `tests/integration/credential-leak.test.ts`), host key unknown/changed.

### Открытые вопросы владельцу
- Нужны ли запись и удаление в первой версии, или только чтение?
- TTL согласий и поведение при перезапуске BB (рекомендация: гранты переживают перезапуск, каналы нет).
- Допускаются ли профили `authType: agent` (SFTP через `SSH_AUTH_SOCK` и пользовательский конфиг, где работает Match exec самого ssh) или только сохранённые секреты и ключи с `-F none`. Рекомендация для v1: только `-F none` профили, `agent` позже.
- Лимиты размера передачи и число одновременных каналов.
