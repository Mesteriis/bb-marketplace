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
`feat/remote-hub-sftp` (после переноса ветки на новый main — коммит `22933aad`; содержимое
`sftp-contract.ts` то же, что в `37fdffcd`; история правок: `0bdc04d8`,
`ea8e3bfa`, `37fdffcd`; рабочая копия
`/Users/avm/projects/Personal/bb-main/.worktrees/remote-hub-sftp`), id плагина
`makosh-remote-hub`. Плагины не импортируют файлы друг друга (AGENTS.md), поэтому
`src/core/wire/remote-hub-sftp.ts` — ручное zod-зеркало этого файла:
`SFTP_LIMITS`, `sftpPathSchema`, `uint64Schema`, `sftpAttrsSchema`,
`sftpOpInputSchema`/`sftpOpOutputSchema`, методы `hub_sftp_profiles`,
`hub_sftp_request_access`, `hub_sftp_grants`, `hub_sftp_open`, `hub_sftp_op`,
`hub_sftp_close`, `SFTP_REFUSALS`, `SFTP_EVENTS_CHANNEL = "remote-hub.sftp"`,
события `sftp.consent {profileId, state}`, `sftp.channel {channelId, state}`.
Константа `REMOTE_HUB_SFTP_CONTRACT = "remote-hub@22933aad"`; тест-зеркало
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
- Base64 (данные и пути `{bytes}`) — без регулярки с повтором: зеркало
  `base64Bytes(text)` Remote Hub — число декодированных байт или `null` для
  неканонического текста (стандартный алфавит, длина кратна 4, не больше
  двух `=` и только в конце; URL-алфавит не принимается); лимит по
  декодированным байтам: 4 194 303 и 4 194 304 — да, 4 194 305 и 4 194 306 —
  нет.
- `rename`: `overwrite: false` — цель существует → `exists`;
  `overwrite: true` — только атомарная posix-rename; без расширения всегда
  `unsupported`, есть цель или нет (Remote Hub не эмулирует remove+rename).

```ts
export interface RemoteHubPort {       // узкий порт, реализация в S7 через bb.sdk.plugins.callRpc
  call<M extends SftpMethodName>(method: M, input: SftpInput<M>, signal: AbortSignal): Promise<SftpOutput<M>>;
}
export function createSftpProvider(opts: {
  port: RemoteHubPort; profileId: string; endpoint: Endpoint;
}): FileProvider & { close(): Promise<void> };
```

Поведение:

- Канал открывается лениво, один на провайдер. Коды по контракту
  `37fdffcd`:
  - `channel_closed` — канала нет (закрыт, отозван, сменилось поколение
    helper-а) и запрос на сервер не отправлялся; для `write`, `mkdir`,
    `rename`, `remove` мутация не применялась. Для любой операции —
    переоткрыть канал и повторить один раз; второй `channel_closed` подряд →
    `connection_failed` (retryable).
  - `outcome_unknown` — только мутации: запрос ушёл, канал умер до ответа.
    Не повторять; бросать `outcome_unknown` (S1), дальше reconciliation S3.
- `WriteSession.tempPath` (контракт S3) = путь temp-файла ниже.
- `rename`/`remove` с `expectTarget`/`expect` (контракт S3): `stat` и сверка
  непосредственно перед `hub_sftp_op rename|remove`; расхождение →
  `changed_since_plan`. Окно неатомарности здесь шире (два RPC через Remote
  Hub) — описать в комментарии; `expectTarget: "absent"` с
  `overwrite:false` полагается на `exists` сервера, а не на stat.
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
`hostKey: trusted|unknown|changed`, `generationBumpAfter: n` (следующий
запрос получает `channel_closed`), `dieAfterSend: op` (мутация применена,
ответ — `outcome_unknown`),
`posixRename: boolean`, `failWrite: "unreachable"`, `dirSize` для проверки
лимита 10 000.

## Проверки

- Все схемы `.strict()`; ответ мока с лишним полем `password` →
  `ZodError` (утечка не проходит молча).
- Без гранта → `consent_required`; отзыв посреди сессии → следующая
  операция `consent_required`, канал закрыт.
- `hostKey: unknown` и `changed` → `host_key_rejected`, ни одного
  `hub_sftp_op` не отправлено.
- `generationBumpAfter: 2`: и `list`, и `write` получают `channel_closed`,
  канал переоткрыт, операция повторена один раз и прошла; содержимое `write`
  записано ровно один раз.
- Два `channel_closed` подряд → `connection_failed`, третьего запроса нет.
- `dieAfterSend: "write"` → `outcome_unknown`, повтора нет (мок считает
  одну применённую запись).
- `posixRename: false` → commit с replace даёт конфликт, а не
  remove+rename; `atomicReplace` не объявлен.
- Байтовое имя `{bytes:"/w=="}` от мока → сегмент `{b:"/w=="}` и обратно
  тот же путь в `write`.
- Каталог 10 001 запись → `limit_exceeded`.
- `remove` с устаревшим `expect` → `changed_since_plan`, ни одного
  `hub_sftp_op remove` не отправлено.
- Зеркало `base64Bytes`: строка base64 ровно 4 MiB проходит схему без
  переполнения стека; 4 194 303 и 4 194 304 байта — принимаются, 4 194 305 и
  4 194 306 — отказ; URL-алфавит (`-`, `_`) — отказ.
- Мок с `posixRename: false`: `rename(overwrite:true)` → `unsupported` и при
  отсутствующей цели.
- Чтение 9 MiB кусками по 4 MiB → 3 вызова `read` c offset `0`, `4194304`,
  `8388608`.
- Сообщения ошибок не содержат строк `identityFile`, `.ssh/`, `Keychain`
  (проверка по всем кодам мока).
- `REMOTE_HUB_SFTP_CONTRACT` экспортирован и упомянут в тесте.

Сквозная проверка с настоящим Remote Hub — после его релиза, отдельной
задачей в S7 (тестовый BB + Docker sshd, host-key mismatch, нет прав).

## Ожидаемый diff

3 модуля + тесты, ~800–1200 строк.

## Расхождение слитого кода с контрактом (после слияния S5 @ `8a0837a2`)

Закрыто: S5-follow-up @ `3408a056` приводит код к `remote-hub@22933aad`;
отложенные мелочи — в `after-stage-1.md`.

Код S5 в ветке Commander следует контракту `ea8e3bfa`
(`REMOTE_HUB_SFTP_CONTRACT = "remote-hub@ea8e3bfa"`). До `37fdffcd`/`22933aad`
не доведено:
- в зеркале `SFTP_REFUSALS` нет кода `outcome_unknown` (conflict);
- `channel_closed` на мутации трактуется как неоднозначный исход
  (`outcome_unknown`), а по контракту он означает «запрос не отправлялся» —
  нужно переоткрыть канал и повторить один раз;
- константа контракта.

Поведение сейчас осторожнее контракта (лишние `unknown`, без риска двойной
записи). Доводку делает отдельная задача S5-follow-up: зеркало и мок по
`22933aad`, правило повтора из раздела «Поведение», тесты из «Проверок».

