# ADR 0001. Основа Commander: своя композиция на Makosh-каркасе

- Статус: предложено, ждёт решения владельца по разделу «Решения владельца»
- Дата: 2026-11-27
- Контекст исследования: `research/` (источники — `research/sources.lock.json`)

## Контекст

Нужен двухпанельный файловый менеджер внутри BB (ТЗ:
`thr_mn6uyba78h/commander/spec.md`). Установлено: BB 0.50.1 на macOS 27.0.1
arm64; BB подставляет плагинам SDK 0.6.157, плагины репозитория пинят 0.6.132
и грузятся (тот же мажор). Upstream `get-bb/bb` main опережает 0.50.1 (SDK
0.6.205): символы только из main (`experimental_keyScope`,
`storage.experimental_directory` и др.) не используем.

Проверено:

| Вопрос | Результат | Источник |
|---|---|---|
| DotDir UI как основа (подход A) | не проходит: перехватывает F5 и печатные символы вне своего корня, лицензия нужных пакетов неясна, свой Catppuccin, 5.7 MB | `research/donors/dotdir.md`, `research/spikes/ui-dotdir/README.md` (запуск в тестовом BB, скриншоты) |
| Развивать file-gateway (подход B) | не основа: SDK 0.4.87, только чтение, base64-RPC, SFTP только пароль | `research/donors/bb-plugins.md` |
| Готовое ядро операций у доноров | нет ни у кого: очередь, прогресс, отмена, конфликты по элементу, атомарная замена, SFTP-запись | `research/donors.md` |
| Data plane BB | чтение: core-роут `GET /api/v1/hosts/:id/files/<path>` (Range, ETag), любой хост; запись: только `sdk.files.write` ≤25 MiB или свой host entry (вход ≤32 MiB, ответ ≤8 MiB на вызов) | `research/bb-api-map.md` §3, §5 |
| SFTP и секреты | у Remote Hub секреты в Keychain через askpass, overlay known_hosts; SFTP нет; все RPC `ownerOnly` | `research/remote-hub-contract.md` |
| TC-плагины на macOS arm64 | собственный WFX/WCX + Rust runner: dlopen, W-путь, UTF-16 с суррогатами, >4 ГиБ, отмена, изоляция падения — 8/8 тестов | `research/spikes/tc/README.md`, `test.log` |

## Решение

### 1. Основа — подход C

Свой плагин `plugins/commander` (id `makosh-commander`) на каркасе Makosh:
`src/core` (zod, без хоста), `src/ui` (React + core + `components/ui` BB),
`src/adapters/bb`, `server.ts`, `app.tsx`, `host.ts`,
`tests/architecture.test.ts`. Из доноров берём приёмы и тест-кейсы
(Bobroot, File Manager, File Gateway, Workbench Explorer — MIT, с записью в
`THIRD_PARTY_NOTICES.md`), из DotDir — только форму контракта и раскладку
клавиш. AGPL/GPL-код (Xplorer next, Double Commander) не копируем.

### 2. Процессы и где исполняется код

| Часть | Где | Зачем |
|---|---|---|
| UI | `app.tsx` в renderer BB, React BB | страница `slots.navPanel` (основная), `slots.experimental_tab` у треда (вторичная) |
| Ядро операций, очередь jobs | `server.ts` в сервере BB, `bb.background.service` | одна логика для UI-RPC, CLI и agent tools |
| Локальная ФС любого BB-хоста | host entry `host.ts` (`experimental_defineHostEntry`) на этом хосте, Node `fs` | stat/list/copy/move/rename/mkdir/delete/trash, запись в `.partial` + атомарное завершение, O_NOFOLLOW |
| SFTP | helper Remote Hub (по контракту, раздел 5) | секреты и host keys не покидают Remote Hub |
| TC-плагины (этап 4) | отдельный Rust-процесс `tc-runner` на плагин, JSON-RPC NDJSON по stdio | падение плагина не задевает BB; доверенный, не песочница |

Своего Rust-helper-а на этапе 1 нет: локальная ФС закрывается host entry, SFTP —
Remote Hub. Отдельный процесс вводится только для TC (изоляция ABI и падений) и,
если замер покажет нужду, для тяжёлых архивов.

### 3. Control plane и data plane

- Control: BB RPC (`defineRpcContract`), `bb.realtime.publish` только с
  идентификаторами и инвалидациями (без путей и содержимого).
- Чтение, preview, скачивание: core-роут `GET /api/v1/hosts/:id/files/<path>`
  (Range) и `experimental_openFilePreview({kind:"host"})`.
- Копирование на одном хосте: на стороне host entry, без передачи байтов через
  сервер.
- Между хостами/провайдерами: потоковая ретрансляция кусками (≤4 MiB) через
  сервер Commander: чтение host-RPC/SFTP-read → запись host-RPC/SFTP-write в
  `.partial`, SHA-256, затем атомарное завершение; одновременно в пути один
  кусок на поток (backpressure = последовательные await), лимит памяти задаётся
  числом потоков. Маршрут данных показывается в плане операции.
- Загрузка из браузера больших файлов не входит в этап 1 (пробел SDK №3).

### 4. Ядро операций

Сущности из ТЗ §6 (`Endpoint`, `Provider`, `ResourceRef`, `Capability`,
`OperationPlan`, `OperationJob`, `Conflict`) — zod-схемы в `src/core`.
`ResourceRef` = `{provider, endpoint, path: {bytes base64 | utf8}}`, без
сведения к локальной строке. Jobs и их шаги — в `bb.storage.database()`
(SQLite) с контрольными точками; после reload/рестарта — reconciliation
(сверка `.partial`, размера, mtime/хэша), неоднозначный исход → состояние
`unknown`, без слепого повтора. Состояния job — ровно список ТЗ §6.

Права: `observe/read/write/delete/exec/admin` проверяются в ядре на каждом
вызове. Ограничение BB: UI, CLI и агент с shell для RPC неразличимы
(`experimental_caller.kind="client"`), поэтому агентские действия идут только
через agent tools с утверждённым планом; RPC страницы считается действием
владельца. Это фиксируется в `docs/security.md` плагина.

### 5. Remote Hub (нужен контракт, правит его тред)

Вариант b из `research/remote-hub-contract.md`: Remote Hub получает SFTP в
своём helper-е (`ssh -s sftp` с тем же askpass, bind и overlay known_hosts) и
плагинный RPC вне `ownerOnly`: `hub_sftp_profiles`, `request_access`, `open`,
`op`, `close`, `grants`; доступ только `kind:"plugin"` с действующим грантом
владельца (pluginId, profileId, read|write, TTL), отзыв запрещает новые
операции. Commander не видит секретов и не держит своего vault.

### 6. Клавиатура

Никаких слушателей на `window`/`document`. Клавиши — `onKeyDown` на корне
страницы Commander, только когда фокус внутри; F5–F8 и прочие — ещё и как
команды BB с `defaultShortcut` (разрешено для F-клавиш), чтобы видеть их в
палитре. При `preventDefault` внутри своего корня BB-хоткеи не срабатывают —
это то, что нужно. Альтернативы для macOS (⌘C/⌘V-подобные) и переназначение —
в настройках. Бэкпорт `experimental_keyScope` — предложение ядру (п. 7).

### 7. Предложения ядру BB (не блокируют этап 1)

Из `research/bb-api-map.md` «Пробелы SDK»: метаданные каталога и copy в
`FilesArea`; стрим-PUT файла; стримы host-воркера; process group воркера;
`experimental_keyScope` в релизе; подписанный источник клиента. Отправка в
get-bb — только с отдельного разрешения владельца.

### 8. Расширения и TC (этапы 3–4, предварительно)

Расширения Commander — пакеты с manifest, исполняемые вне renderer (Node
worker/процесс), UI-расширения не грузят произвольный JS в origin BB. Формат —
отдельный ADR на этапе 3. TC: runner из `research/spikes/tc` как основа; WLX —
`unsupported` до отдельного решения; сторонние Windows-плагины — `unverified`
до Windows-стенда.

## Последствия

- Больше собственного кода (ядро, host entry, UI), зато одна архитектура с
  остальными Makosh-плагинами и токены BB.
- Опора на `experimental_*` (navPanel-вкладки, host entry, openFilePreview,
  openTerminal): каждый вызов за адаптером с fallback (таблица в
  `research/bb-api-map.md`).
- Этап 1 зависит от контракта Remote Hub для SFTP. Пока его нет, этап 1
  строится на local ↔ local и local ↔ другой BB-хост, а SFTP-провайдер
  подключается к контракту, когда он появится.
- Осиротевшие процессы: host entry без дочерних процессов на этапе 1; runner
  TC — с убийством в `lifecycle.signal`/`dispose`.

## Решения владельца

1. Контракт Remote Hub по варианту b — да/нет; в v1 запись или только чтение;
   TTL гранта; профили `authType=agent` — сейчас или позже; лимиты
   размера/каналов.
2. Принять подход C как основу (DotDir остаётся референсом).
3. Отправлять ли предложения ядру BB (раздел 7) в get-bb — отдельно, позже.
