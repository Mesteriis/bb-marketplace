# Makosh Sidebar

Project tree sorted by recent thread activity, with reversible hiding of projects and threads and a Show hidden toggle.

Right-click a project or thread and choose **Скрыть**. Use **Показать скрытое** at the top to reveal hidden entries, then **Вернуть** in their menus to restore them. Hidden projects hide their threads, including pinned threads. Nothing is deleted or archived. Preferences are saved only in this browser profile; they do not sync across clients. Internal BB helper threads stay excluded.

Projects and folders sort by their newest visible thread activity, including pinned threads. Empty projects follow; equal timestamps sort alphabetically. Select **Makosh Sidebar** under Settings → Appearance → Sidebar after installation.

Development: `npm ci`, `npm run check`, `npm run build`. Installation changes the running BB and requires owner approval. No project names, project order, archive state, or thread visibility fields are modified. Hidden settings use browser localStorage. Reloading resets the Show hidden toggle.

The tree layout is ported from Tree Sidebar (MIT); see the repository THIRD_PARTY_NOTICES.md. Live BB installation and visual acceptance are separate from unit checks.

Set **Корневая папка проектов** in plugin settings to an absolute directory path. That directory is omitted; its immediate folders are the first level. Projects outside it are omitted, with an exception for running threads. Empty root shows all project locations.

**Без проекта** is always present and starts collapsed, including when empty. Expand it to browse personal-project chats. Collapsed folders, pins and the projectless section show only running threads. Hidden projects or threads also expose running threads, which disappear again when execution ends. Running means starting, active or stopping; internal helper threads remain excluded. Preferences about hiding are preserved.

Branches emptied by thread hiding are omitted, including worktree branches. Originally empty projects remain available.

Hiding a project also hides separately registered descendant projects and worktrees under its directory. Running descendants remain visible independently. Path matching respects directory boundaries.

Threads with subthreads have a separate expand/collapse chevron. Collapsing keeps the parent navigable and hides all descendants, including running threads. Status updates do not reopen the subtree; expanding restores it. Parent metadata retains descendant and activity counts. Subtrees start expanded outside the activity group.

The **Сейчас** section (formerly **Активные**) shows running threads (starting, active, stopping) and threads the host marks unread until they are read. It includes all projects, including hidden ones and personal chats; archived/internal helper threads are excluded. Parent context is retained for an active subthread. A qualifying parent brings its subtree; subtrees start collapsed and expand on demand. Thread hierarchy remains available in the activity group; repeated rows are omitted from project navigation.

Collapsed subtrees also hide unread results and pending questions; their counts remain on the parent. Expand the parent to reach them.

### Длинные списки тредов

В каждой раскрытой папке по умолчанию показаны первые 5 тредов. Кнопка «Показать больше» раскрывает остальные, «Показать меньше» возвращает короткий список. В настройках плагина поле «Тредов в папке» принимает целое число от 1 до 1000. Вложенные папки не входят в лимит; раздел «Активные» не ограничивается.


## Планы и наблюдаемость

Раздел **Сейчас** группирует работу по родительским тредам. Фильтры **Все**,
**В работе**, **Новые ответы** показывают количество тредов, а не число групп.
Вкладка «Все» также сохраняет треды с ожидающим взаимодействием. Родитель
остаётся доступен; свёрнутая группа показывает работающие субтреды, новые ответы
и ожидающие взаимодействия. Иконки, бейджи, контекст проекта и линии связей
различают состояние исполнения и непрочитанный результат. Показанные в «Сейчас»
треды не дублируются в списке проектов; оставшиеся потомки сохраняются.

Sidebar включает собственный движок Plan Progress: `plan_progress`, CLI
`bb plan-progress`, напоминания с прежними ограничениями, диагностику,
изолированный запуск Claude и оценку скорости ответа. Полоска над полем ввода
сохранена. Отдельный плагин Plan Progress не нужен и должен быть выключен
до включения этой версии Sidebar, чтобы не регистрировать два одинаковых
инструмента и CLI. Код не импортирует файлы другого плагина и не вызывает его RPC.

В строке треда показаны текущий этап/шаг, число завершённых шагов и компактная
полоска. Нажмите её подпись, чтобы открыть этапы и шаги. Несколько планов
раскрываются через счётчик «+N» в строке прогресса; вопросы и ошибки идут первыми. Завершённые автоматически скрытые планы доступны в истории; ручное скрытие сохраняется.
У родителя основной прогресс рассчитывается по шагам субтредов. «План готов» относится
только к плану, а не к завершению треда; счётчик шагов сохраняет реальные статусы.
Для вопроса/ошибки примечание видно сразу в подписи.

Полоски используют исходные точечную волну, мерцание и плавное изменение ширины
Plan Progress. Настройка **Effects** отключает волну и мерцание; `prefers-reduced-motion` также отключает переходы и вращение индикатора.
Sidebar получает данные для отрисованных строк, их потомков и активных веток, пакетами до 25 тредов,
обновляет их по собственным realtime-событиям и раз в 5 секунд, приостанавливая
опрос в скрытой вкладке. Ошибка чтения показана явно; она не означает отсутствие
плана. Вопросы и ошибки планов поднимают тред в «Сейчас», даже если он прочитан и не выполняется. Индекс строится при загрузке из первых 2000 сохранённых тредов и обновляется при изменении планов; неполное покрытие обозначается явно.

### Перенос с отдельного Plan Progress

1. Выключите старый `plan-progress`; не удаляйте его до проверки переноса.
2. Создайте приватную резервную копию:
   `python3 scripts/migrate-progress.py --export /absolute/private/backup.json`.
   Скрипт проверяет фактическую схему локального `bb.db`, читает только namespace
   Plan Progress и известные несекретные настройки, не изменяя базу.
3. Обновите `makosh-sidebar`, затем выполните
   `python3 scripts/migrate-progress.py --apply /absolute/private/backup.json`.
   Скрипт переносит планы, ошибки агентов и бюджеты напоминаний, сверяет каждую
   запись через RPC и восстанавливает известные настройки. Конфликт не
   перезаписывается. При работающем BB можно добавить `--keep-newer-runtime`:
   сохраняются уже накопленные ошибки, доказанно более новый корневой ход
   напоминания и подтверждённый ответ на ожидание без изменения шагов. Другие
   конфликты по-прежнему останавливают перенос. Исходный снимок остаётся в
   приватной резервной копии. Повторный запуск идемпотентен.
4. После успешной проверки и проверки интерфейса удалите старый плагин:
   `bb plugin remove plan-progress`. Сохраните приватную копию для восстановления.
   Не добавляйте её в git. Новые сессии агентов получают инструмент от Sidebar;
   состав инструментов уже запущенных сессий может требовать нового запуска.

RPC `progress_import` принимает только ограниченные и проверенные записи
планирования и никогда не заменяет отличающуюся существующую запись.
`progress_export` читает только эти ключи для сверки. Протокол `plan_progress`
и команды описаны в `skills/plan-progress/SKILL.md`.

### Проверки

Из каталога плагина: `npm run check` (типы, UI/серверные тесты, 67 перенесённых
проверок движка и Python-тесты переноса), `npm run build`,
`node --test tests/integration/*.test.mjs` (собранные сервер и host).

Компактная компоновка сохраняет размер текста: контекст проекта и сводка потомков объединены, а бейдж состояния перенесён к подписи прогресса. Названию треда доступна полная ширина. Счётчик «+N» в той же подписи раскрывает остальные планы вместе с этапами текущего; закрытые дополнительные полоски не монтируются.

Branch activity includes running descendants and the host's background agents, commands, workflows and plan mode, without changing the host execution status. This keeps the parent in **Сейчас / В работе** while its subtree works, including when folded.

Progress polling retains the last successful plan on transport or per-thread failures, marks it stale, and retries every five seconds. A request times out after ten seconds; realtime notifications coalesce instead of cancelling in-flight reads. The attention index cannot block plan reads. Active descendants stay observed while folded. Sidebar polling rechecks the actual thread status after reload and restores the existing automatic reminder for a verified active turn when work-call thresholds are reached; its durable once-per-turn budget still applies. It never creates artificial steps or completion percentages.

Parents display **Общий прогресс субтредов**: completed/skipped steps divided by all known steps from descendant plans. A coordinator's plans are excluded when a deeper descendant has plans, so the same delegated work is not counted twice. All saved plans of each contributing thread are included, including auto-hidden completions; manually hidden plans stay excluded. Missing plans are reported instead of assuming completion. The aggregate is derived on each polling/realtime update and restored from stored child plans after reload, even when the parent agent is idle. Expand the aggregate for its thread/plan/stage breakdown and the parent's own chronological plan history.

The sidebar now retains original plan/step timestamps. Progress marks expose completed step/stage duration; the head dot exposes total and current-step elapsed time. Hover/focus also reveals the clock, and expanded steps show their duration. Time is wall-clock elapsed time including waits, not model CPU time; unknown timestamps remain unknown.
