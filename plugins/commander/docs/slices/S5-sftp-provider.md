# S5. SFTP-провайдер через Remote Hub

## Цель

`FileProvider` для SFTP, который ходит в Remote Hub плагинным RPC
(`bb.sdk.plugins.callRpc`) по контракту `research/remote-hub-task.md`. Секретов
в Commander нет. Пока Remote Hub не сдал контракт — разработка и тесты против
мока той же схемы.

## Принятые пути

`src/core/wire/remote-hub-sftp.ts` (zod-зеркало контракта Remote Hub),
`src/adapters/bb/sftp-provider.ts`, `src/adapters/bb/testing/remote-hub-mock.ts`,
их `*.test.ts`.

## Контракт

Источник истины — `plugins/remote-hub/src/core/sftp-contract.ts` ветки
`feat/remote-hub-sftp` (коммит `0bdc04d8`; рабочая копия
`/Users/avm/projects/Personal/bb-main/.worktrees/remote-hub-sftp`), id плагина
`makosh-remote-hub`. Плагины не импортируют файлы друг друга (AGENTS.md), поэтому
`src/core/wire/remote-hub-sftp.ts` — ручное zod-зеркало этого файла:
`SFTP_LIMITS`, `sftpPathSchema`, `uint64Schema`, `sftpAttrsSchema`,
`sftpOpInputSchema`/`sftpOpOutputSchema`, методы `hub_sftp_profiles`,
`hub_sftp_request_access`, `hub_sftp_grants`, `hub_sftp_open`, `hub_sftp_op`,
`hub_sftp_close`, `SFTP_REFUSALS`, `SFTP_EVENTS_CHANNEL = "remote-hub.sftp"`,
события `sftp.consent {profileId, state}`, `sftp.channel {channelId, state}`.
Константа `REMOTE_HUB_SFTP_CONTRACT = "remote-hub@0bdc04d8"`; тест-зеркало
сверяет те же примеры, что `sftp-contract.test.ts` Remote Hub (переписать
значения литералами, не импортировать).

Ключевые правила контракта (от Remote Hub, 2026-11-27):

- Путь — `{text}` (валидный UTF-8) или `{bytes: base64}`, ≤ 4096 байт.
  Перевод в `ResourcePath` S1: разбиение по байту `/`; сегмент — `{t}`, если
  валидный UTF-8, иначе `{b}`; обратно — склейка байтов.
- `size`/`offset` — десятичная строка uint64 (совместима с `Size` S1);
  `mtime` — целые секунды → `mtimeNs = mtime * 1e9` строкой,
  `mtimePrecision: "s"`; `mode` и `mtime` nullable; `linkTarget` — как хранится.
- `list {path, cursor?, limit ≤ 1000}` → `{entries: [{name, attrs}], nextCursor}`;
  больше 10 000 записей → `limit_exceeded` (показывается пользователю как
  ограничение, без тихого усечения).
- `read {path, offset, length ≤ 4 MiB}` → `{data: base64, eof}`;
  `write {path, offset, data ≤ 4 MiB, create: exclusive|truncate|existing}` →
  `{written}`; handle нет.
- `rename {from, to, overwrite}`: `overwrite: true` — атомарно (posix-rename)
  или отказ `unsupported`; `remove {path, kind: file|dir}` — один файл или
  пустой каталог; `setstat` нет.
- `hub_sftp_open` → `{channelId, generation}` (32 hex); канал умирает с
  поколением helper-а.
- Лимиты `SFTP_LIMITS`: кусок 4 MiB, 4 канала на плагин, страница 1000,
  каталог 10 000.

```ts
export interface RemoteHubPort {       // узкий порт, реализация в S7 через bb.sdk.plugins.callRpc
  call<M extends SftpMethodName>(method: M, input: SftpInput<M>, signal: AbortSignal): Promise<SftpOutput<M>>;
}
export function createSftpProvider(opts: {
  port: RemoteHubPort; profileId: string; endpoint: Endpoint;
}): FileProvider & { close(): Promise<void> };
```

Поведение:

- Канал открывается лениво, один на провайдер; `channel_closed` или смена
  `generation` → одна попытка переоткрыть для идемпотентных операций (list,
  stat, read, realpath); для write/rename/remove — не повторять, бросать
  `outcome_unknown` при неоднозначном исходе.
- `WriteSession.tempPath` (контракт S3) = путь temp-файла ниже.
- `openWrite(target)`: temp-имя `.<name>.commander-<uuid>.part` в каталоге
  цели; первый кусок `create: "exclusive"` offset 0, последующие
  `create: "existing"`; `commit({replace:false})` → `rename(overwrite:false)`
  (цель существует → `already_exists`); `commit({replace:true})` →
  `rename(overwrite:true)`, при `unsupported` — job получает конфликт, а не
  тихую неатомарную замену; `abort()` → `remove(temp, file)`.
- `capabilities`: list, stat, read, write, mkdir, rename, remove, seek;
  `atomicReplace` — объявляется только после того, как первый
  `rename(overwrite:true)` на этом канале прошёл (иначе нет);
  `checksum` — нет (S3 перечитывает назначение).
- `SFTP_REFUSALS` → `ErrorCode` S1: `consent_required`/`consent_revoked` →
  `consent_required`; `host_key_unknown`/`host_key_changed` →
  `host_key_rejected`; `auth_failed`, `keychain_*`, `credential_missing`,
  `agent_unavailable` → `auth_failed`; `unreachable` → `connection_failed`
  (retryable); `no_such_file` → `not_found`; `exists` → `already_exists`;
  `not_empty` → `is_a_directory`; `permission_denied` → `permission_denied`;
  `unsupported` → `unsupported`; `invalid_path` → `invalid_path`;
  `limit_exceeded` → `limit_exceeded`; `failure` и прочее → `internal`.
  Текст Remote Hub после кода в сообщение не переносится.

Мок (`testing/remote-hub-mock.ts`): in-memory сервер по зеркалу схем, с
режимами `consent: none|pending|granted|revoked`,
`hostKey: trusted|unknown|changed`, `generationBumpAfter: n`,
`posixRename: boolean`, `failWrite: "unreachable"`, `dirSize` для проверки
лимита 10 000.

## Проверки

- Все схемы `.strict()`; ответ мока с лишним полем `password` →
  `ZodError` (утечка не проходит молча).
- Без гранта → `consent_required`; отзыв посреди сессии → следующая
  операция `consent_required`, канал закрыт.
- `hostKey: unknown` и `changed` → `host_key_rejected`, ни одного
  `hub_sftp_op` не отправлено.
- Смена `generation` после 2 операций: `list` повторяется прозрачно (1
  повтор), `write` → `outcome_unknown`, без повтора.
- `posixRename: false` → commit с replace даёт конфликт, а не
  remove+rename; `atomicReplace` не объявлен.
- Байтовое имя `{bytes:"/w=="}` от мока → сегмент `{b:"/w=="}` и обратно
  тот же путь в `write`.
- Каталог 10 001 запись → `limit_exceeded`.
- Чтение 9 MiB кусками по 4 MiB → 3 вызова `read` c offset `0`, `4194304`,
  `8388608`.
- Сообщения ошибок не содержат строк `identityFile`, `.ssh/`, `Keychain`
  (проверка по всем кодам мока).
- `REMOTE_HUB_SFTP_CONTRACT` экспортирован и упомянут в тесте.

Сквозная проверка с настоящим Remote Hub — после его релиза, отдельной
задачей в S7 (тестовый BB + Docker sshd, host-key mismatch, нет прав).

## Ожидаемый diff

3 модуля + тесты, ~800–1200 строк.
