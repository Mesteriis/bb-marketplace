# Донор: Xplorer (kimlimjustin/xplorer) — master vs next

Метод: только чтение кода; ничего не запускалось. Пути относительны `upstream/xplorer-master/` и `upstream/xplorer-next/`.
Подмодули: `.gitmodules` в архивах отсутствует (пропущен при распаковке), `.vscode` пуст; ссылок на submodule в коде не обнаружено, но наличие подмодулей в исходном репозитории не проверено.

## 1. Лицензии и стек
| Часть | Лицензия | Источник |
|---|---|---|
| master целиком | Apache-2.0 | LICENSE, package.json "license" |
| master/packages/generator-xplorer-extensions | Apache-2.0 | свой LICENSE |
| next корень, apps/src-tauri | **AGPL-3.0** | LICENSE, package.json, apps/src-tauri/Cargo.toml:license |
| next packages/sdk, extension-sdk и ещё 2 package.json | MIT (поле package.json; отдельных LICENSE-файлов в пакетах нет, только корневой AGPL) | package.json |
| next packages/extensions/* | в Cargo.toml поле license не задано; корневой AGPL применим по умолчанию | native/Cargo.toml |
**Вывод для MIT-плагина:** из next копировать нельзя ничего (AGPL; MIT-метки в package.json при корневом AGPL юридически неоднозначны). Из master можно (Apache-2.0: сохранить NOTICE/атрибуцию, отметить изменения, THIRD_PARTY_NOTICES.md).

Master: Tauri 1.1, webpack/TS (vanilla DOM, без React), Rust 2119 строк (src-tauri/src), крейты: trash 2, notify 4, zip 0.6, open 2, sysinfo 0.23, reqwest, glob, lazy_static; git-зависимости tauri-plugin-window-state/window-vibrancy/window-shadows (src-tauri/Cargo.toml). Tauri allowlist all=true, csp=null (src-tauri/tauri.conf.json:53,84). Зависимость xlsx ^0.17.1 (SheetJS, известно устаревшая) в package.json.
Next: Tauri 2.10, React 18, pnpm-монорепо, ~55k строк Rust (apps/src-tauri/src). Крейты FS/архивы: trash 5.1, notify 7 + notify-debouncer-full, walkdir/jwalk/ignore/rayon, zip 0.6, tar, flate2, bzip2, xz2, sevenz-rust2, unrar 0.5 (обёртка над проприетарным UnRAR), memmap2, git2, keyring, rusqlite(bundled), wasmi 0.40, libloading, ed25519-dalek, portable-pty 0.8, ollama-rs, pdf-extract. SFTP: ssh2 0.9 только в packages/extensions/ssh/native/Cargo.toml. Лицензии крейтов в дереве не указаны (по общеизвестным данным MIT/Apache; unrar — отдельная лицензия UnRAR, проверять).

## 2. Функции
| Функция | Файл/символ | Лицензия | Найдено / заявлено | Адаптация | Риски |
|---|---|---|---|---|---|
| Копирование master | master src-tauri/src/files_api.rs:copy:289 | Apache-2.0 | Найдено: `fs::copy`, возвращает bool | Не берём | Нет рекурсии, ошибок, конфликтов, прогресса; ошибки теряются (`bool`) |
| Корзина master | files_api.rs:delete_file:586 (`trash::delete_all`), restore_trash:615 | Apache-2.0 | Найдено | Референс по restore (платформенно-зависимо) | trash 2 устарел |
| Watcher master | files_api.rs:listen_dir:725 | Apache-2.0 | Найдено: notify 4 raw_watcher, бесконечный цикл с unwrap | Не берём | unwrap/паники, блокирующий цикл |
| Zip master | files_api.rs:compress_to_zip:878, decompress_from_zip:921 | Apache-2.0 | Найдено: Stored без сжатия, `enclosed_name` при распаковке | Не берём | unwrap повсюду, fs::read целого файла в память |
| Расширения master | src-tauri/src/extensions.rs:install_themes:224, init_extension:394; docs/docs/Extensions/create.mdx | Apache-2.0 | Найдено: только темы (JSON `.xtension`, CSS-правила `scope+selector+css key`); установка из файла или URL (reqwest) без подписи; install_extensions паникует для не-тем (строка 305) | Референс формата «декларативная тема» | Нет кода-расширений, нет доверия/подписи; заявлено «Currently ... theme extension» |
| Превью master | src/Components/Files/File Preview/preview.ts:Preview | Apache-2.0 | Найдено: pdf (object), html (iframe по пути), docx (mammoth), xlsx/csv (SheetJS), img/video/audio, txt, md (marked); вставка через innerHTML | Идеи списка форматов | XSS: содержимое файла и имя в innerHTML, csp=null, iframe локального html |
| Тесты master | src-tauri/src/tests.rs; jest (src/**/*.test.ts) | Apache-2.0 | Мало: basename, is_hidden, is_dir | Нет | — |
| Копирование next | next apps/src-tauri/src/operations/file_ops/copy_move.rs:copy_with_progress:22, move_with_progress:123, cancel_file_operation:14, ProgressManager (operations/progress.rs) | AGPL-3.0 | Найдено: операция в потоке, operation_id, событие прогресса, AtomicBool-токен отмены, очистка частичной копии при отмене | **Только референс дизайна** (id операции, токен отмены, события) — код не копировать | `copy_file_with_progress` (≈строка 221) делает один `fs::copy` — прогресс по файлу фиктивный (комментарий «could be enhanced with chunked copying»), отмена файла не прерывает; назначение существует -> ошибка «Destination already exists», политик конфликта нет; при отмене `remove_dir_all(dst)` |
| Move next | copy_move.rs:move_with_progress_impl:368 | AGPL-3.0 | Найдено: rename, при ошибке copy+delete | Референс | Любая ошибка rename -> копирование (как у bobroot) |
| Симлинки next | copy_move.rs:copy:452, copy_dir_recursive:493 | AGPL-3.0 | Симлинки отвергаются/пропускаются, параллельная копия rayon | Только референс | Тихий пропуск симлинков в каталоге |
| Валидация путей next | operations/mod.rs:validate_file_path:103 | AGPL-3.0 | Блок /etc,/usr,/bin…, null-байты; canonicalize только при «..» | Референс | Проверка строковая (`contains("..")`), обход через симлинки; блок списком — хрупко |
| Корзина next | operations/trash_ops.rs:move_to_trash:10 | AGPL-3.0 | Тонкая обёртка trash 5 | Не нужно | — |
| Undo/redo next | operations/undo_redo/mod.rs (MAX_HISTORY=50, enum FileOperation) | AGPL-3.0 | Найдено | Референс идеи журнала | — |
| Архивы next | operations/compression/{zip_ops,safety,sevenz_ops,rar_ops}.rs | AGPL-3.0 | zip/tar/tar.gz/bz2/xz/7z/rar; zip-slip: пропуск записей с `..` + canonical-проверка (zip_ops.rs:40-74), safety.rs: пропуск symlink/hardlink в tar | Референс чек-листа zip-slip | Проверка `contains("..")` грубая; unrar — проприетарная лицензия |
| Watcher next | file_watcher.rs (notify-debouncer-full) | AGPL-3.0 | Найдено | Референс (debounce) | — |
| SFTP next | packages/extensions/ssh/native/src/lib.rs (ssh2): handle_read_directory:784, get_file_content:885, delete/rename:980–1062, create_authenticated_session:310 | AGPL (поле не задано) | Найдено: пароль или pubkey-файл, validate_ssh_host/username/key_path:667–690, классификация ошибок:178, лимит попыток | Референс набора операций | **Нет проверки host key / known_hosts** (grep пуст); пароль передаётся в args каждой команды; нет потоковой передачи, чтение файла целиком |
| Расширения next: формат | extensions/types.rs:ExtensionManifest (id, version, permissions, activationEvents, main, contributes: panels/commands/themes/fileTypes/contextMenus/keybindings/editors); package.json секция `xplorer` (ssh/package.json) | AGPL-3.0 | Найдено | Идея manifest уже есть в BB (bb-plugin) — не нужно | — |
| Расширения next: runtime | клиент: apps/client/src/lib/extension-sandbox.ts:executeSandboxed:166 (`new Function` с Proxy-окружением, блок глобалов), extension-api-factory.ts, BLOCKED_TAURI_COMMANDS; сервер: extensions/wasm_runtime.rs (wasmi, fuel 1_000_000, 64 МБ), native_plugin.rs (libloading C ABI: plugin_init/invoke/free/shutdown) | AGPL-3.0 | Найдено; в коде сам автор отмечает «defense-in-depth only — see SECURITY TODO» | Не берём | Песочница JS в том же realm — не граница безопасности; нативные .dylib загружаются в процесс |
| Доверие next | extensions/signing.rs (SHA-256 всех файлов + Ed25519, OFFICIAL_PUBLIC_KEY:19), manager.rs:174 блок активации непроверенных, force_trust, is_dev | AGPL-3.0 | Найдено; в signing.rs шапка: «Unsigned extensions are allowed to load but produce a warning» — противоречит manager.rs:174 | Идея хеш+подпись; реализация — своя | manager.rs:199: комментарий «do NOT load native plugin (CRIT-04)», но на 205 вызывается `try_load_native_plugin` — комментарий и код расходятся; ядро доверия — один встроенный ключ |
| Просмотрщики next | apps/client/src/components/previews/*.tsx (Image, Pdf, Document, Spreadsheet, Code, Json, Markdown, Csv, Video, Audio, Text), lib/preview-factory.ts (реестр PreviewCapability, priority, maxSize) | AGPL-3.0 | Найдено; DOMPurify в зависимостях | Только идея реестра capability (priority/maxSize/canPreview) | — |
| Разделение frontend/backend | next: packages/sdk (обёртка invoke), CLAUDE.md «никаких invoke из компонентов»; Rust: operations/*, команды в main.rs | AGPL-3.0 | Найдено, заявлено в CLAUDE.md | Архитектурная идея | — |
| Тесты next | apps/src-tauri/tests (operations_tests, extension_tests, ssh_tests…), 47 файлов Rust с тестами, 114 тестов клиента (vitest), copy_move.rs:624+ 8 тестов | AGPL-3.0 | Найдено | — | Тесты конфликтов/атомарности отсутствуют |

## 3. master vs next, готовность
- Это не эволюция, а переписывание: next = «Complete ground-up rewrite» (CHANGELOG.md, v2.0.0 Unreleased); Tauri 1->2, vanilla TS->React, Apache-2.0->AGPL-3.0.
- Готовность next: версия package 1.0.0-alpha.1, Cargo 0.99.1, SECURITY.md поддерживает «0.1.x», CHANGELOG «Unreleased», разнобой версий. Много заявленного (AI-агент, MCP, gdrive, sync, semantic search) не нужно менеджеру и увеличивает поверхность атаки. Статус: альфа, не пригоден как донор кода.
- master: проще и стабильнее по лицензии, но устарел (Tauri 1.1, notify 4, trash 2), низкое качество обработки ошибок.

## 4. Берём / только референс
- **Берём:** ничего кода. Из master (Apache-2.0) формально можно, но брать нечего (нет прогресса, конфликтов, атомарности).
- **Только референс (AGPL, код не копировать, пересказывать идеи своими словами):** operation_id + токен отмены + события прогресса; ProgressManager; чек-лист zip-slip/symlink для архивов; реестр превью с priority/maxSize; журнал undo; набор SFTP-операций и валидация host/user/key; подпись расширений (хеш + Ed25519).
- **Антипримеры:** SFTP без host key; JS-«песочница» через `new Function`; нативные плагины в процессе; единственный `fs::copy` с «прогрессом»; innerHTML в превью master; проверка путей через `contains("..")`.
- **Почему:** AGPL-3.0 несовместима с MIT-плагином при копировании; идеи не защищены, но реализацию надо писать независимо. Для архивов/SFTP брать сами крейты (zip, tar, ssh2/russh — проверить лицензии), а не код Xplorer.

## 5. Для Rust-helper (итог по двум проектам)
| Нужное | Лучший донор | Статус |
|---|---|---|
| Копирование с прогрессом (чанки, отмена) | никто (bobroot без прогресса; xplorer-next — `fs::copy`) | писать самим; дизайн operation_id/cancel из next как референс |
| Конфликт-политики по-элементно | никто; bobroot даёт 3 стратегии на всю операцию и имена «copy N» | писать самим, MIT-код bobroot можно использовать для rename-имён |
| Атомарность temp+rename | bobroot save_session_to (только для JSON сессии) | для файлов — писать самим (temp в каталоге назначения, fsync, rename, копирование метаданных) |
| Корзина | оба: тонкая обёртка над `trash` | зависимость `trash`, свой код |
| Защита от удаления корня/home | bobroot guard_destructive_target | брать приём (MIT) |
| Self-copy/replace-source | bobroot | брать кейсы и логику (MIT) |
