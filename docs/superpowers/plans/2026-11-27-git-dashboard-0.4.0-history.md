# Makosh Git 0.4.0 — граф истории

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** вкладка History рабочей копии: граф по всем refs, метки веток и тегов, незакоммиченные файлы, детали и патчи коммитов, живое обновление.

**Architecture:** чистое ядро `src/core/history/` (модель, раскладка дорожек, разбор вывода git); чтение на хосте копии в `src/adapters/bb/history-git.ts` через существующий безопасный `gitRunner`; RPC `history*` только для приложения; UI `src/ui/history/*` на классах `git-*`.

**Spec:** `docs/superpowers/specs/2026-11-27-unified-git-plugin-design.md` (§5 п.1).

## Global Constraints

- Перенос из `plugins/git-history` (MIT, © 2026 Yusuf Akbulut, ревизия `816bc8c329bcea6276cd9be5fd19dec1926aa584`): `graph.ts` с тестами, разбор `for-each-ref`, `log`, `--name-status`, `--numstat`, `status --porcelain`. Запись в `THIRD_PARTY_NOTICES.md` в том же коммите.
- Только чтение репозитория: `GIT_OPTIONAL_LOCKS=0`, без `fetch`, без записи индекса.
- Патч ограничен выводом `gitRunner` (512 КБ) — сверх лимита явное сообщение, не обрезанный молча текст.
- Хеш коммита и путь файла проверяются до вызова git.

## Review Focus

- пустой репозиторий без коммитов — пустая история, а не ошибка;
- коммит-слияние с тремя родителями и ветки, ушедшие за пределы страницы, — дорожки не теряются между страницами (раскладка по всей загруженной ленте);
- аннотированный тег указывает на коммит через разыменование;
- путь файла с пробелами, табуляцией или юникодом в патче;
- detached HEAD — метка HEAD у коммита.

### Task 1: Ядро истории
`src/core/history/{model,graph,parse}.ts` + тесты (`graph` — перенос тестов git-history).

### Task 2: Чтение на хосте
`history-git.ts`: `historyPage(root, offset, limit)`, `commitDetails(root, hash)`, `commitPatch(root, hash, path)`, `workingPatch(root, path)`, `historyRevision(root)`; методы host-контракта с проверкой identity. Тесты на временных репозиториях (merge, тег, detached HEAD, пустой репозиторий, незакоммиченные файлы).

### Task 3: RPC и UI
RPC `historyPage`, `historyCommit`, `historyPatch`, `historyWorkingPatch`, `historyRevision`. Вкладка History: SVG-дорожки по строкам, метки refs, строка «Uncommitted changes», выбор коммита → файлы → патч, «Load more», опрос revision раз в 10 с.

### Task 4: Приёмка и выпуск
Проба стенда `history.mjs` (merge, тег, незакоммиченный файл, патч), независимое ревью, документация, версия 0.4.0.
