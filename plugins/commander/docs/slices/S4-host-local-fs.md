# S4. Локальная ФС BB-хоста: host entry и провайдер

## Цель

Файловые операции на любом подключённом BB-хосте через host entry
(`experimental_defineHostEntry`, Node `fs` на этом хосте) и адаптер
`FileProvider` на сервере, вызывающий его через
`bb.hosts.experimental_client`.

## Принятые пути

`src/core/wire/host-fs.ts` (zod-контракт host RPC), `src/adapters/bb/host-fs/**`
(реализация обработчиков, без регистрации — её делает `host.ts` в S7),
`src/adapters/bb/local-provider.ts`, `tests/host-fs/**`.

## Контракт

`src/core/wire/host-fs.ts` — только zod и типы S1:

```ts
export const HostFsContract = {
  list:   { input: { path: ResourcePath, cursor: string|null, limit: ≤1000 }, output: ListPage },
  stat:   { input: { path }, output: Entry | null },
  read:   { input: { path, offset: Size, length: ≤ 4 MiB, expect: Fingerprint|null }, output: { b64: string } },
  writeOpen:   { input: { target: ResourcePath }, output: { session: uuid, tempName: NameSegment } },
  writeChunk:  { input: { session, offset: Size, b64 ≤ 4 MiB }, output: {} },
  writeCommit: { input: { session, replace: boolean, expectTarget: Fingerprint|null }, output: Fingerprint },
  writeAbort:  { input: { session }, output: {} },
  mkdir:  { input: { path }, output: {} },
  rename: { input: { from, to, replace: boolean }, output: {} },
  remove: { input: { path, kind: EntryKind }, output: {} },
  copyWithin: { input: { from, to, replace }, output: Fingerprint },
  sha256: { input: { path }, output: { hex } },
  home:   { input: {}, output: { path: ResourcePath, caseSensitive: boolean } },
};
// Ошибки — CommanderErrorShape в теле отказа (без stack, без абсолютных путей вне запроса).
```

Обработчики `src/adapters/bb/host-fs/`:

- Пути: байты сегментов → `Buffer` пути (без декодирования); проверка
  каждого компонента `lstat`, чтение/запись с `O_NOFOLLOW` для последнего
  компонента; симлинк в пути к цели записи → `permission_denied` (не
  следовать). Источник-симлинк копируется как симлинк только в S2-плане
  (`kind: "symlink"`) — здесь `read` симлинка → `unsupported`.
- `list` — `opendir` по страницам, курсор — индекс + `ino` каталога
  (изменился → `changed_since_plan`); `size` строкой из `bigint: true`
  `lstat`; `mtimeNs` из `mtimeNs`, precision по платформе (`ns` на
  APFS/ext4; при нуле младших 6 цифр не понижать — честно `ns`).
- `read` — сверка `expect` (size + mtimeNs) по `fstat` открытого
  дескриптора, затем `read` по offset.
- Запись: temp `.<name>.commander-<uuid>.part` в каталоге цели
  (`wx`, 0600), сессии ≤ 8, TTL простоя 120 с (abort); `writeCommit` —
  `fsync`, затем `replace=false`: `link(temp, target)` + `unlink(temp)`
  (EEXIST → `already_exists`); `replace=true`: сверка `expectTarget` и
  `rename(temp, target)`; права результата — `0644 & ~umask` (не копировать
  0600 temp).
- `remove` каталога — только пустой (`rmdir`); файл — `unlink`.
- Имена на хостах Windows (`process.platform === "win32"` в host entry):
  сегмент, который создаётся или в который переименовывают (`writeOpen`,
  `mkdir`, `rename` — цель, `copyWithin` — цель), отклоняется ошибкой
  `invalid_name`, если содержит `\\`, `:`, управляющие символы U+0000–U+001F,
  `<`, `>`, `"`, `|`, `?`, `*`, оканчивается точкой или пробелом, или его
  основа без расширения (без учёта регистра) — зарезервированное имя `CON`,
  `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` (`nul.txt` тоже
  отклоняется). Чтение и листинг существующих имён не фильтруются. На POSIX —
  как сейчас: запрещены только `/` и `\0` (их уже не пропускает
  `NameSegment` S1). Код `invalid_name` берётся из `ErrorCode` S1; в ветке S1
  на `8dd22857` его ещё нет — если к началу S4 он не слит, стоп и вопрос в
  тред Commander, не подменять `invalid_path`.
- Ошибки `errno` → `ErrorCode`: ENOENT→not_found, EEXIST→already_exists,
  EACCES/EPERM→permission_denied, ENOSPC→no_space, EROFS→read_only,
  ENOTDIR/EISDIR, ELOOP→permission_denied.
- `lifecycle.signal` / `dispose` — закрыть дескрипторы, удалить temp
  незавершённых сессий.

`local-provider.ts` — `FileProvider` поверх клиента host RPC с
`capabilities`: list, stat, read, write, mkdir, rename, remove,
atomicReplace, serverSideCopy, seek, checksum (trash — нет в v1).

## Проверки

Интеграционные тесты на реальной ФС во временном каталоге (`tests/host-fs/`),
обработчики вызываются напрямую (без BB):

- Имена: `Привет.txt`, `😀 emoji.bin`, имя с байтом 0xFF (создаётся через
  `Buffer`) — `list` возвращает байтовый сегмент `{b:"…"}` ровно с этими
  байтами.
- Разреженный файл 5 GiB (`truncate`) → `size === "5368709120"`.
- `read` с устаревшим `expect` → `changed_since_plan`.
- Запись 3 кусками + commit → содержимое побайтно, temp исчез, права 0644
  (с umask 022).
- commit `replace=false` при существующей цели → `already_exists`, цель не
  тронута, temp удалён после `writeAbort`.
- Цель — симлинк на файл вне каталога → `permission_denied`, файл вне не
  изменён (symlink escape).
- `remove` непустого каталога → ошибка, ничего не удалено.
- Проверка имён Windows — чистая функция (`host-fs/names.ts`), тестируется
  на любой ОС с явным параметром платформы: `win32` отклоняет `a:b`, `a\\b`,
  `CON`, `con.txt`, `NUL`, `COM1.log`, `LPT9`, `name.`, `name ` → все
  `invalid_name`; принимает `CONSOLE`, `COM10`, `nul_`, `Привет.txt`; `posix`
  принимает `a:b`, `CON`, `name.`. Плюс один тест на уровне обработчика
  `mkdir` с платформой `win32` → `invalid_name`, каталог не создан.
- Каталог без прав на чтение (chmod 000) → `permission_denied`.
- TTL: сессия без активности (инъекция таймера) → temp удалён.
- `local-provider` с фейковым host-клиентом: перевод ошибок и `Size`.

## Ожидаемый diff

1 core-файл, ~5–8 файлов адаптера, тесты; ~1000–1500 строк.
