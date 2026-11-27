# Makosh Git 0.8.0 — паритет с git-history и github-actions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** закрыть все строки «нет» в чек-листах паритета (`parity-git-history.md` против 0.4.0, `parity-github-actions.md` против 0.3.0/0.4.0), чтобы git-history и github-actions можно было удалить. Решение владельца: «Плагины удалим, когда в списке не останется „нет“».

**Spec:** `docs/superpowers/specs/2026-11-27-unified-git-plugin-design.md` (§5 пп. 2–3).

## Global Constraints

- Каждая запись в CI (повтор, отмена, запуск) — через превью и подтверждение, в том числе из CLI: в github-actions CLI писал без подтверждения, у нас CLI готовит превью и просит подтверждения в треде (pending interaction, как `git_dashboard_publish`). CLI работает только из треда с подключённой копией и разрешением агента не ниже «read»; записи требуют «write».
- Без проекта BB: настройка `ciFallbackProject` (тип `project`); тред расследования создаётся в нём с окружением проекта по умолчанию, у копии с проектом — как раньше, в её папке.
- Тексты коммитов, логов и PR — недоверенные данные: только текст, агенту — в ограждённом блоке.
- Код git-history и github-actions не переносится (оба плагина в этом маркетплейсе, но реализация своя); поведение повторяется по описанию в чек-листах.

## Пункты (строки «нет» → место в Makosh Git)

| # | Пункт | Строки чек-листов | Где |
|---|---|---|---|
| 1 | История в треде: вкладка «Git History» (New tab / Actions), кнопка в шапке треда по настройке `historyHeaderShortcut`; старый слот иконки — если BB его предлагает | gh 9–12 | `app.tsx`, `src/ui/thread-tabs.tsx` |
| 2 | Поиск по загруженным коммитам (тема, хеш, автор, e-mail, ссылки; «N matches»; подсветка) и кнопка Refresh | gh 25–26 | `core/history/search.ts`, `history-panel.tsx` |
| 3 | Группировка по дням с закреплённым заголовком и числом коммитов; выделение conventional-префикса; выключатель графа `historyGraph`; перенос строк в патче; +/− в шапке патча и «N changed lines»; патч больше лимита — обрезанный текст с пометкой | gh 14, 21, 23, 39, 41, 40 | `core/history/days.ts`, `core/history/subject.ts`, `patch-view.tsx`, `history-git.ts` |
| 4 | Метки ссылок: видно не больше трёх, остальное — «+N» с полным списком в подсказке | gh 20 | `core/history/refs.ts`, `history-panel.tsx` |
| 5 | CLI `bb git-dashboard ci list|workflows|rerun|cancel|run` и навык агентам | ga 70–74 | `src/adapters/bb/ci-cli.ts`, `skills/git-dashboard/SKILL.md` |
| 6 | Вкладка «CI/CD» в треде и «Send to this thread» | ga 9, 56 | `src/ui/thread-tabs.tsx`, `run-detail.tsx` |
| 7 | Лог: фильтр строк, «Copy log», «Follow the end», ссылка на job | ga 35, 36, 38, 39 | `core/ci/log.ts` (`filterLines`), `log-view.tsx` |
| 8 | Сводная страница CI по всем репозиториям: плитки Running / Queued / Failed / Success rate и фильтр «All repositories»; плитки и в панели репозитория; живая длительность | ga 12, 13, 16 | `core/ci/summary.ts`, `src/ui/ci/ci-overview.tsx`, RPC `ciOverview` |
| 9 | Агент: `ciFallbackProject`, `ciAnalysisModel`, «Ask agent with another model…» (промпт в композере), поле сообщения и флажок «Include log excerpts», запоминание адресатов | ga 46–48, 53–55 | `ci-agent.ts`, `thread-picker.tsx`, RPC `ciPrompt` |
| 10 | Прочее CI: кэш workflow на 5 минут, `canDispatch` по правам (`canPush`), «Run workflow with inputs…» из запуска (тот же workflow и ветка), «Copy link» запуска | ga 24, 65, 66, 69 | `ci-service.ts`, `ci-panel.tsx`, `dispatch-form.tsx`, `run-detail.tsx` |

## Review Focus

- CLI: запись без треда или без «write» отклоняется; отказ в подтверждении — `CANCELLED`; аргументы проверяются схемой; вывод не больше лимита SDK.
- Fallback-проект: адресаты Send и подписки — только треды этого проекта.
- Поиск и фильтр лога — по каждому слову, без регулярных выражений из ввода.
- Обрезанный патч помечен и не выдаёт себя за полный.

## Tasks

1. Ядро: `search`, `days`, `subject`, `refs`, `filterLines`, `summary` — тесты с литеральными ожиданиями.
2. История: панель (поиск, Refresh, дни, метки, префикс, граф по настройке), патч (перенос, счётчики, обрезка).
3. Вкладки треда и кнопка шапки.
4. CI UI: лог, плитки и сводная страница, живая длительность, запуск из строки, ссылки и копирование, Send to this thread.
5. Агент: настройки, `ciPrompt`, сообщение и флажок, адресаты.
6. CLI и навык.
7. Стенд (пробы истории и CI дополняются), независимое ревью, документация, версия 0.8.0, обновлённые чек-листы.
