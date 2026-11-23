# Makosh Sidebar

**Проекты** — плоский каталог. Поиск работает по имени и пути, папки первого уровня под настроенным корнем служат фильтрами, сортировка доступна по активности и имени. Клик по проекту раскрывает список его неархивных тредов прямо в Sidebar. Можно раскрыть несколько проектов одновременно. В строке треда видны название и иконка текущего статуса, если есть активность. Кнопка **ⓘ** возле проекта открывает его свойства в BB. Кнопка **Открыть рядом** открывает тред в соседней панели BB. Строка **Без проекта** открывает личные треды и доступна при любом фильтре каталога.

В меню строки выберите **Скрыть проект**. Чтобы вернуть его, откройте **Видимость проектов**, включите **Показывать скрытые** и выберите **Вернуть в список**. Ручное скрытие хранится в профиле браузера и действует на конкретный проект в каталоге. Существующий список скрытых проектов служит исходным значением. Треды и данные проектов остаются в BB.

Каталог по умолчанию исключает проекты без неархивных тредов. Переключатель **Показывать пустые** добавляет их в список. Скрытые вручную пустые проекты доступны через **Показывать скрытые**, чтобы их можно было восстановить.

Задайте абсолютный путь в настройке **Корневая папка проектов**. Проекты вне неё исключаются из каталога. При пустом корне каталог охватывает все расположения.

Development: `npm ci`, `npm run check`, `npm run build`. Select **Makosh Sidebar** under Settings → Appearance → Sidebar after installation. Installation changes the running BB and requires owner approval.

The original tree layout was ported from Tree Sidebar (MIT). See the repository THIRD_PARTY_NOTICES.md.

**Сегодня** shows threads created in the last 24 hours, including idle threads, across all projects and personal chats. Archived and internal helper threads are excluded. Recent subthreads retain their visible ancestor chain, including parents older than 24 hours. Older sibling branches appear only if they have a recent descendant. Subtrees start collapsed and expand on demand. **Проекты** has no age limit.

Collapsed subtrees also hide unread results and pending questions; their counts remain on the parent. Expand the parent to reach them.

## Планы и наблюдаемость

Раздел **Сегодня** группирует работу по родительским тредам. Фильтры **Все**,
**В работе**, **Новые ответы** показывают количество тредов, а не число групп.
Фильтр «Все» показывает все треды за последние 24 часа. Родитель
остаётся доступен; свёрнутая группа скрывает всех потомков и сохраняет их счётчики. Иконки, бейджи, контекст проекта и линии связей
различают состояние исполнения и непрочитанный результат. Статусы активных тредов также видны в каталоге проектов.

Sidebar включает собственный движок Plan Progress: `plan_progress`, CLI
`bb plan-progress`, напоминания с прежними ограничениями, диагностику,
изолированный запуск Claude и оценку скорости ответа. Прогресс виден в списке тредов. Отдельный плагин Plan Progress не нужен и должен быть выключен
до включения этой версии Sidebar, чтобы не регистрировать два одинаковых
инструмента и CLI. Код не импортирует файлы другого плагина и не вызывает его RPC.

Пока агент работает, в строке треда показаны текущий этап/шаг, число завершённых шагов и полоска. После ответа стрелка у строки раскрывает планы и время обновления. Вопросы и ошибки остаются видимыми в строке. Несколько планов
раскрываются через счётчик «+N» в строке прогресса; вопросы и ошибки идут первыми. Завершённые автоматически скрытые планы доступны в истории; ручное скрытие сохраняется.
У родителя основной прогресс рассчитывается по шагам субтредов. «План готов» относится
только к плану, а не к завершению треда; счётчик шагов сохраняет реальные статусы.
Для вопроса/ошибки примечание видно сразу в подписи.

Полоски используют исходные точечную волну, мерцание и плавное изменение ширины
Plan Progress. Настройка **Effects** отключает волну и мерцание; `prefers-reduced-motion` также отключает переходы и вращение индикатора.
Sidebar получает данные для отрисованных строк, их потомков и активных веток, пакетами до 25 тредов,
обновляет их по собственным realtime-событиям и раз в 5 секунд, приостанавливая
опрос в скрытой вкладке. Ошибка чтения показана явно; она не означает отсутствие
плана. Вопросы и ошибки планов попадают в блок внимания вкладки «Сегодня», если тред создан за последние 24 часа. Индекс строится при загрузке из первых 2000 сохранённых тредов и обновляется при изменении планов; неполное покрытие обозначается явно.

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

Branch activity includes running descendants and the host's background agents, commands, workflows and plan mode, without changing the host execution status. This keeps the parent in **Сегодня / В работе** while its subtree works, including when folded.

Progress polling retains the last successful plan on transport or per-thread failures, marks it stale, and retries every five seconds. A request times out after ten seconds; realtime notifications coalesce instead of cancelling in-flight reads. The attention index cannot block plan reads. Active descendants stay observed while folded. Sidebar polling rechecks the actual thread status after reload and restores the existing automatic reminder for a verified active turn when work-call thresholds are reached; its durable once-per-turn budget still applies. It never creates artificial steps or completion percentages.

Parents display **Общий прогресс субтредов**: completed/skipped steps divided by all known steps from descendant plans. A coordinator's plans are excluded when a deeper descendant has plans, so the same delegated work is not counted twice. Only the latest non-manually-hidden plan of each contributing thread is included, including auto-hidden completion. Older plans remain available in history without inflating the aggregate. An explicitly completed latest plan contributes all its steps as complete; the stored step statuses remain unchanged. Missing plans are reported instead of assuming completion. The aggregate is derived on each polling/realtime update and restored from stored child plans after reload, even when the parent agent is idle. Expand the aggregate for its thread/plan/stage breakdown and the parent's own chronological plan history.

The sidebar now retains original plan/step timestamps. Progress marks expose completed step/stage duration; the head dot exposes total and current-step elapsed time. Hover/focus also reveals the clock, and expanded steps show their duration. Time is wall-clock elapsed time including waits, not model CPU time; unknown timestamps remain unknown.

Completed plans and fully completed stages are hidden by default in the sidebar. **Показать готовые** reveals them; **Скрыть готовые** folds them away again. This changes presentation only: their steps remain in aggregate totals. Closed plan details are unmounted, static step lists are memoized, and ticking clocks update separately with a pause while the document is hidden.

Sidebar progress tracks are 20px tall. Dense plans group their timing marks into at most twelve positions, retaining every original label/duration in group tooltips. This prevents aggregate histories from covering the animation with a continuous row of dots; short plans retain individual marks.

Progress tracks in the sidebar thread list use the full track renderer: gradient fill and stream, moving stage/step capsule, stage/step separator, state icons, elapsed time replacing its label on hover or keyboard focus, and custom timing tooltips with passed/future marker colours. Tracks are 20px high with dense marks grouped. A plan explicitly marked done has the original full-width completed fill; the expanded step counts/statuses remain the recorded values. Clocks update separately from static plan details.

## Вкладки и верхняя панель

**Сегодня** и **Проекты** — отдельные вкладки. В проектах поиск сохраняет путь до совпавшей папки; активные треды доступны и там. Блок «Требует внимания» показывает вопросы и ошибки (первые восемь, затем «Показать ещё»). Бейдж открывает нужный субтред; SDK не предоставляет переход к конкретному сообщению. Причина ожидания показывает количество работающих или ожидающих ответа потомков.

Под прогрессом показано время фактического обновления плана, а не его чтения. После трёх минут без обновления работающего плана появляется «Проверить»; кнопка также доступна при отсутствии плана или ошибке. Повторное чтение не меняет время плана, подсказка показывает последнюю успешную проверку.

С Makosh Navigation вкладки и создание чата занимают штатную верхнюю область, без повторной шапки списка. Это необязательная интеграция через события текущего документа: `makosh-sidebar:v1:state` (`{tab: 'now' | 'projects'}` или `null`), `:request`, `:select` (`{tab}`), `:header` (`{ready: boolean}`) с тем же префиксом. Прямых импортов и RPC между плагинами нет. Без совместимого Navigation или при ширине его области менее 90 px вкладки остаются внутри Sidebar; при ширине менее 180 px верхние вкладки используют иконки с доступными названиями.

С Chertog тред из списка по обычному клику сначала предлагается открытой странице рабочего пространства публичным событием `chertog.open.v1` и открывается тайлом; если страница не открыта или не приняла запрос, переход на экран треда выполняется как раньше (клики с модификаторами не затрагиваются).
