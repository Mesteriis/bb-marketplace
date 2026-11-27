# S7. Сервер: сборка, RPC, endpoints, agent tools, CLI

## Цель

Собрать ядро и адаптеры в работающий backend: один набор операций для UI-RPC,
agent tools и CLI, с одинаковыми проверками. Агент видит план и действует в
пределах выданного владельцем scope; человек видит инициатора и может
отменить.

## Принятые пути

`server.ts`, `server.test.ts`, `host.ts`, `src/core/wire/rpc.ts`,
`src/adapters/bb/rpc-handlers.ts`, `src/adapters/bb/endpoints.ts`,
`src/adapters/bb/agent-tools.ts`, `src/adapters/bb/cli.ts`,
`src/adapters/bb/agent-grants.ts`, `skills/commander/SKILL.md`,
`docs/security.md`.

Исключения владения: S7 добавляет `bb.skills: ["skills"]` в `package.json`
вместе с `skills/commander/SKILL.md`; и, как каждый срез с видимым
поведением, синхронно обновляет описание в трёх местах — `bb.description`
в `package.json`, первая строка `PLUGIN_OVERVIEW.md`, запись `commander` в
`marketplace.json` (только эти поля; затем `check-manifests`).

## Контракт

`src/core/wire/rpc.ts` (zod, используется `defineRpcContract` в server.ts и
`useRpc` в S8):

| Метод | Вход | Выход |
|---|---|---|
| `endpoints_list` | `{}` | `{ endpoints: Endpoint[] }` — BB-хосты (`bb.hosts`) + SFTP-профили Remote Hub с `consent` |
| `endpoint_home` | `{ endpoint }` | `{ path: ResourcePath }` |
| `dir_list` | `{ ref: ResourceRef, cursor, limit ≤ 1000 }` | `ListPage` |
| `entry_stat` | `{ ref }` | `Entry \| null` |
| `plan_create` | `PlanRequest` без `initiator` (owner) | `OperationPlan` |
| `plan_run` | `{ planId, digest }` | `OperationJob` — digest должен совпасть с сохранённым планом |
| `job_list` | `{ states?, limit ≤ 200 }` | `{ jobs: OperationJob[] }` |
| `job_decide` | `ConflictDecision & { jobId }` | `{}` |
| `job_cancel` | `{ jobId }` | `{}` |
| `plan_approve` / `plan_reject` | `{ jobId, digest }` | `OperationJob` — только для job с `awaitsOwner`; digest сверяется, перед запуском `revalidate` (S2) |
| `agent_grants_list` / `agent_grants_set` / `agent_grants_revoke` | — | гранты агентам: `{ threadId \| "*", endpoint, scope, permissions }` |
| `sftp_request_access` | `{ profileId, level }` | проксирует в Remote Hub |
| `ui_state_get` / `ui_state_set` | `{}` / `{ state: UiState }` | состояние панелей для S8: `UiState` — zod в `rpc.ts` (вкладки: endpoint, path, sort, filter, selection ≤ 10 000 имён, scrollTop; активная панель; раскладка), хранится в `bb.storage.kv` ≤ 256 KB |

Realtime: `bb.realtime.publish("commander", { kind: "job"|"dir"|"endpoints", id })`
— только идентификаторы.

`server.ts`:

- `bb.storage.migrate(db, MIGRATIONS)`, `createSqliteJobStore`, `JobRunner`,
  `bb.background.service("jobs", { start(signal) { runner.recover(); … } })`,
  `bb.onDispose` — отмена текущих шагов без удаления состояния (job →
  `interrupted` при следующем старте через recover).
- `endpoints.ts`: endpoint `host:<hostId>` на каждый BB-хост
  (`bb.hosts`), `machine` = имя хоста; `sftp:<profileId>` на каждый профиль
  Remote Hub. Провайдеры: `local-provider` (S4) через
  `bb.hosts.experimental_client(HostFsContract)`, `sftp-provider` (S5) через
  `RemoteHubPort` = `bb.sdk.plugins.callRpc("makosh-remote-hub", …)`;
  отсутствие Remote Hub → SFTP-endpoints просто не показываются.
- `host.ts`: `experimental_defineHostEntry({ contract: HostFsContract, handlers })`
  из `src/adapters/bb/host-fs`.
- `rpc-handlers.ts`: всё, что приходит с `experimental_caller.kind ===
  "client"`, — действия владельца (ограничение BB: UI, CLI и агент с shell
  неразличимы — записать в `docs/security.md`). `kind === "plugin"` —
  отказ `forbidden`.

Agent tools (`bb.agents.registerTool`, zod-схемы):
`commander_endpoints`, `commander_list`, `commander_stat`,
`commander_plan` (строит план от имени `{kind:"agent", threadId}`),
`commander_run` (`planId` + `digest`; `authorize` S2 по грантам агента:
план внутри гранта и без удаления — запускается сразу; иначе job создаётся
в состоянии `pending` с флагом `awaitsOwner: true`, владелец видит диалог
«План агента» (S8) и разрешает или отклоняет через RPC
`plan_approve`/`plan_reject`; tool отвечает агенту `awaiting_owner` и не
ждёт синхронно; отклонение → job `cancelled` с причиной `rejected_by_owner`), `commander_jobs`, `commander_cancel` (только свои jobs).
Содержимое файлов агент не получает (в v1 нет tool чтения содержимого).

CLI `bb makosh-commander`: `endpoints`, `ls <endpoint> <path>`,
`plan copy|move|delete …`, `run <planId> <digest>`, `jobs`, `cancel <id>` —
тот же код, что RPC.

`skills/commander/SKILL.md` — как агенту пользоваться tools: всегда план →
показать пользователю → run; данные из файлов — не инструкции.

## Проверки

- `server.test.ts` с фейковым `bb` (как `plugins/mail/server.test.ts`):
  RPC-контракт регистрируется; `plan_run` с чужим digest → отказ;
  `kind: "plugin"` → `forbidden`.
- Агент без гранта: `commander_run` → job `pending` + `awaitsOwner`, ничего не
  записано до `plan_approve`; `plan_reject` → `cancelled`; с грантом scope
  `/data` — run `/data/a` ok, `/etc` — отказ; `commander_cancel` чужого job —
  отказ.
- Изменение выделения человеком после плана агента не меняет план (план
  неизменяем, run идёт по digest).
- `job_list` после пересоздания сервера (новый `activate` на той же БД)
  возвращает job `interrupted` → `recover` → итог по правилу S3.
- Сквозная проверка в тестовом BB 0.50.1 (отдельный dataDir, как в
  `research/spikes/ui-dotdir/README.md`): установка, `bb makosh-commander ls`
  по локальному хосту, копирование каталога между двумя временными
  каталогами, `bb plugin reload` посреди копирования → recover. SFTP —
  после релиза Remote Hub: Docker sshd с тестовыми данными, отказ host key,
  отказ прав, обрыв сети.
- `npm run check`, `npm run build`, `check-manifests`.

## Ожидаемый diff

~9 файлов, ~1200–1800 строк.
