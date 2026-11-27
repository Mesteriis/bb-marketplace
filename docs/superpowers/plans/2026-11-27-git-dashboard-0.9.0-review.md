# Makosh Git 0.9.x — построчное ревью (поглощение diff-review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** построчное ревью рабочей копии с отправкой агенту и ответами агента на каждый комментарий; затем всё остальное, что умеет diff-review, чтобы его можно было удалить (правило владельца: удаляем, когда в чек-листе не осталось «нет»).

**Spec:** `docs/superpowers/specs/2026-11-27-unified-git-plugin-design.md` (§2, §5 п. 2, таблица срезов: 0.9.0). Опись diff-review: `thr_w9stkag58i/diff-review-inventory.md`.

## Деление (diff-review — около 7,4k строк сервера и 357 тестов, одним срезом не повторить)

| Срез | Что |
|---|---|
| **0.9.0 ядро** | виды диффа рабочей копии (uncommitted, staged, unstaged, branch, all, commit, range) через наш host-entry; треды по строкам, файлу и всему диффу, severity, якоря «следуют за кодом», suggestion с применением; отправка выбранных тредов агенту в тред (свой или выбранный), состояние доставки (sent, answered, no reply); ответы агента по каждому треду: CLI `bb git-dashboard review list\|reply\|resolve\|dismiss` и агентские инструменты; вкладка Review треда и раздел Review копии |
| 0.9.1 AI-прогоны | AI review с фокусами, Summary, Explain, `@reviewer` в комментарии, список прогонов, Fix in a new thread, выбор исполнителя, настройки aiProvider/aiModel/aiPermissionMode, комментарии агента (`review comment`) |
| 0.9.2 остальное | страница Reviews по всем сессиям, осиротевшие ревью, Find, Go to, переход по комментариям, команды палитры, Revert файла и ханков, вид Any file, Viewed, игнор-шаблоны, палитра для дальтоников, сохранение черновиков и прокрутки, строка в Info треда, `review open`, зеркалирование тредов PR с черновиками ответов агента и Submit review; по сверке паритета после 0.9.0 ещё: обновление диффа при изменении рабочей копии, переход с пустого uncommitted на branch, Clear review, память выбранного вида и переключателей по треду, Open у файла в диффе, Markdown в комментариях, автосвёртка больших изменений, подсветка синтаксиса, коммиты ветки в выборе вида |

Чек-листы после 0.9.0: `thr_w9stkag58i/parity-diff-review.md`, `thr_w9stkag58i/parity-bb-github-pr-dashboard.md`. После 0.9.2 они обновляются; у diff-review «нет» не должно остаться.

## Global Constraints (0.9.0)

- Перенос из `plugins/diff-review` (MIT, gpambrozio; части из diffity, MIT, Kamran Ahmed): `shared/anchors.ts`, `patch-lines.ts`, `suggestion.ts`, `git-spec.ts` (parseRange), выбранные схемы `types.ts`, `server/prompt.ts` (sendPrompt), схема store (sessions, threads, comments, sends, send_previous), `host/git.ts` (plan, diff, разборы name-status/numstat/patch) и их тесты. В том же коммите — `THIRD_PARTY_NOTICES.md` с уведомлением diffity.
- Дифф читается нашим host-entry на машине копии, не через `bb--git`. Сессия ревью = копия (`copyId`) + вид.
- Хранение — SQLite плагина (`bb.storage.database` + `migrate`), миграции только дописываются.
- Агент отвечает только на треды, отправленные в его тред; проверка прав — в той же транзакции, что и запись.
- Применение suggestion пишет файл копии только при совпадении его хеша с прочитанным; иначе `CHANGED`.
- Текст комментариев, диффа и имён — недоверенные данные: в UI только текст и Markdown без HTML, агенту — в ограждённых блоках; ответы агента — тоже данные.

## Tasks (0.9.0)

1. Ядро: перенос shared/* и тестов; `targetKey`, виды, сессия.
2. Host: `reviewDiff` (виды, лимиты), `readFile`/`writeFile` с ожидаемым хешем; тесты на временном репозитории.
3. Хранилище SQLite и сервис: view, треды, комментарии, статусы, send, answer, applySuggestion; доставка по `thread.idle`.
4. CLI и агентские инструменты, навык.
5. UI: вкладка Review треда и раздел Review копии; выбор вида, дифф с выбором строк, карточки тредов, composer с severity и suggestion, Send to agent.
6. Стенд (`review-local.mjs`: тред агента отвечает на комментарий), независимое ревью, документация, версия 0.9.0.
