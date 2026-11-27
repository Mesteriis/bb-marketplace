# Задача для Remote Hub: SFTP для плагинов по гранту владельца

От: тред Commander (thr_ba4dpyzux4), ветка `feature/commander-thr_ba4dpyzux4`.
Основа: `plugins/commander/research/remote-hub-contract.md` (исследование кода
Remote Hub, раздел 4 — схемы, ошибки, список из 10 изменений). Commander
Remote Hub не правит; реализация, тесты, версия и релиз — в треде remote-hub.

## Решения владельца (2026-11-27)

1. Вариант b: SFTP открывает helper Remote Hub (`ssh -s sftp`), Commander
   работает через плагинный RPC по гранту владельца. Секреты, askpass, bind и
   overlay known_hosts остаются в Remote Hub; ни секрет, ни путь ключа, ни
   имена Keychain-элементов не попадают в ответы, ошибки, логи, события.
2. В v1 — чтение и запись: list, stat, read, write, mkdir, rename, remove,
   realpath (и setstat, если дёшево; иначе позже).
3. Профили `authType=agent` — сразу: SFTP через `SSH_AUTH_SOCK` и
   пользовательский ssh-config так же, как терминальные сессии этих
   профилей. Проверка host key обязательна и для них (без
   `StrictHostKeyChecking=no`/`accept-new`, неизвестный ключ → решение
   владельца в UI, как для остальных). Пассивное чтение конфигов по-прежнему
   не исполняет `Match exec`.
4. Грант (pluginId, profileId, уровень `read` | `write`) — без TTL, до
   отзыва; переживает перезапуск BB, каналы — нет. Отзыв запрещает новые
   операции, закрывает открытые каналы и гасит токены передачи, не откатывая
   уже сделанное.
5. Выдаёт и отзывает грант только владелец в UI Remote Hub; через RPC грант не
   создаётся и не расширяется (запрос `hub_sftp_request_access` только ставит
   его в очередь владельцу).

## Что нужно Commander (минимальный контракт)

Все новые методы — вне `ownerOnly`, только `experimental_caller.kind ===
"plugin"`, pluginId берётся из `experimental_caller`, не из input; старые
методы остаются `ownerOnly`. Ошибки — `experimental_PluginRpcRefusal` со
стабильными кодами из раздела 4 (`caller_not_plugin`, `consent_required`,
`consent_revoked`, `profile_not_found`, `profile_needs_config`,
`host_key_unknown`, `host_key_changed`, `keychain_locked`,
`credential_missing`, `channel_closed`, `limit_exceeded`, …); код
`consent_expired` не нужен (TTL нет).

| Метод | Назначение |
|---|---|
| `hub_sftp_profiles` | ssh-профили без секретов: id, name, group, host, port, user, authType (agent/key/password), consent (none/pending/granted/revoked), hostKey (trusted/unknown/changed), needsConfig |
| `hub_sftp_request_access` | запрос гранта `{profileId, level, reason?}` → `{requestId, state}` |
| `hub_sftp_grants` | гранты этого pluginId: profileId, level, state, grantedAt |
| `hub_sftp_open` | `{profileId}` → `{channelId, generation}` после проверки гранта и host key |
| `hub_sftp_op` | discriminated union по `op`; пути — байты (base64) или UTF-8 с явным флагом, без молчаливой замены непредставимых имён; stat/list возвращают size (строкой или safe integer с проверкой), mtime с точностью сервера, mode, тип, цель симлинка |
| `hub_sftp_close` | `{channelId}` → `{closed}` |

Передача данных в v1: `read {channelId, path, offset, length ≤ 4 MiB}` →
байты (base64) и `write {channelId, handle|path, offset, data ≤ 4 MiB}`;
запись идёт во временное имя, которое Commander затем переименовывает (или
`open/write/close` с handle — на выбор Remote Hub, но с явной семантикой
create-exclusive / truncate). Если Remote Hub предпочтёт поток по
одноразовому токену (`attach.ts`), Commander примет и его; нужна только
стабильная схема в `src/core/rpc.ts`.

События (`bb.realtime.publish`, только идентификаторы): `sftp.consent`,
`sftp.channel` (open/closed/revoked/hostkey_changed).

Лимиты (предложение, финал за Remote Hub): кусок ≤ 4 MiB, ≤ 4 открытых канала
на pluginId, ≤ 10 000 записей в одном list с пагинацией.

## Проверки, которые ждём

Список 10 из раздела 4 контракта, плюс: `client` получает отказ на
`hub_sftp_*`; чужой pluginId — отказ; отзыв закрывает каналы и следующий op
даёт `consent_revoked`; секрет и путь ключа не появляются ни в одном ответе
(расширение `credential-leak.test.ts`); host key unknown/changed для `key`,
`password` и `agent`; профиль `agent` без запущенного агента — понятная
ошибка.

## Как сообщить о готовности

Номер версии Remote Hub, схема контракта (путь к zod-схемам) и id плагина —
сообщением в тред Commander (`bb thread tell thr_ba4dpyzux4`). До этого
Commander делает local/BB-host срезы и SFTP-провайдер против мока по этому
контракту.
