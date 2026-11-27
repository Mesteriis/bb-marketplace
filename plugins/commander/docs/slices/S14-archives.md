# S14. Архивы как источник и создание — спецификация helper-протокола

Статус: **черновик на согласование** (тред Commander `thr_ba4dpyzux4`), кода нет.
Основание: ADR 0002 (accepted), [план 2a, задача 7](../plans/stage-2a.md),
[приёмка S14](../../research/stage-2-libs.md#приёмка-s14), `docs/security.md`.
Исполнитель: тред `thr_c6npqvkrkw`.

## 1. Границы среза

Входит: чтение ZIP/ZIP64/TAR как панель-источник (`archive:<uuid>`), распаковка
(= план `copy`), создание ZIP/TAR (= план `pack`), пароль владельца, helper.
Не входит (явно отклоняется кодом `unsupported`, не молчаливо): изменение
существующего архива; `.tar.gz/.tgz/.tar.xz` и другие сжатия TAR (в ADR только
USTAR/PAX, `flate2` не в зависимостях); 7z/RAR; многотомные ZIP; sparse TAR;
шифрованный TAR; запись ZipCrypto; не-arm64/не-macOS.
Распаковка symlink/hardlink **не поддерживается**: `FileProvider` не умеет их
создавать. Такие записи показываются в списке и дают элементы плана `refused`
(§5).

## 2. Файлы

Из плана задачи 7: `src/core/archive-guard.ts`,
`src/adapters/bb/archive-provider.ts`, `src/adapters/bb/archive-writer.ts`;
правки `model.ts`, `permissions.ts`, `planner.ts`, `job-runner.ts`,
`migrations.ts`, `src/ui/pane.tsx` (каждая — отдельным блоком).

**Сверх списка плана (прошу подтвердить; без них helper не собрать и не
проверить):**

| Путь | Зачем |
|---|---|
| `src/core/wire/archive-protocol.ts` (+ тест) | zod-схемы кадров и сообщений, кодек кадров; без хоста, `src/core` импортирует только `zod` |
| `src/adapters/bb/archive-helper.ts`, `archive-helper-integrity.ts` (+ тесты) | запуск, SHA-256 до `spawn`, рукопожатие, жизненный цикл; образец — `plugins/remote-hub/src/adapters/bb/helper-integrity.ts` |
| `helper/Cargo.toml`, `helper/Cargo.lock`, `helper/src/**`, `helper/tests/**` | Rust-helper `commander-archive-helper` |
| `bin/commander-archive-helper`, `bin/SHA256SUMS` | поставляемый бинарник и сумма в Git |
| `scripts/helper-sums.mjs`, `scripts/check-build-output.mjs` | как у Remote Hub; в `package.json` — `build:helper`, `helper:sums`, `check:build` (запускает `check-manifests`) |
| `package.json` | только `scripts` и `files`/`bb`-поля, нужные для `bin/` |
| корневой `THIRD_PARTY_NOTICES.md` | крейты helper: `zip` 8.6.0, `tar` 0.4.46 и их транзитивные (список — `cargo metadata`, фиксируется в записи) |
| `.gitignore` | `helper/target/` |

## 3. Процесс helper

- Бинарник `bin/commander-archive-helper`, `cargo build --release --locked
  --target aarch64-apple-darwin`, `--remap-path-prefix` как у Remote Hub (без
  домашнего каталога в бинарнике). Крейты зафиксированы `=`:
  `zip =8.6.0` (`default-features=false`, `deflate`, `aes-crypto`),
  `tar =0.4.46` (`default-features=false`), `libc`, `serde`/`serde_json`,
  `base64`, `zeroize`. Новые зависимости — только с записью в notices.
- Платформа: `process.platform === "darwin" && process.arch === "arm64"`;
  иначе `ArchiveProvider` не создаётся, UI/агент получают ошибку
  `archives_unavailable` с текстом «Архивы недоступны: нет helper для
  платформы». Никакого JS-fallback.
- Запуск: `experimental_spawnHostProcess` (как Remote Hub), абсолютный путь,
  `env` очищен (без `HOME` с паролями и т. п.; только `PATH=/usr/bin:/bin`),
  `argv = []`, **единственный** допустимый аргумент `--version` (печатает
  `commander-archive-helper <версия>` и выходит). Пароль/пути в argv/env не
  передаются.
- До spawn: `checkHelperIntegrity(path)` — файл есть, регулярный, не symlink,
  `SHA256SUMS` рядом: ровно одна строка, `<64 hex>  commander-archive-helper`,
  сумма совпала, иначе `helper_checksum_failed` (`no_sums`, `malformed_sums`,
  `not_listed`, `duplicate`, `symlink`, `mismatch`). Режима «без проверки» нет.
  Тесты — те же литералы, что в `helper-integrity.test.ts` Remote Hub.
- Один процесс на открытый архив (изоляция памяти и сбоев; пароль не живёт в
  общем процессе). Срок жизни: закрытие stdin = выход; простой без запросов
  10 мин = выход (`idle_exit`); отмена задания, `close`, выгрузка плагина —
  `SIGTERM`, через 2 с `SIGKILL`, потоки закрываются. Не больше 4 одновременных
  helper-процессов (`too_many_open_archives`).
- Лимит адресного пространства: `setrlimit(RLIMIT_AS)` 1 ГиБ при старте
  (защита от ошибок в подсчёте), `RLIMIT_CORE=0` (пароль не попадает в core).
- Helper читает архив **только по файловому дескриптору, который сам открыл**
  (`O_RDONLY|O_NOFOLLOW|O_CLOEXEC`, затем `fstat` — регулярный файл). Предпроверка
  и разбор идут по одному дескриптору. Сетевые источники адаптер сначала
  копирует в приватную локальную копию (§7).
- Helper не пишет ничего, кроме: своего stdout (кадры) и каталога staging
  для `pack` (§6). Целевой FS задания helper не видит.

## 4. Кадры

```
[ u32 LE длина тела ][ тело ]
тело[0] = вид:  0x01 control (UTF-8 JSON)
                0x02 data    (тело[1..5] u32 LE reqId, тело[5..] байты)
                0x03 secret  (тело[1..5] u32 LE reqId, тело[5..] UTF-8 пароль)
```

- Потолок кадра: control ≤ 1 МиБ; data ≤ 4 МиБ + 5 (`READ_CHUNK_MAX`);
  secret ≤ 1 КиБ. Превышение, неизвестный вид, обрыв на середине кадра —
  фатальная `protocol_error`: процесс выходит с кодом 2, адаптер закрывает
  ресурс. Длина читается до выделения буфера; выделение не больше потолка.
- Версия протокола `PROTOCOL_VERSION = 1`; первый кадр helper → адаптеру:
  `{"t":"hello","protocol":1,"helper":"0.1.0","zip":"8.6.0","tar":"0.4.46"}`.
  Адаптер сверяет `protocol` и `helper` с ожидаемыми константами; несовпадение —
  `helper_version_mismatch`, процесс завершается. Таймаут hello 5 с.
- Запросы идут с `reqId` (u32, выдаёт адаптер, не 0). Ответ — control
  `{"t":"ok"|"err","req":N,…}`; ответ `read` — data-кадр с тем же `reqId` +
  control `ok` после него. Запросы обрабатываются **последовательно** (один
  в полёте), кроме `cancel`. Параллелизм — несколькими процессами.
- Пароль: отдельный кадр `0x03`, **только** в ответ на `{"t":"need_password",
  "req":N}`; никогда в control JSON. Helper хранит его в `Zeroizing<Vec<u8>>`,
  стирает при `close`/выходе/неверном пароле сверх 3 попыток; не логирует, не
  кладёт в сообщения об ошибках. Адаптер держит пароль в замыкании
  `ArchiveProvider` (память процесса плагина), стирает `fill(0)` буфера после
  отправки и при закрытии архива. В БД, настройки, логи, ответы RPC и
  агенту пароль не попадает; у агента нет tool, принимающего пароль (§8).
- Логи helper — stderr, строго без путей содержимого и без имён записей
  (только коды и счётчики); адаптер читает не больше 64 КиБ stderr.

### Запросы

Все пути в сообщениях — `pathB64` (base64 сырых байт), имена записей — тоже
base64 сырых байт: форматы допускают не-UTF-8 имена.

| `t` | Поля | Ответ `ok` |
|---|---|---|
| `open` | `path`, `format: "auto"\|"zip"\|"tar"`, `limits: {maxTotalBytes, maxEntries, maxRatio}`, `expect?: {size, mtimeNs}` | `{handle:1, format, fingerprint:{size, mtimeNs, dev, ino}, entries, totalSize, totalCompressed, encrypted:boolean, metaBytes}` или `need_password` сначала, если шифрованы имена/каталог (WinZip AES шифрует тела; имена в ZIP открыты — пароль нужен только на `read_open`) |
| `list` | `prefix` (байты, `""` = корень), `cursor: string\|null`, `limit ≤ 1000` | `{entries: ArchiveEntry[], cursor}` — прямые потомки `prefix`, в порядке индекса; промежуточные каталоги, которых нет в архиве, синтезируются (`synthetic:true`) |
| `stat` | `nameB64` | `{entry: ArchiveEntry\|null}` |
| `read_open` | `id` (индекс записи) | `{stream, size}`; шифрованная запись — `need_password` |
| `read` | `stream`, `length ≤ 4 МиБ` | data-кадр с байтами (0 байт = конец) и `ok{pos}` |
| `read_close` | `stream` | `ok` |
| `verify` | — | `{changed:boolean}` (`fstat(fd)` против `stat(path)`: размер, mtime, dev, ino) |
| `cancel` | `req` | `ok` (прерывает текущий запрос с `err cancelled`) |
| `pack_open` | см. §6 | |
| `close` | — | `ok`, затем выход 0 |

`ArchiveEntry`:
`{id:number, nameB64, name:string, nameLossy:boolean, kind:"file"|"dir"|"symlink"|"hardlink"|"special", size:string(bigint), csize:string, mtime:number|null, mode:number|null, encrypted:boolean, linkB64?:string, refused?:RefusedReason, synthetic?:boolean}`.
`name` — декодирование для показа: UTF-8; для ZIP без флага UTF-8 — CP437
(как делает `zip`), сырые байты остаются в `nameB64`; `nameLossy` — декодирование
потеряло данные. Идентификатор записи для чтения — `id`, а не имя.

Каждый `read_open`/`read` и каждый `list`/`stat` перед работой делает
`verify` внутри helper; расхождение — `err changed_since_open`
(адаптер превращает в `changed_since_plan`). Чтение записи — только
последовательное по `stream`; для произвольного `offset` адаптер закрывает
поток и открывает заново (повторное чтение тоже считается в лимитах).

## 5. Защиты (все до буферизации и до публикации)

Единая точка: helper отказывает **при `open`**, адаптер (`archive-guard.ts`)
повторяет проверки по именам и лимитам при построении плана — вторая линия.

### 5.1 TAR (свой сканер до `tar::Archive`)

1. Один проход по 512-байтовым заголовкам (`pread` по `offset`, тела
   пропускаются `seek`, буфер фиксированный 512 Б). Проверяются: checksum
   (знаковый и беззнаковый вариант), `magic` (`ustar\0`/`ustar `), тип.
   Допустимые типы: `0`/`\0` файл, `5` каталог, `2` symlink, `1` hardlink,
   `3`,`4`,`6` special (`special`, не распаковываются), `L`,`K`,`x`,`g`
   служебные. Любой другой, `S` (sparse), `D`/`M`/`V` — `unsupported_format`.
2. Размер: octal (с проверкой цифр) или base-256 (бит 7 первого байта) —
   `checked_*` арифметика; отрицательное base-256, переполнение `u64`, а также
   `offset + 512 + round_up(size, 512) > file_len` → `truncated` или
   `size_overflow`. Тела `L,K,x,g` проверяются **до чтения**: ≤ 1 МиБ каждое,
   сумма служебных ≤ 4 МиБ на архив → `meta_too_large`. Служебные записи
   входят в счётчик записей (`maxEntries`).
3. Только после этого служебное тело читается в буфер, не больше проверенного
   размера. PAX разбирается своим ограниченным разбором (`<len> k=v\n`,
   `len` ≤ размер тела, без вложенных записей); ошибка формата —
   `bad_pax`. PAX `size` (и `GNU.sparse.*`) → `unsupported_pax_size`,
   `unsupported_format`: переопределения размера не принимаются.
4. Затем `tar::Archive` на том же дескрипторе (вложенные L/K/PAX уже проверены)
   даёт имена/ссылки; расхождение числа записей между сканером и крейтом —
   `scan_mismatch` (отказ).
5. Счётчики: `entries ≤ maxEntries`; `Σ size ≤ maxTotalBytes`;
   `Σ size ≤ maxRatio × file_len` — на этапе `open` по заявленным размерам (для
   TAR сжатие отсутствует, `file_len` ≈ Σ тел, ratio ≈ 1; проверка нужна для
   sparse-подобных подделок).

### 5.2 ZIP (свой разбор до `ZipArchive::new`)

1. EOCD ищется в хвосте `min(file_len, 22 + 65535)` байт; комментарий обязан
   дойти ровно до конца (иначе `bad_eocd`). Если поля EOCD равны `0xFFFF`/
   `0xFFFFFFFF` — ZIP64 locator (ровно 20 байт перед EOCD, сигнатура) и ZIP64
   EOCD по проверенному смещению; усечённый locator → `bad_zip64`.
2. Отказ: номер диска ≠ 0, диск каталога ≠ 0, число записей на диске ≠ общему
   (`multi_volume`); смещение/размер каталога вне файла, `offset + size >
   eocd_pos`, переполнение (`checked_add`) → `bad_range`; число записей
   > `maxEntries` → `too_many_entries` (границы: 100 000 проходят, 100 001 — нет);
   размер каталога > 64 МиБ → `directory_too_large`.
3. Каталог проходится ограниченными чтениями (буфер ≤ 64 КиБ): для каждой
   записи сигнатура `PK\1\2`, длины `name/extra/comment` внутри каталога,
   `local header offset + 30 ≤ cd_offset`, ZIP64 extra разобран, размеры/
   смещения по `u64`; фактическое число = заявленному, иначе `count_mismatch`.
   Имя ≤ 4096 байт (`name_too_long`). Сырые имена пишутся в индекс
   helper-а (HashSet по сырым байтам; ≤ 32 МиБ суммарно) — **точные повторы
   → `duplicate_name` для всего архива** (крейт скрыл бы второй).
4. Только после успеха — `ZipArchive::new` на том же дескрипторе.
   `enclosed_name()` — вторая линия: `None` → запись `refused: "unsafe_name"`.
5. Заявленные размеры суммируются с проверкой `Σ usize ≤ maxTotalBytes`
   (`limit_exceeded`) и по записи `usize ≤ maxRatio × csize` с порогом
   (см. 5.3) — быстрый отказ на этапе `open`.
6. Шифрование: помечается `encrypted` (флаг bit 0, AES-extra `0x9901`). Без
   пароля чтение шифрованной записи — `password_required`; ZipCrypto с
   верным 1-байтовым заголовком, но неверным CRC — `bad_password_or_corrupt`
   (запись дочитывается и проверяется CRC, как в пробе `compat`).
   Сжатие кроме `Stored`/`Deflate` — `unsupported_compression`.

### 5.3 Реально обработанные байты (при чтении)

Внутренний буфер декодирования 8 КиБ; после каждого буфера: `out_total`
(на архив), `out_entry`, `in_entry` (прочитано сжатых байт записи — счётчик
над `Read`). Отказ `limit_exceeded` и очистка потока, если
`out_total > maxTotalBytes`, или `out_entry > maxRatio × in_entry` при
`out_entry ≥ 64 КиБ` (порог защищает крошечные хорошо сжимаемые файлы;
**прошу подтвердить 64 КиБ**), или `out_entry ≠ заявленному usize` в конце
(`size_mismatch`), или CRC не сошёлся (`crc_mismatch`), или данные кончились
раньше (`truncated`). Превышение отношения — не более чем на один буфер:
для fixture «ratio 1:1000» записанные байты < 101 × сжатых.

### 5.4 Имена и типы (helper + `archive-guard.ts`)

`checkEntryName(name: Uint8Array | string): NameSegment[] | "refused"` — отказ
для: пустого имени и пустых сегментов (кроме одного завершающего `/`), `..`,
`.` внутри пути, абсолютных (`/…`), дисковых (`C:`, `\\?\…`, UNC),
обратной косой черты (трактуется как разделитель **и** отказ: имя с `\` в
2a — `refused: "backslash"`), NUL, управляющих символов < 0x20,
сегмента > 255 байт, не-UTF-8 имён при распаковке в цель (в списке они
показываются через `name`; распаковка такой записи — `refused: "name_encoding"`).
`RefusedReason`: `unsafe_name | backslash | name_encoding | link_not_supported |
link_escapes | special_file | duplicate_name | name_collision | encrypted_no_password`.
Symlink/hardlink: всегда `link_not_supported`; если цель разрешается за корень
(нормализация по сегментам) — `link_escapes` (точнее, приоритет выше).
Коллизии после нормализации (NFC, регистр на регистронезависимой цели,
`a` файл vs `a/` каталог) — `name_collision` на этапе плана (адаптер, не helper);
запись `x/..` и запись через ранее виденную ссылку невозможны (ссылки не
создаются, `mkdir` планировщика отказывает, если путь существует не как каталог).

## 6. Создание (`pack`)

`{"t":"pack_open","format":"zip"|"tar","staging":pathB64,"zip":{"encryption":"none"|"aes256"}?}` →
`ok{packId}`; для `aes256` перед первой записью — `need_password`/secret.
Staging — приватный файл в каталоге данных плагина (`mkdtemp`, 0700; файл
создаёт helper `O_EXCL|O_NOFOLLOW`, 0600; путь выдаёт адаптер). Далее:

| `t` | Поля | Ответ |
|---|---|---|
| `pack_add` | `nameB64`, `kind:"file"\|"dir"`, `size` (для file), `mtime`, `mode` | `ok` |
| `pack_data` + data-кадр | `reqId`, байты ≤ 4 МиБ | `ok{written}` (по одному в полёте — окно 1 кадр) |
| `pack_end_entry` | — | `ok` (число записанных байт = `size`, иначе `size_mismatch`) |
| `pack_finish` | — | `ok{size, sha256}` — размер и SHA-256 staging-файла |
| `pack_abort` | — | `ok`; staging удаляется |

Имена записей проверяются тем же `checkEntryName` (на стороне helper и
адаптера); повторы — `duplicate_name`; symlink/special в `pack` — `unsupported`.
Лимиты `pack` те же (`maxEntries`, `maxTotalBytes`). ZIP — `Deflate`
(по умолчанию) или `Stored`, ZIP64 при необходимости (`large_file(true)`
по размеру); AES — `AesMode::Aes256`; TAR — `tar::Builder` USTAR, PAX для
длинных имён. Ошибка/отмена → `pack_abort`/выход процесса → staging
удаляется (адаптер дублирует `rm` при падении helper).
Публикация: `archive-writer.ts` читает staging локально (`node:fs`), пишет
через `WriteSession` цели (`openWrite` → `write` → `commit({replace,
expectTarget})`) — то есть `pack` = обычное задание с temp + rename и
`expectTarget` (локальный и SFTP). После commit staging удаляется.
Проверка «pack 3 файлов → list показывает те же имена и размеры» — через
тот же `open`/`list` helper.

## 7. TypeScript-сторона

- `EndpointId` += `archive:<uuid>` (как `sftp:`; regex расширяется, строки
  этапа 1 читаются без изменений). Реестр `archives`: `uuid → {sourceRef,
  fingerprint (size+mtime источника), localCopy?: path, limits}`; живёт в
  памяти сервера плагина + строка в БД (миграция, тест на fixture-БД этапа 1
  `main@b44884df`) для восстановления очереди; пароль в реестр/БД не
  пишется.
- Remote-источник: перед `open` адаптер копирует архив в приватный файл
  (каталог данных плагина, 0600) через `provider.read` кусками; лимит —
  `maxTotalBytes`-подобный `maxArchiveFileBytes` = 10 ГиБ **и** свободное место
  (`statfs`) с запасом; прогресс/отмена — как у задания; копия удаляется при
  закрытии архива/выгрузке. Источник проверяется `expect` до и после копии.
- `ArchiveProvider implements FileProvider` (`capabilities: {}`): `list` →
  `list`, `stat` → `stat`, `read(path, offset, length, expect)` → `read_open`
  (с кэшем одного текущего потока) + `read`; `expect` сверяется с
  fingerprint записи; `openWrite/mkdir/rename/remove/copyWithin/sha256` —
  `CommanderError("unsupported")`. Fingerprint записи: `{size, mtime}`
  из архива; fingerprint самого архива проверяется в helper (`verify`) при
  каждом чтении — смена файла = `changed_since_plan`.
- Распаковка: `buildPlan` с источником `archive:` — обычный `copy` на
  каждый файл, `mkdir` на каталоги. Для плана helper-ом уже проверены лимиты
  (`open`); `archive-guard.ts` строит для плана: элементы `refused`
  (§5.4), счёт записей/байт (`limit_exceeded` при плане для 100 001),
  коллизии. Байты тела при выполнении считает helper (§5.3): превышение —
  элемент `failed limit_exceeded`, temp удаляется раннером (stage-1).
- Пароль: RPC `archive.password {archiveId, password}` вызывается **только
  из диалога UI** (владелец); не входит в agent tools и CLI; ответ на
  `password_required` — диалог `needs_password` в строке архива. Агентский
  `commander_*` на зашифрованном архиве получает `password_required`, а не
  запрос пароля.
- Права: `pack`: источники `read`, цель `write`; распаковка — как `copy`
  (`read` источника, `write` цели).

## 8. Тесты (литеральные; fixtures генерируются в `mkdtemp`)

Генератор fixtures — отдельный тестовый модуль на `node:zlib` (ZIP/TAR
собираются байтами руками; helper их не создаёт). Рассматриваются как
Rust-тесты (`helper/tests`, бинарные fixtures через `cargo test`) **и** TS-тесты
(реальный helper по `HELPER_BIN` или `bin/…`, `describe.skipIf` на не arm64).

Core / guard (vitest, без helper):
- `checkEntryName`: `"../x"`, `"/abs"`, `"C:\\x"`, `"a/../../b"`, `"a\\b"`, `"a//b"`,
  `"a\0b"` → `"refused"`; `"a/b/"` → `["a","b"]`.
- 100 001 записей в индексе → `limit_exceeded` при плане; 100 000 проходит.
- symlink внутри цели и снаружи → `link_not_supported`/`link_escapes`.
- пересечение имён после NFC/регистра → `name_collision`.

Интеграция с helper (`open` и чтение):
1. TAR `L`, `K`, `x`, `g` с заявленным телом 256 МиБ → `meta_too_large`, helper
   прочитал ≤ 512 + 512 байт (счётчик через `pread`-обёртку; тест в Rust
   проверяет число прочитанных байт; отдельный процесс, пик RSS ≤ 32 МиБ).
2. Служебная запись ровно 1 048 576 → читается; 1 048 577 → `meta_too_large`;
   цепочка служебных суммой 4 МиБ + 1 → `meta_too_large`; `bad_pax`; PAX `size`
   → `unsupported_pax_size`; усечение → `truncated`; base-256 переполнение →
   `size_overflow`.
3. ZIP/ZIP64: 100 001 записей, каталог 64 МиБ + 1, диапазон за файлом, диск ≠ 0,
   count_mismatch, усечённый ZIP64 locator → отказ **до** `ZipArchive::new`
   (в Rust — счётчик/хук, что конструктор не вызван); 100 000 — проходит.
4. Бомба ZIP 1:1000 → `limit_exceeded`, записано < 101 × сжатых; TAR/ZIP сверх
   `maxTotalBytes`, усечённое тело, `size_mismatch`, `crc_mismatch` → отказ, ничего
   не опубликовано.
5. `../x`, `/abs`, `C:\x`, `a\b`, symlink/hardlink наружу, два одинаковых имени
   (`duplicate_name` для всего архива), запись через ссылку — каталог цели и
   внешний файл (с заранее известным содержимым) не изменены.
6. Пароль: верный/неверный, ZipCrypto с «счастливым» заголовком (литерал из
   пробы `compat`), CP437 `café.txt`/сырые `caf\x82.txt`; пароль не встречается
   в argv, stderr, ответах и дампе трафика (тест ищет литерал-пароль).
7. Целостность: файл подмен SHA / нет `SHA256SUMS` / symlink — `helper_checksum_failed`,
   процесс не запущен (счётчик spawn = 0); `--version` совпадает с `package.json`.
8. Архив изменён на диске между `open` и `read` → `changed_since_plan`.
9. Pack: 3 файла → ZIP и TAR → `open`+`list`: те же имена и размеры; AES — без
   пароля `password_required`; прерывание → staging удалён.
10. Миграция: строки заданий этапа 1 (fixture БД `main@b44884df`) читаются.
11. Платформа: `process.platform !== "darwin"` → `archives_unavailable`,
    helper не запускается.
12. Завершение: отмена и выгрузка → процесс завершён (проверка по pid), потоки закрыты.

UI (снимки 1440×900 и 768×900): Enter на архиве → панель-источник, строка
«Нужен пароль» → диалог, распаковка с отказами (`refused` с причиной),
создание архива; артборды `docs/design/v2/stage-2a/`.

## 9. Вопросы и отклонения (на решение до кода)

1. **Файлы сверх плана** (§2) — подтвердить владение ими за S14, особенно
   `package.json` (скрипты), `scripts/`, корневой `THIRD_PARTY_NOTICES.md`.
2. `.tar.gz/.tgz` не поддерживаются (ADR — только USTAR/PAX). Нужна ли
   поддержка через `flate2` в 2a? По умолчанию — нет.
3. Точные повторы имён в архиве — отказ для всего архива (TAR с дубликатами
   от `tar -r` не откроется). Альтернатива — показывать последнее вхождение.
4. Порог 64 КиБ для проверки коэффициента (§5.3).
5. Пароль живёт, пока открыт архив; при перезапуске плагина вводится заново.
6. Сборка helper: `cargo` есть локально (rustc 1.97); бинарник коммитится как у
   Remote Hub, подпись ad-hoc; карантин на чистой машине — проверка до релиза,
   не в этом срезе.
7. Изменение существующего ZIP/TAR — `unsupported` (ADR: сначала проверка метаданных).
