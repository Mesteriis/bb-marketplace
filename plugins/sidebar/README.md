# Makosh Sidebar

Project tree sorted by recent thread activity, with reversible hiding of projects and threads and a Show hidden toggle.

Right-click a project or thread and choose **Скрыть**. Use **Показать скрытое** in Projects to reveal hidden entries, then **Вернуть** in their menus to restore them. Hidden projects hide their threads, including pinned threads. Nothing is deleted or archived. Preferences are saved only in this browser profile; they do not sync across clients. Internal BB helper threads stay excluded.

Projects and folders sort by their newest visible thread activity, including pinned threads. Empty projects follow; equal timestamps sort alphabetically. Select **Makosh Sidebar** under Settings → Appearance → Sidebar after installation.

Development: `npm ci`, `npm run check`, `npm run build`. Installation changes the running BB and requires owner approval. No project names, project order, archive state, or thread visibility fields are modified. Hidden settings use browser localStorage. Reloading resets the Show hidden toggle.

The tree layout is ported from Tree Sidebar (MIT); see the repository THIRD_PARTY_NOTICES.md. Live BB installation and visual acceptance are separate from unit checks.

Set **Корневая папка проектов** in plugin settings to an absolute directory path. That directory is omitted; its immediate folders are the first level. Projects outside it are omitted, with an exception for running threads. Empty root shows all project locations.

**Без проекта** is always present and starts collapsed, including when empty. Expand it to browse personal-project chats. Collapsed folders, pins and the projectless section show only running threads. Hidden projects or threads also expose running threads, which disappear again when execution ends. Running means starting, active or stopping; internal helper threads remain excluded. Preferences about hiding are preserved.

Branches emptied by thread hiding are omitted, including worktree branches. Originally empty projects remain available.

Hiding a project also hides separately registered descendant projects and worktrees under its directory. Running descendants remain visible independently. Path matching respects directory boundaries.

Threads with subthreads have a separate expand/collapse chevron. Collapsing keeps the parent navigable and hides all descendants, including running threads. Status updates do not reopen the subtree; expanding restores it. Parent metadata retains descendant and activity counts. Subtrees start expanded outside the activity group.

The **Сейчас** section (formerly **Активные**) shows running threads (starting, active, stopping) and threads the host marks unread until they are read. It includes all projects, including hidden ones and personal chats; archived/internal helper threads are excluded. Parent context is retained for an active subthread. A qualifying parent brings its subtree; subtrees start collapsed and expand on demand. Thread hierarchy remains available in the activity group; the same threads remain available in the separate Projects tab.

Collapsed subtrees also hide unread results and pending questions; their counts remain on the parent. Expand the parent to reach them.

### Длинные списки тредов

В каждой раскрытой папке по умолчанию показаны первые 5 тредов. Кнопка «Показать больше» раскрывает остальные, «Показать меньше» возвращает короткий список. В настройках плагина поле «Тредов в папке» принимает целое число от 1 до 1000. Вложенные папки не входят в лимит; раздел «Активные» не ограничивается.


## Планы и наблюдаемость

Раздел **Сейчас** группирует работу по родительским тредам. Фильтры **Все**,
**В работе**, **Новые ответы** показывают количество тредов, а не число групп.
Вкладка «Все» также сохраняет треды с ожидающим взаимодействием. Родитель
остаётся доступен; свёрнутая группа скрывает всех потомков и сохраняет их счётчики. Иконки, бейджи, контекст проекта и линии связей
различают состояние исполнения и непрочитанный результат. В отдельной вкладке «Проекты» доступны в том числе активные треды.

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

Parents display **Общий прогресс субтредов**: completed/skipped steps divided by all known steps from descendant plans. A coordinator's plans are excluded when a deeper descendant has plans, so the same delegated work is not counted twice. Only the latest non-manually-hidden plan of each contributing thread is included, including auto-hidden completion. Older plans remain available in history without inflating the aggregate. An explicitly completed latest plan contributes all its steps as complete; the stored step statuses remain unchanged. Missing plans are reported instead of assuming completion. The aggregate is derived on each polling/realtime update and restored from stored child plans after reload, even when the parent agent is idle. Expand the aggregate for its thread/plan/stage breakdown and the parent's own chronological plan history.

The sidebar now retains original plan/step timestamps. Progress marks expose completed step/stage duration; the head dot exposes total and current-step elapsed time. Hover/focus also reveals the clock, and expanded steps show their duration. Time is wall-clock elapsed time including waits, not model CPU time; unknown timestamps remain unknown.

Completed plans and fully completed stages are hidden by default in the sidebar. **Показать готовые** reveals them; **Скрыть готовые** folds them away again. This changes presentation only: their steps remain in aggregate totals. Closed plan details are unmounted, static step lists are memoized, and ticking clocks update separately with a pause while the document is hidden.

Sidebar progress tracks are 20px tall. Dense plans group their timing marks into at most twelve positions, retaining every original label/duration in group tooltips. This prevents aggregate histories from covering the animation with a continuous row of dots; short plans retain individual marks.

The sidebar and composer now share the original full track renderer: gradient fill and stream, moving stage/step capsule, stage/step separator, state icons, elapsed time replacing its label on hover or keyboard focus, and custom timing tooltips with passed/future marker colours. Sidebar tracks stay 20px high with dense marks grouped; composer tracks remain 22px with individual marks. A plan explicitly marked done has the original full-width completed fill; the expanded step counts/statuses remain the recorded values. Clocks update separately from static plan details.

## Вкладки и верхняя панель

**Сейчас** и **Проекты** — отдельные вкладки. В проектах поиск сохраняет путь до совпавшей папки; активные треды доступны и там. Блок «Требует внимания» показывает вопросы и ошибки (первые восемь, затем «Показать ещё»). Бейдж открывает нужный субтред; SDK не предоставляет переход к конкретному сообщению. Причина ожидания показывает количество работающих или ожидающих ответа потомков.

Под прогрессом показано время фактического обновления плана, а не его чтения. После трёх минут без обновления работающего плана появляется «Проверить»; кнопка также доступна при отсутствии плана или ошибке. Повторное чтение не меняет время плана, подсказка показывает последнюю успешную проверку.

С Makosh Navigation вкладки и создание чата занимают штатную верхнюю область, без повторной шапки списка. Это необязательная интеграция через события текущего документа: `makosh-sidebar:v1:state` (`{tab: 'now' | 'projects'}` или `null`), `:request`, `:select` (`{tab}`), `:header` (`{ready: boolean}`) с тем же префиксом. Прямых импортов и RPC между плагинами нет. Без совместимого Navigation или при ширине его области менее 90 px вкладки остаются внутри Sidebar; при ширине менее 180 px верхние вкладки используют иконки с доступными названиями.
