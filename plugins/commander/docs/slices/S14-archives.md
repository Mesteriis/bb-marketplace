# S14. Архивы как источник и создание — спецификация helper-протокола

Статус: **ревизия 2 после ревью astra+opus (repair)**, кода нет; ждёт повторного ревью.
Решения координатора A–H и правки ревью 1–7 внесены ниже (§3, §4, §5, §6, §7, §10, §11).
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
| `package.json` | `scripts` (`build:helper`, `helper:sums`, `check:build`) и поле `files` (включить `bin/commander-archive-helper`, `bin/SHA256SUMS`); остальное не трогаю; файл правит и S18 — слияние по очереди |
| корневой `THIRD_PARTY_NOTICES.md` | запись по `cargo metadata --locked --format-version 1 --filter-platform aarch64-apple-darwin`: **каждый** крейт из `Cargo.lock`, попадающий в бинарник (имя, версия, лицензия, источник), `zip` 8.6.0 и `tar` 0.4.46 отдельными строками; текст лицензий приложен, если требует лицензия; сверка списка скриптом `scripts/check-notices.mjs` (расхождение с `cargo metadata` — ошибка `check:build`) |
| `.gitignore` | `helper/target/` |
| `src/core/errors.ts`, `errors.test.ts` | `ErrorCode += invalid_archive`, `reason?: ArchiveReason` (§10) — разрешено координатором |

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
- Ресурсы (решение D). Ядро macOS может не применять `RLIMIT_AS`: первым
  шагом среза — тест на macOS arm64 (процесс выделяет сверх лимита; результат
  записывается в спецификацию и в `hello.rlimit_as: "enforced"|"not_enforced"|
  "failed"`). **На rlimit не опираемся.** Защита: ограниченные буферы (§4–§5),
  `RLIMIT_CPU` (по умолчанию 600 с суммарно на процесс), `RLIMIT_CORE=0`
  (пароль не попадает в core), тайм-аут на запрос **30 с без единого кадра**
  (длинный `read` шлёт data-кадры и не упирается; по истечении — `helper_crashed`
  с причиной `timeout`, SIGKILL), и **сторож RSS в адаптере**: опрос
  `proc_pidinfo(PROC_PIDTASKINFO)` (при недоступности — `ps -o rss= -p`) раз в
  1 с, порог 512 МиБ → SIGTERM, через 2 с SIGKILL, ожидание выхода процесса
  (`exit`-событие) до освобождения слота. Если `hello` сообщает, что rlimit не
  установился, адаптер продолжает работу только со сторожем (вывод в журнал
  кодов, не в UI). Тесты: helper, раздувающий память (тестовая feature
  `test-hooks`, не в релизном бинарнике), убит сторожем ≤ 3 с; зависший без
  кадров запрос — через 30 с (в тесте таймаут настраивается).
- Helper читает архив **только по файловому дескриптору, который сам открыл**,
  и открывает его обходом от корня endpoint (решение A): `open` получает
  `root` (корень `host:<id>` или каталог приватной копии, байты) и `segments`
  (сегменты пути, байты); helper делает `openat` по сегментам с
  `O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC` для каталогов и
  `O_RDONLY|O_NOFOLLOW|O_CLOEXEC` для последнего, затем `fstat` — регулярный
  файл. Абсолютный путь одной строкой helper не принимает. Предпроверка и разбор
  идут по одному дескриптору (Node не имеет `openat`, поэтому обход делает
  helper). Адаптер до `open` сверяет fingerprint архива с `expect` от
  `FileProvider` (`stat`), после `open` и после каждого запроса — снова; при
  расхождении — `changed_since_plan`, helper закрывается.
- Helper не пишет ничего, кроме: своего stdout (кадры) и каталога staging
  для `pack` (§6). Целевой FS задания helper не видит.

## 4. Кадры

```
[ u32 LE длина тела ][ тело ]
тело[0] = вид:  0x01 control (UTF-8 JSON)
                0x02 data    (тело[1..5] u32 LE reqId, тело[5..] байты)
                0x03 secret  (тело[1..5] u32 LE reqId, тело[5..] UTF-8 пароль)
```

- Потолок и минимум кадра. Длина тела читается до выделения буфера.
  control: `2 ≤ длина ≤ 1 МиБ` (`kind` + минимум `{}`); data: `5 ≤ длина ≤ 4 МиБ
  + 5` (kind + reqId; пустая полезная нагрузка допустима как «конец»); secret:
  `6 ≤ длина ≤ 1 КиБ + 5` (хотя бы один байт пароля). Длина 0 запрещена.
- **Направления.** `0x01` — в обе стороны; `0x02` — в обе стороны (helper →
  адаптер: ответ `read`; адаптер → helper: только `pack_data`); `0x03` — **только
  адаптер → helper**. Кадр не того направления — `protocol_error`.
- **Симметричная фатальная `protocol_error`** (на **обеих** сторонах:
  helper — выход с кодом 2; адаптер — SIGKILL helper, ожидание выхода,
  закрытие ресурса, `helper_crashed`): неизвестный вид; длина вне диапазона;
  невалидный JSON; невалидный UTF-8 (control и secret); чужой/неактивный
  `reqId`; `secret` без активного `need_password`; повторный `hello`;
  data-кадр без запроса, ожидающего data; обрыв на середине кадра; EOF между
  data-кадром и `ok`; второй запрос при занятом (один в полёте); ответ с
  `req`, которого нет. Тесты на каждый пункт — в Rust (helper как приёмник) и в
  TS (адаптер как приёмник, поддельный helper).
- Версия протокола `PROTOCOL_VERSION = 1`; первый кадр helper → адаптеру:
  `{"t":"hello","protocol":1,"helper":"0.1.0","zip":"8.6.0","tar":"0.4.46"}`.
  Адаптер сверяет `protocol` и `helper` с ожидаемыми константами; несовпадение —
  `helper_version_mismatch`, процесс завершается. Таймаут hello 5 с.
- Запросы идут с `reqId` (u32, выдаёт адаптер, не 0). Ответ — control
  `{"t":"ok"|"err","req":N,…}`; ответ `read` — data-кадр с тем же `reqId` +
  control `ok` после него. Запросы обрабатываются **последовательно** (один
  в полёте), кроме `cancel`. Параллелизм — несколькими процессами.
- Пароль: отдельный кадр `0x03`, **только** в ответ на `{"t":"need_password",
  "req":N}`; никогда в control JSON. **Честная модель (решение F):**
  пароль **хранит только helper** (`Zeroizing<Vec<u8>>`, стирается при
  `close`/выходе/неверном пароле сверх 3 попыток; не логируется, не попадает в
  сообщения об ошибках). Адаптер держит пароль `Uint8Array` **только до
  подтверждения helper-ом** (`ok` на `need_password`) и сразу `fill(0)`; после
  этого пароля в процессе плагина нет — при рестарте helper (решение E, G)
  владелец вводит его заново. Кадр `0x03`: только адаптер → helper, только в
  ответ на `need_password` **активного запроса владельца**; payload `0x03`
  исключён из любой трассировки, дампов, `stderr`-зеркал, тестовых записей
  трафика (кодек не отдаёт payload `0x03` в `toString`/`inspect`/журнал;
  тест проверяет, что запись трафика содержит для `0x03` только длину, а
  пароль-литерал не встречается ни в записи, ни в argv/env, ни в stderr).
  В БД, настройки, логи, ответы RPC и агенту пароль не попадает; агентское
  чтение пароль владельца не использует — шифрованный архив для агента →
  `auth_failed`/`password_required`; tool, принимающего пароль, нет.
  **Остаточный риск (записан):** пароль приходит из диалога UI через RPC как
  JS-строка (не стирается GC), ключевой материал внутри крейта `zip` не
  обёрнут в `Zeroizing`; процесс helper живёт до `close`.
- Логи helper — stderr, строго без путей содержимого и без имён записей
  (только коды и счётчики); адаптер читает не больше 64 КиБ stderr.

### Запросы

Все пути в сообщениях — `pathB64` (base64 сырых байт), имена записей — тоже
base64 сырых байт: форматы допускают не-UTF-8 имена.

| `t` | Поля | Ответ `ok` |
|---|---|---|
| `open` | `rootB64`, `segmentsB64[]`, `format: "auto"\|"zip"\|"tar"`, `limits: {maxTotalBytes, maxEntries, maxRatio}`, `expect?: {size, mtimeNs}` | `{handle:1, format, fingerprint:{size, mtimeNs, dev, ino}, entries, totalSize, totalCompressed, encrypted:boolean, metaBytes}` или `need_password` сначала, если шифрованы имена/каталог (WinZip AES шифрует тела; имена в ZIP открыты — пароль нужен только на `read_open`) |
| `list` | `prefix` (байты, `""` = корень), `cursor: string\|null`, `limit ≤ 1000`; страница также ограничена **сериализованным размером control-кадра < 1 МиБ** (helper заканчивает страницу раньше и возвращает `cursor`; одна запись ≤ 16 КиБ в JSON гарантируется лимитом имени 4096 байт) | `{entries: ArchiveEntry[], cursor}` — прямые потомки `prefix`, в порядке индекса; промежуточные каталоги, которых нет в архиве, синтезируются (`synthetic:true`) |
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

**Барьер целостности (правка 1).** Данные записи нельзя отдавать в
`WriteSession.commit` до подтверждения целостности. Запрос
`{"t":"read_finish","stream":N}` → `ok{size, crc32:number|null, aes_auth:
boolean|null}` отдельным запросом: helper дочитывает поток до EOF записи,
сверяет фактический размер с заявленным (`size_mismatch`), CRC32 (`crc_mismatch`;
для TAR CRC нет — подтверждается только размер) или AES-аутентификацию
(`aes_auth_failed`). `readChunks` адаптера: не читает после заявленного размера
(`read` с `length` > остатка укорачивается; при `pos == size` не шлёт `read`),
для **пустой записи** `read` пропускается, а барьер `read_finish`
выполняется всё равно. Порядок раннера для записи: `read…` → `read_finish` →
`commit`. Ошибка `read_finish` → элемент `failed`, `abort()`, commit не
вызывается. Тесты: пустая запись → `read_finish` ok, файл создан пустым;
запись ровно в один чанк (4 МиБ); CRC неверен → отказ без commit; данные
усечены → отказ без commit.

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
   `size_overflow`. **Конец архива** — два нулевых блока подряд; один нулевой
   блок, за которым идёт ненулевой заголовок → `bad_tar`; отсутствие конца
   (EOF сразу после последнего тела) допускается как `truncated`-отказ
   только если тело не дочитано, иначе принимается; всё после двух нулевых
   блоков игнорируется (границы проверяются, содержимое не разбирается и не
   считается). **v7 без magic — отказ** (`unsupported_format`, записано
   ограничение). Тела `L,K,x,g` проверяются **до чтения**: ≤ 1 МиБ каждое,
   сумма служебных ≤ 4 МиБ на архив → `meta_too_large`. **Физические заголовки и
   логические записи различаются (правка 3):** `L/K/x/g` — физические блоки,
   входят в **ресурсный** лимит (1 МиБ каждый, 4 МиБ сумма; плюс общий потолок
   физических заголовков `maxEntries + 4096`), но **не** в число логических
   записей `entries`, которое сравнивается с `maxEntries`. Это одно правило для
   сканера и крейта: `scan_mismatch`, если число логических записей, найденных
   сканером, ≠ числу записей, выданных `tar::Archive`.
3. Только после этого служебное тело читается в буфер, не больше проверенного
   размера. PAX разбирается своим ограниченным разбором (`<len> k=v\n`,
   `len` ≤ размер тела, без вложенных записей); ошибка формата —
   `bad_pax`. PAX `size` (и `GNU.sparse.*`) → `unsupported_pax_size`,
   `unsupported_format`: переопределения размера не принимаются.
   **Записанное ограничение:** файлы > 8 ГиБ принимаются только в формате
   GNU base-256 (поле `size` заголовка); tar с PAX `size` для больших файлов
   отклоняется. Дубликаты считаются по **эффективному имени** (после
   L/PAX-подстановки): точный дубль → `duplicate_name` для всего архива.
   Тесты: корректные PAX `path` и GNU `L` открываются; точный дубль
   эффективного имени (в т. ч. через L против короткого имени) → отказ.
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
6. **Локальные записи (правка 4).** Для каждой записи диапазон
   `[local_offset, local_offset + 30 + n + m + csize)` (n, m — длины имени/extra
   **из локального** заголовка, читаются по `pread` 30 + n байт; data descriptor
   учитывается по флагу bit 3) должен лежать до `cd_offset`; диапазоны разных
   записей **не пересекаются** (сортировка по `local_offset`, проверка
   соседних; `overlapping_entries` — защита от zip-quine/«перекрытых» бомб);
   имя в локальном заголовке равно имени в центральном каталоге
   (`local_name_mismatch`). Тесты: пересекающиеся записи, локальная запись
   выходит за `cd_offset`, разные имена → отказ при `open`.
7. Шифрование: помечается `encrypted` (флаг bit 0, AES-extra `0x9901`). Без
   пароля чтение шифрованной записи — `password_required`; ZipCrypto с
   верным 1-байтовым заголовком, но неверным CRC — `bad_password_or_corrupt`
   (запись дочитывается и проверяется CRC, как в пробе `compat`).
   Сжатие кроме `Stored`/`Deflate` — `unsupported_compression`.

### 5.3 Реально обработанные байты (при чтении)

Внутренний буфер декодирования 8 КиБ; после каждого буфера: `out_total`
(на архив), `in_total`, `out_entry`, `in_entry` (прочитано сжатых байт —
счётчик над `Read`). Отказ `limit_exceeded` и очистка потока, если
`out_total > maxTotalBytes`; или **по записи** `out_entry > maxRatio × in_entry`
при `out_entry ≥ 65 536` (льгота 64 КиБ — **только для одной записи**:
крошечный хорошо сжимаемый файл); или **по архиву** `out_total > maxRatio ×
in_total` при `out_total ≥ 1 МиБ` (множество мелких записей льготой не
обходится). Общий коэффициент проверяется **при `open` по заявленным размерам**
и **при чтении по фактическим байтам до выдачи порции** в `WriteSession`
(порция не отдаётся, пока счётчики не обновлены и проверены). `maxRatio` по
умолчанию 100, владелец может поднять в настройках; текст отказа: «Архив
сжат сильнее допустимого (коэффициент > N:1); возможно, это архивная бомба.
Поднять предел можно в настройках». Границы-тесты: запись `out_entry` = 65 535
(льгота, отказа нет при ratio > 100) и 65 536 (проверка включается); архив из
10 000 записей по 32 КиБ с ratio 1000 → отказ по общему коэффициенту; или `out_entry ≠ заявленному usize` в конце
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
Лимиты `pack` те же (`maxEntries`, `maxTotalBytes`). **Источники
`pack` читаются с `expect` по fingerprint из плана** (`read(..., expect)`;
изменение → `changed_since_plan`, `pack_abort`). **Перед созданием staging —
`statfs` каталога staging: свободно ≥ ожидаемый размер (Σ размеров источников,
для ZIP без сжатия) + 64 МиБ, иначе `no_space` до `pack_open`.** ZIP — `Deflate`
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
- **Источник архива (решение A).** (1) Архив на endpoint **той же машины, что
  сервер плагина** (`host:<id>` совпадает с машиной сервера): без копии, helper
  открывает обходом от корня endpoint (§3), fingerprint сверяется до `open` и
  после каждого запроса. (2) **Любой другой endpoint** (SFTP, host другой
  машины): приватная копия в `experimental_paths.dataDir` (0600, `mkdtemp`
  0700) через `FileProvider.read` с `expect`; **перед копированием —
  одноразовая оценка объёма как в S10** (`estimateId`, привязка к инициатору,
  показывается объём чтения); агенту копия — только с правом `read` на файл
  архива **и** с оценкой (без `estimateId` — `consent_required`). Лимит
  `maxArchiveFileBytes` = 10 ГиБ и `statfs` с запасом; прогресс/отмена — как у
  задания. **Перед каждым запросом к копии** адаптер сверяет fingerprint
  исходного файла на endpoint; изменение → `changed_since_plan`. Копии
  удаляются при закрытии архива, при падении helper и **при старте плагина
  (сироты в каталоге копий без записи в реестре)**.
- **Права (решение B).** Чтение `archive:<uuid>` = право `read` на исходный ref
  архива (владелец и агент); распаковка = `copy` из `archive:` в цель — права
  как у `copy` (`read` источника, `write` цели). Реестр хранит исходный ref
  и проверяет grant при каждом запросе, а не при открытии.
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
- Права `pack`: источники `read`, цель `write`.

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

Добавлено ревью (A–H, правки 1–7):
13. `open` с корнем endpoint и сегментами: symlink в промежуточном сегменте и в
    последнем → отказ (`O_NOFOLLOW`); подмена файла после `open` → `changed_since_plan`,
    helper закрыт.
14. Не-локальный endpoint: приватная копия, `estimateId` обязателен для агента;
    изменение исходника между запросами → `changed_since_plan`; копии
    удалены при закрытии, падении helper и при старте (сироты).
15. Права: агент без `read` на файл архива не читает `archive:<uuid>`; отзыв
    grant между запросами → отказ.
16. Коэффициент: границы 65 535/65 536; архив из мелких записей; общий коэффициент
    при `open` (заявленные) и при чтении (фактические, до выдачи порции).
17. Память/время: `RLIMIT_AS` — тест применения на arm64 (результат в спеку);
    сторож RSS 512 МиБ → SIGTERM, +2 с SIGKILL; запрос без кадров 30 с.
18. Протокол: каждый пункт симметричного списка §4 — на обеих сторонах.
19. Барьер §4: пустая запись, ровно один чанк, CRC неверен → без commit.
20. TAR: физические/логические, конец архива (1 нулевой блок + заголовок →
    `bad_tar`), v7 без magic → отказ, корректные PAX/longname, дубль
    эффективного имени. ZIP: пересечение локальных диапазонов, имя в локальном
    ≠ центральному.
21. Рестарты (§11): kill -9, 4-й рестарт, шифрованный архив после рестарта →
    `password_required`; потеря ответа на commit → `done` без повторной публикации.
22. `pack`: источник изменился → `changed_since_plan`; мало места → `no_space` до staging.
23. `THIRD_PARTY_NOTICES.md` совпадает с `cargo metadata` (скрипт).
24. Пароль: запись трафика без payload `0x03`; литерал не в argv/env/stderr/записи.

UI (снимки 1440×900 и 768×900): Enter на архиве → панель-источник, строка
«Нужен пароль» → диалог, распаковка с отказами (`refused` с причиной),
создание архива; артборды `docs/design/v2/stage-2a/`.

## 9. Решения и остаточные вопросы

Решено координатором: файлы сверх плана мои (бинарь в git по ADR 0002;
`package.json` правит и S18 — слияние по очереди); `.tar.gz/.tgz` не делать;
точные дубли имён — отказ всего архива с понятным текстом (§10); ссылки при
распаковке всегда отклоняются; порог 64 КиБ — льгота только для одной записи
плюс общий коэффициент (§5.3); коды ошибок — `ErrorCode += invalid_archive`
и необязательный закрытый `reason` в `CommanderErrorShape` (§10), правку
`src/core/errors.ts` и её тесты делает S14 отдельным блоком.

Остаются:
1. Пароль живёт только в helper; при рестарте плагина/helper вводится заново.
2. Сборка helper: `cargo` есть локально (rustc 1.97); бинарник коммитится как
   у Remote Hub, подпись ad-hoc; карантин на чистой машине — до релиза, не в
   этом срезе.
3. Изменение существующего ZIP/TAR — `unsupported` (ADR: сначала проверка
   метаданных).
4. `RLIMIT_AS` не считаем гарантией (§3); результат теста — в спецификацию.
5. Добавление `invalid_archive` затрагивает потребителей `ErrorCode`
   (исчерпывающие `switch`/таблицы UI, `rpc.ts`): правки в них — только своими
   блоками; если найдётся несовместимое место вне владения — стоп и вопрос.

## 10. Коды ошибок и подкоды (`reason`)

Решение координатора. В `src/core/errors.ts` (правка вне плана, разрешена):
- `ErrorCode` += `"invalid_archive"`;
- `CommanderErrorShape` += необязательное `reason?: ArchiveReason` — **закрытый**
  `z.enum` (ниже); `CommanderError` получает необязательный четвёртый
  аргумент конструктора/опцию `reason`, `toShape()` его выдаёт. Префиксов вида
  `[bad_tar]` в `message` нет; UI выбирает текст по `code` + `reason`.
- Ошибки без `reason` читаются и пишутся как раньше (поле необязательно,
  `strict()` схема остаётся). Тесты: старая форма без `reason` проходит схему;
  `reason: "no_such_reason"` **не проходит**; `reason` из enum проходит;
  `toShape()` без `reason` не добавляет ключ; `message` по-прежнему ≤ 500.

`ArchiveReason` (закрытый список, один enum на все подкоды):
`bad_tar, bad_zip, bad_eocd, bad_zip64, bad_range, bad_pax, count_mismatch,
scan_mismatch, overlapping_entries, local_name_mismatch, multi_volume,
truncated, size_overflow, duplicate_name, size_mismatch, crc_mismatch,
aes_auth_failed, unsupported_format, unsupported_compression,
unsupported_pax_size, archives_unavailable, meta_too_large,
directory_too_large, too_many_entries, name_too_long, total_exceeded,
ratio_exceeded, too_many_open_archives, password_required, bad_password,
helper_checksum_failed, helper_version_mismatch, helper_crashed,
protocol_error`.

Коды helper → `ErrorCode` + `reason` → строка UI. Строки UI — русские; агент
видит `code`, `reason`, `retryable` и безопасное `message` (без путей и имён
записей).

| Код helper / адаптера | `ErrorCode` | `reason` | Класс | Строка UI (RU) |
|---|---|---|---|---|
| `bad_tar`, `bad_zip`, `bad_eocd`, `bad_zip64`, `bad_range`, `bad_pax`, `count_mismatch`, `scan_mismatch`, `overlapping_entries`, `local_name_mismatch`, `multi_volume`, `truncated`, `size_overflow` | `invalid_archive` | тот же код | отказ | «Архив повреждён или имеет неподдерживаемую структуру» |
| `duplicate_name` | `invalid_archive` | `duplicate_name` | отказ | **«В архиве повторяются имена записей; распаковка невозможна»**; для TAR добавляется: «(так бывает после `tar -r`)» |
| `size_mismatch`, `crc_mismatch`, `aes_auth_failed` | `invalid_archive` | тот же код | элемент `failed`, temp убирает раннер | «Данные записи повреждены (контрольная сумма или размер)» |
| `unsupported_format`, `unsupported_compression`, `unsupported_pax_size` | `unsupported` | тот же код | отказ | «Формат или вариант архива не поддерживается» |
| `archives_unavailable` | `unsupported` | `archives_unavailable` | отказ, не повторять | «Архивы недоступны: нет helper для платформы» (или «Модуль архивов перезапускался слишком часто; откройте архив заново») |
| `meta_too_large`, `directory_too_large`, `too_many_entries`, `name_too_long` | `limit_exceeded` | тот же код | отказ | «Архив устроен необычно: превышен предел служебных данных, числа записей или длины имени» |
| `total_exceeded` | `limit_exceeded` | `total_exceeded` | отказ | «Превышен предел распаковки (общий размер)» |
| `ratio_exceeded` | `limit_exceeded` | `ratio_exceeded` | отказ | «Архив сжат сильнее допустимого (коэффициент > N:1); возможно, это архивная бомба. Поднять предел можно в настройках» |
| `too_many_open_archives` | `limit_exceeded` | `too_many_open_archives`, `retryable` | повторить позже | «Открыто слишком много архивов (максимум 4)» |
| `password_required` | `auth_failed` | `password_required` | ждёт владельца (`awaitsOwner`) | «Архив зашифрован: введите пароль» |
| `bad_password` (в т. ч. `bad_password_or_corrupt` ZipCrypto) | `auth_failed` | `bad_password` | отказ, ввод повторить | «Неверный пароль или повреждённые данные» |
| `helper_checksum_failed` | `internal` | `helper_checksum_failed` | сбой установки | «Модуль архивов повреждён: контрольная сумма не совпала. Переустановите плагин» |
| `helper_version_mismatch` | `internal` | `helper_version_mismatch` | сбой установки | «Модуль архивов несовместим с версией плагина» |
| `helper_crashed`, `protocol_error` | `internal`, `retryable` | тот же код | сбой, можно повторить | «Модуль архивов остановился. Повторите; пароль придётся ввести заново» |
| `changed_since_open` | `changed_since_plan` | — | конфликт | «Архив изменился на диске; обновите панель» |
| `no_space` (staging/копия) | `no_space` | — | отказ | «Не хватает места для временного файла» |
| `cancelled`, `timeout` | `cancelled`, `timeout` | — | — | стандартные строки Commander |

Агент: шифрованный архив → `auth_failed` + `password_required` (пароль не
запрашивается и не принимается); оценка копии без `estimateId` →
`consent_required` (код S10, не `reason`).

Элементы плана распаковки с причинами `refused` (`unsafe_name`, `backslash`,
`name_encoding`, `special_file`, `name_collision`, `link_not_supported`,
`link_escapes`, `encrypted_no_password`) — **не ошибки**, а поля элемента
плана (отдельный enum `RefusedReason`, §5.4); в `ErrorCode` не попадают.
Открытие архива с `duplicate_name` отказывает целиком (ошибка выше).

## 11. Падение helper, рестарт, публикация

**Падение (решение E).** EOF, сигнал, обрыв посреди кадра, выход без `close`:
ожидающий запрос завершается `helper_crashed` (`internal`, retryable);
элемент задания — `failed`; temp убирает раннер (stage-1 `abort()`); слот и
копии (§7) освобождаются; адаптер **ждёт выхода процесса** после SIGKILL.
Следующий запрос перезапускает helper, повторяет `open` и сверку fingerprint;
для шифрованного архива снова просит пароль (`password_required`).
Лимит — 3 перезапуска за 5 минут на архив; дальше `archives_unavailable` до
повторного открытия архива владельцем. Тесты: kill -9 посреди `read`; EOF
между data и ok; 4-й рестарт за 5 минут → `archives_unavailable`.

**Рестарт плагина (решение G).** Задание распаковки из шифрованного архива
после рестарта сервера → `password_required` (состояние «ждёт владельца»,
`awaitsOwner`), не `unknown`. Задания из нешифрованных архивов продолжаются
по чекпоинтам stage-1/S17 после повторного `open` и сверки fingerprint.

**Публикация (решение H).** `pack` и распаковка публикуют через
`WriteSession`; три исхода различаются:
1. **Сбой до публикации** (ошибка `write`/`read_finish`/helper упал до
   `commit`) → элемент `failed`, `abort()`, ничего не опубликовано.
2. **Подтверждённый отказ** (`commit` вернул `changed_since_plan`/
   `already_exists`/`no_space`) → соответствующий конфликт/ошибка,
   `abort()`.
3. **Потеря ответа на `commit`** (обрыв/таймаут после отправки) →
   `outcome_unknown` со сверкой по чекпоинту stage-1 (`Checkpoint.committed`,
   `verified`): раннер сверяет цель с ожидаемым fingerprint; совпало — элемент
   `done` **без повторной публикации**; не совпало — решает владелец.
   Приёмочный тест: ответ потерян **после** rename → задание завершается
   `done`, второй `commit` не вызывается (счётчик вызовов на моке =1).
