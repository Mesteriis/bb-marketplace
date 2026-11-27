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

`remote-hub-sftp.ts`: схемы методов `hub_sftp_profiles`,
`hub_sftp_request_access`, `hub_sftp_grants`, `hub_sftp_open`, `hub_sftp_op`
(list, stat, read, write/handle, mkdir, rename, remove, realpath),
`hub_sftp_close`, событий `sftp.consent`, `sftp.channel` и кодов отказа —
ровно по `research/remote-hub-task.md`; поля, которых Remote Hub ещё не
зафиксировал, помечены `// TODO(remote-hub contract)` и одним местом
переключаются, когда придёт финальная схема. Отпечаток версии контракта —
константа `REMOTE_HUB_SFTP_CONTRACT = "draft-2026-11-27"`.

```ts
export interface RemoteHubPort {       // узкий порт, реализация в S7 через callRpc
  call<M extends keyof SftpMethods>(method: M, input: SftpInput<M>, signal: AbortSignal): Promise<SftpOutput<M>>;
}
export function createSftpProvider(opts: {
  port: RemoteHubPort; profileId: string; endpoint: Endpoint;
}): FileProvider & { close(): Promise<void> };
```

Поведение:

- Канал открывается лениво, один на провайдер; `channel_closed`/обрыв →
  одна попытка переоткрыть для идемпотентных операций (list, stat, read,
  realpath, sha256); для write/rename/remove — не повторять, бросать
  `outcome_unknown` при неоднозначном исходе.
- Отказы Remote Hub → `ErrorCode`: `consent_required`/`consent_revoked` →
  `consent_required`; `host_key_unknown`/`host_key_changed` →
  `host_key_rejected`; `keychain_*`, `credential_missing`, auth →
  `auth_failed`; сеть/таймаут → `connection_failed` (retryable); прочее →
  `internal` без текста Remote Hub в сообщении, если оно может содержать
  путь ключа.
- `openWrite`: temp-имя в каталоге цели, commit через `rename` (replace
  только если сервер поддерживает POSIX-rename; иначе `atomicReplace`
  не объявляется и replace = remove+rename с явным `outcome_unknown`
  окном, отражённым в capabilities).
- `capabilities`: list, stat, read, write, mkdir, rename, remove, seek;
  `atomicReplace` — только при подтверждённом `posix-rename@openssh.com`;
  `checksum` — нет (S3 перечитывает назначение).
- Размеры и смещения — `Size`, без `Number` для > 2^53.

Мок (`testing/remote-hub-mock.ts`): in-memory сервер по схеме, с режимами
`consent: none|granted|revoked`, `hostKey: trusted|unknown|changed`,
`dropAfter: n` (обрыв канала после n операций), `failWrite: outcome_unknown`.

## Проверки

- Все схемы `.strict()`; ответ мока с лишним полем `password` →
  `ZodError` (утечка не проходит молча).
- Без гранта → `consent_required`; отзыв посреди сессии → следующая
  операция `consent_required`, канал закрыт.
- `hostKey: unknown` и `changed` → `host_key_rejected`, ни одного
  `hub_sftp_op` не отправлено.
- Обрыв после 2 операций: `list` повторяется прозрачно (1 повтор), `write`
  → `outcome_unknown`, без повтора.
- Чтение 9 MiB кусками по 4 MiB → 3 вызова `read` c offset `0`, `4194304`,
  `8388608`.
- Сообщения ошибок не содержат строк `identityFile`, `.ssh/`, `Keychain`
  (проверка по всем кодам мока).
- `REMOTE_HUB_SFTP_CONTRACT` экспортирован и упомянут в тесте.

Сквозная проверка с настоящим Remote Hub — после его релиза, отдельной
задачей в S7 (тестовый BB + Docker sshd, host-key mismatch, нет прав).

## Ожидаемый diff

3 модуля + тесты, ~800–1200 строк.
