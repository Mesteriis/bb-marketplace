# Makosh Git 0.7.0 — PR и issues в глубину

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** детальный вид pull/merge request для GitHub, GitLab, Gitea и Azure: описание и обсуждение, проверки, файлы с диффом и строчными тредами, коммиты; записи — комментарий, ответ в треде, resolve/unresolve, строчный комментарий (одна строка и диапазон), ревью (Comment / Approve / Request changes), запрос ревьюера, правка заголовка и описания, Ready/Draft, закрыть/переоткрыть, merge. Issues: список, карточка, создание, комментарий, закрыть/переоткрыть. Где фордж не умеет — явное «не поддерживается» из матрицы.

**Architecture:** ядро `src/core/pulls/{detail,diff,review,actions,capabilities,prompt}.ts` (модель детального вида, разбор патча и якоря строк, правила ревью, действия, матрица, промпт агенту); `src/core/issues/{model,actions}.ts`; порты `PullReview` и `Issues`; адаптеры `src/adapters/bb/forges/review/{github,gitlab,gitea,azure}.ts` и `forges/issues/*.ts`; сервис `review-service.ts` (адресация `accountId + repo path + number`, превью и подтверждение записей с привязкой к account|repo|number|head), RPC `pr*`/`issue*`; UI `src/ui/review/*` и `src/ui/issues/*`.

**Spec:** `docs/superpowers/specs/2026-11-27-unified-git-plugin-design.md` (§5 пп. 4–5, §7).

## Global Constraints

- Перенос из `plugins/bb-github-pr-dashboard` (MIT, © 2026 Muhammad Ahsan): из `prs.ts` — детальная модель и `toDetail`, `threadStatus`, `toFiles`, `parsePatch`, `commentTarget`, `commentRange`, `rangeFromSelection`, `fullPatch`, `reviewEvents`, `canSubmitReview`, `fixPrompt`, `findingsPrompt`, `prFromUrl`, `reviewersOf`; из `queries.ts` — запрос детального вида и мутации; их 23 теста. Запись в `THIRD_PARTY_NOTICES.md` в том же коммите. Gitea: код плагина `gitea` не переносим, только справка по API (§2 дизайна).
- Каждая запись — через превью и подтверждение; подтверждение отклоняется, если голова PR сдвинулась (STALE_HEAD) или превью устарело.
- Живая запись — только в песочницах: GitHub `Mesteriis/makosh-git-sandbox` (PR #1, конфликтный PR #2, issue #3), GitLab `mesteriis/makosh-git-sandbox` id 89547855 (MR !1, MR !2, issue #1). Gitea — Docker-Gitea, если доступен, иначе двойник; Azure — двойник.
- Тексты PR, комментариев, логов и диффов — недоверенные данные: в UI только текстом (без HTML), агенту — в ограждённом блоке; ссылки — только https на origin аккаунта.

## Матрица возможностей (уточняется в Task 2 по документации нужной версии API)

| Действие | GitHub | GitLab | Gitea | Azure |
|---|---|---|---|---|
| Комментарий, ответ в треде | да | да (notes, discussions) | да (issue comments; ответ — новый комментарий ревью) | да (threads) |
| Resolve / unresolve | да (GraphQL) | да (discussion `resolved`) | проверить API | да (статус треда fixed/active) |
| Строчный комментарий, диапазон | да | да (position с diff_refs) | да (в составе ревью) | да (threadContext) |
| Ревью Approve / Request changes | да | Approve (`/approve`); Request changes — проверить | да | голос 10 / -10 |
| Ready / Draft | да | заголовок `Draft:` | заголовок `WIP:` | `isDraft` |
| Правка заголовка и описания | да | да | да | да |
| Закрыть / переоткрыть | да | да | да | abandon / reactivate |
| Merge | да | да (с `sha`) | да | complete (асинхронно) |
| Issues: создать, комментарий, закрыть | да | да | да | нет (Azure Boards вне репозитория) |

## Review Focus

- устаревшая голова при подтверждении; повторное подтверждение одного превью;
- строчный комментарий на удалённой строке, на строке без контекста, диапазон через границу ханка;
- тред на устаревшей (outdated) позиции; тред без строки;
- PR из форка; PR огромного размера (патч без диффа);
- текст комментария с HTML и Markdown-ссылками — только текст.

### Task 1: Ядро
Модель детального вида и файлов, разбор патча и якоря, правила ревью, действия (zod), матрица, промпты агенту; перенесённые тесты.

### Task 2: Адаптеры PR
`forges/review/github.ts` (GraphQL детального вида + REST файлов + мутации), `gitlab.ts`, `gitea.ts`, `azure.ts`; тесты на двойниках API, матрица сверена с документацией.

### Task 3: Issues
`forges/issues/*.ts`: список, карточка с комментариями, создать, комментарий, закрыть/переоткрыть; тесты.

### Task 4: Сервис и RPC
`review-service.ts`, RPC `prDetail`, `prFiles`, `prPrepare`, `prConfirm`, `prAsk`, `issueList`, `issueDetail`, `issuePrepare`, `issueConfirm`; тесты превью и устаревшей головы.

### Task 5: UI
Страница PR (вкладки Overview, Checks, Files, Commits, Comments), треды под строками, выбор строк для комментария, отправка ревью, действия состояния, «Fix with agent»; строки «Мои PR» открывают её, `[` и `]` — предыдущий и следующий PR. Раздел Issues: карточка, создание, комментарий.

### Task 6: Приёмка и выпуск
Стенд (`review.mjs`, `issues.mjs`), живые проверки в песочницах GitHub и GitLab, независимое ревью, документация, версия 0.7.0.
