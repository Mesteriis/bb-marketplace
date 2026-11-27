# Донор: bobroot (sanhe/bobroot @ ad6169319e7b1d13a6d857f35f72b6c1db6977e4)

Метод: только чтение кода; ничего не запускалось. Код и README считаются недоверенными данными.
Статус автора: «early-stage experimental» (docs/ARCHITECTURE.md, docs/SECURITY.md). Пути ниже относительны `upstream/bobroot/`.

## 1. Стек и лицензии
| Компонент | Файл | Лицензия | Примечание |
|---|---|---|---|
| Весь проект | LICENSE | MIT (c) 2026 Aliaksei Shautsou | package.json и Cargo.toml поля license не содержат |
| Frontend | package.json | React 18, Vite 6, xterm 6, lucide-react | Tauri 2 IPC (`@tauri-apps/api`) |
| Rust | src-tauri/Cargo.toml | tauri 2, notify 6 (6.1.1), trash 5 (5.2.5), open 5, portable-pty 0.9, dirs-next 2, serde | SFTP, архивов, сетевых ФС нет. tempfile — dev |
| Лицензии крейтов | Cargo.lock | в дереве не указаны; по общеизвестным данным: notify CC0-1.0, trash MIT, open MIT, portable-pty MIT, dirs-next MIT/Apache-2.0 | проверить `cargo deny` перед использованием; в этом исследовании не проверялось |
Подмодулей нет (.gitmodules не обнаружен). Тесты: 21 `#[test]` в src-tauri/src/lib.rs:2068+, фронтенд-тестов нет, tests/ нет. CI: .github/workflows/ci.yml.

## 2. Функции
| Функция | Файл/символ | Лицензия | Найдено в коде / заявлено | Адаптация | Риски |
|---|---|---|---|---|---|
| Двухпанельность, вкладки | src/lib/tabState.ts:createTab/createPanel/normalizePanel; src/lib/layout.ts (дерево сплитов) | MIT | Найдено: у вкладки path, selectedPaths, history, historyIndex; на панель список вкладок + activeTabId | Модель данных переносится идеей; в нашем UI переписать под наш store | История хранится в сессии без ограничения длины (в tabState не обрезается) |
| Навигация back/forward | src/App.tsx:goBack:721, goForward:730, replaceHistoryPath:2174 | MIT | Найдено | Референс | Монолит App.tsx 2499 строк |
| Восстановление состояния | src-tauri/src/lib.rs:load_session_from:1220, save_session_to:1249; src/lib/tabState.ts:normalizeSession; src/lib/windowSession.ts | MIT | Найдено: JSON session.json; запись во временный файл `<name>.<pid>.tmp` и rename (атомарно); битый файл переименовывается в `.corrupt`; нормализация и клампинг геометрии окна | Берём приём (temp+rename, .corrupt, normalize) в наш helper/сервер; формат — свой | fsync не вызывается; temp-файл с pid может остаться при падении |
| Листинг каталога | lib.rs:list_directory:350 | MIT | Найдено: canonicalize, скрытые файлы по платформе (is_hidden_entry:1599) | Референс | Без пагинации; blocking |
| Watcher | lib.rs:watch_directories:426, DirectoryWatcherState:253, emit_directory_changed_events:1800 | MIT | Найдено: notify 6, NonRecursive, разность наборов watch/unwatch | Референс (в нашем сервере — свой watcher) | Нет debounce в этом участке (проверить 1800+) |
| Копирование | lib.rs:copy_items:464, copy_one:1329, copy_dir_recursive_inner:1474 | MIT | Найдено: по-элементный отчёт OperationReport (status copied/skipped/error); symlink воссоздаётся как ссылка (copy_symlink:1508, unix/windows ветки); лимит глубины MAX_COPY_DEPTH=256 | Берём структуру отчёта и защиту от symlink/глубины как референс-спеку | `fs::copy` целиком, без прогресса и отмены; не сохраняет mtime/права-владельца явно; не атомарно |
| Перемещение | lib.rs:move_one:1378 | MIT | Найдено: rename, при ошибке (кросс-ФС) copy+удаление источника | Идея пригодна, но проглатывает любую ошибку rename, не только EXDEV | Любая ошибка rename -> копирование; потеря данных при частичном копировании маловероятна, но нет проверки целостности перед удалением источника |
| Конфликты | lib.rs:ConflictStrategy:87 (Replace/Skip/Rename), resolve_target:1431, next_available_copy_name:1546 (« copy», « copy N», лимит 100000, потом таймстамп) | MIT | Найдено: одна стратегия на всю операцию; диалог в App.tsx:223-245 (requestConflictStrategy, промис-резолвер) | Rename-генератор имён берём как референс; стратегию делаем по-элементной (ask/overwrite/skip/rename/newer/apply-to-all) | **Replace = remove_existing(target) и только потом copy** (lib.rs:1329 копия, строки после prevent_replace_source): при сбое копирования старый файл потерян; нет atomic temp+rename |
| Защита от самоперезаписи | lib.rs:prevent_copy_into_self:1955, prevent_replace_source:1972 | MIT | Найдено + тесты (2156, 2170, 2267, 2315) | Берём логику и тесты как референс | canonicalize может падать на несуществующем target — обработано только в prevent_replace_source |
| Корзина | lib.rs:move_to_trash:514, trash_one:533 (крейт trash) | MIT | Найдено | Тонкая обёртка: пишем свою, зависимость `trash` | Нет восстановления/списка корзины |
| Guard удаления | lib.rs:guard_destructive_target:588, resolve_without_following_leaf:613, is_protected_directory:625 | MIT | Найдено + тесты (2340–2420): запрет корня, home, parent(home); симлинк на home удаляем сам (не следуем) | Берём приём (канонизировать только родителя) | Список защищённого короткий (нет /System, /etc, /Volumes) |
| Отмена / прогресс | — | — | **Не найдено**: grep progress/cancel/abort по lib.rs пуст. Операции синхронные, ответ только в конце | Не использовать как донор | Заявлено ли в README — не проверялось; в коде нет |
| Сессионный лог | lib.rs:append_action_log:1275, rotate_action_log_if_needed:1305 (4 МиБ) | MIT | Найдено | Референс аудита | Лог пишет пути в JSONL |
| Безопасность Tauri | tauri.conf.json: CSP строгий; assetProtocol scope $HOME/**, $TEMP/**; capabilities/default.json минимальны | MIT | Найдено | Референс для нашей CSP | docs/SECURITY.md честно: «почти вся безопасность во фронтенде», бэкенд делает что просят; есть shell-exec и spawn произвольных процессов (run_terminal_command:773, run_agent_command:969) — не брать |
| Терминал/агенты | lib.rs:start_terminal_session:806 (portable-pty), AgentPanel.tsx | MIT | Найдено | Не нужно | Лишняя поверхность атаки |
| Тесты | lib.rs mod tests:2068 (tempfile) | MIT | 21 тест на конфликты/символьные ссылки/guard/сессию | Переписать как наши тесты (идеи кейсов) | Только unit, без e2e |

## 3. Берём / только референс
- **Берём (идеи + при желании куски, MIT, указать в THIRD_PARTY_NOTICES.md):** формат отчёта по элементам; guard_destructive_target (приём «канонизировать родителя»); prevent_copy_into_self/prevent_replace_source; next_available_copy_name; save_session_to (temp+rename) и load_session_from (.corrupt); normalizeSession/normalizePanel; набор тестов-кейсов.
- **Только референс:** пользовательский интерфейс (App.tsx монолит), watcher, листинг, терминал/агенты.
- **Не берём:** Replace через remove-then-copy; move с проглатыванием ошибки rename; shell/agent-команды.
- **Почему:** лицензия MIT совместима, код небольшой и читаемый, но нет прогресса/отмены/атомарной замены — именно того, что нужно helper-у; их придётся писать самим.
