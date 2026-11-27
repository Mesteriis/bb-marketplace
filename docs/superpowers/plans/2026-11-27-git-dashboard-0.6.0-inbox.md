# Makosh Git 0.6.0 — входящие PR и блокеры

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** страница «Мои PR» по всем подключённым аккаунтам (GitHub, GitLab, Gitea, Azure): вкладки Open / Review requested / Reviewed / Assigned / Merged / Closed со счётчиками, группировка по аккаунту и репозиторию, у открытых PR — что блокирует слияние; оповещения о новом падении CI и новых комментариях (тост, бейдж, push через `push-notifications`).

**Architecture:** чистое ядро `src/core/pulls/` (модель `InboxPr`, `blockersOf`, разбор GraphQL GitHub, `diffWatch`, поиск); порт `PullInbox` с адаптерами `src/adapters/bb/forges/inbox/{github,gitlab,gitea,azure}.ts`; сервис `inbox-service.ts` (обход аккаунтов, ошибки по аккаунту), `inbox-watch.ts` (фоновый опрос, `plugin_kv`, realtime, push), `inbox-rpc.ts`; UI `src/ui/pulls/*`, кнопка «Мои PR» с бейджем в шапке.

**Spec:** `docs/superpowers/specs/2026-11-27-unified-git-plugin-design.md` (§5 п.4, §7, §10).

## Global Constraints

- Перенос из `plugins/bb-github-pr-dashboard` (MIT, © 2026 Muhammad Ahsan, ревизия `898660bcd3b467d73b5d879d1185f5be06191264`): из `prs.ts` — `toPr`, `stackOf`, `checkOf`, `latestChecks`, `blockersOf`, `matchesSearch`, `toList`, `toWatched`, `diffWatch`, `pushText`; из `queries.ts` — запросы вкладок и наблюдения; тесты к ним. Запись в `THIRD_PARTY_NOTICES.md` в том же коммите. Остальные 24 теста старого плагина относятся к детальному виду и ревью и переносятся в 0.7.0 и 0.8.0 вместе со своими функциями.
- Срез только читает форджи: записей в PR нет (они в 0.7.0). Строка открывает PR на сайте форджа.
- Токены — существующие аккаунты из Vault; `gh` не используется.
- Оповещения: первый опрос аккаунта только запоминает состояние; опрос не чаще раза в 2 минуты; состояние и список оповещений — в `plugin_kv`, по аккаунту. Отсутствующий или выключенный `push-notifications` не ломает опрос.
- Тексты PR, комментариев и имён — недоверенные данные: в UI только как текст; ссылки — только https на origin аккаунта.

## Вкладки и блокеры по форджам

| Вкладка | GitHub (GraphQL search) | GitLab (`/merge_requests`) | Gitea (`/repos/issues/search?type=pulls`) | Azure (`/_apis/git/pullrequests`) |
|---|---|---|---|---|
| Open | `author:@me is:open` | `scope=created_by_me&state=opened` | `created=true&state=open` | `creatorId=<me>&status=active` |
| Review requested | `review-requested:@me` | `reviewer_username=<me>&state=opened` | `review_requested=true&state=open` | `reviewerId=<me>&status=active`, мой голос 0 |
| Reviewed | `reviewed-by:@me -author:@me -review-requested:@me` | `approved_by_usernames[]=<me>&state=opened` | `reviewed=true&state=open` | `reviewerId=<me>&status=active`, мой голос ≠ 0 |
| Assigned | `assignee:@me` | `scope=assigned_to_me&state=opened` | `assigned=true&state=open` | нет понятия — вкладка с пояснением |
| Merged | `author:@me is:merged` | `scope=created_by_me&state=merged` | `created=true&state=closed`, `merged` | `creatorId=<me>&status=completed` |
| Closed | `author:@me is:closed is:unmerged` | `scope=created_by_me&state=closed` | `created=true&state=closed`, не `merged` | `creatorId=<me>&status=abandoned` |

Блокеры открытого PR (порядок — как в `blockersOf`: Draft, Stacked, Merge conflicts, CI failing, CI running, Changes requested, unresolved comments, Awaiting review):

| Блокер | GitHub | GitLab | Gitea | Azure |
|---|---|---|---|---|
| Draft | `isDraft` | `draft` | `draft` или префикс `WIP:` в заголовке | `isDraft` |
| Stacked | база — ветка другого открытого PR | база — исходная ветка другого открытого MR в том же проекте (`linkStacks`); база без такого MR не считается блокером | то же | то же |
| Merge conflicts | `mergeable=CONFLICTING` | `has_conflicts` | `mergeable=false` (детали PR) | `mergeStatus=conflicts` |
| CI | последние запуски каждого job | `ci_still_running` → CI running; `ci_must_pass` → заметка «CI must pass» (статус не различает «упал» и «не запускался», поэтому не красный); упавший пайплайн головы видит наблюдатель | статус коммита головы | не читается (политики сборки) — сказано в UI |
| Changes requested | `reviewDecision` | `detailed_merge_status=not_approved` → Awaiting review | — | голос −10 / −5 |
| Unresolved comments | `reviewThreads` | `discussions_not_resolved` | — | — |

Сверено с документацией (2026-11-27):
- GitLab: `scope` — `created_by_me | assigned_to_me | reviews_for_me | all`; Review requested — `scope=reviews_for_me`; фильтра «отревьюено мной» нет — Reviewed у GitLab = «я ревьюер и одобрил» (`scope=reviews_for_me&approved_by_usernames[]=<me>`): если сервер проигнорирует `approved_by_usernames`, вкладка не расширится до всех видимых MR. `head_pipeline` есть только у одного MR (`/projects/:id/merge_requests/:iid`), поэтому наблюдение GitLab читает его по каждому открытому MR. `has_conflicts` в списке может быть устаревшим; перепроверку (`with_merge_status_recheck`) не запрашиваем. `x-total` может не прийти — тогда счётчика нет.
- Gitea: у `/repos/issues/search` заголовок с общим числом не задокументирован — счётчик только если пришёл `x-total-count`; ветки, `mergeable` и голова читаются из `/repos/{o}/{r}/pulls/{n}`, CI — из `/commits/{sha}/status`, только для открытых вкладок.
- Azure: эндпоинта уровня организации в документации нет — обход `/{org}/_apis/projects` и `/{org}/{project}/_apis/git/pullrequests`; id пользователя — `/{org}/_apis/connectionData` (`authenticatedUser.id`), в документации REST не найден, проверяется двойником.

Оповещения: GitHub — падение CI и комментарии; GitLab, Gitea — новое падение CI; Azure — нет (CI не читается). Ограничения записаны в матрице возможностей и видны в UI.

## Review Focus

- аккаунт с отозванным токеном не ломает остальные: его вкладки показывают ошибку, остальные — данные;
- первый опрос и новый аккаунт не дают лавины оповещений; смена аккаунта не выглядит как новые падения;
- повторный запуск того же job, отменённый более новым успешным, — не падение;
- поиск по каждому слову; j/k/Enter; свёрнутые репозитории и скрытые помнятся;
- self-hosted GitHub Enterprise (`/api/graphql`), GitLab на нестандартном порту.

### Task 1: Ядро
`src/core/pulls/{model,blockers,github,watch,search}.ts` + перенесённые тесты (блокеры, проверки, stack, watch, push, поиск, устаревший отзыв). Тесты.

### Task 2: Адаптеры входящих
`forges/inbox/github.ts` (GraphQL вкладок и наблюдения), `gitlab.ts`, `gitea.ts`, `azure.ts`; тесты на HTTP-двойниках по таблицам выше.

### Task 3: Сервис, наблюдение, RPC
`inbox-service.ts` (вкладка по всем аккаунтам, счётчики, ошибки по аккаунту), `inbox-watch.ts` (опрос, `diffWatch` по аккаунту, `plugin_kv`, realtime, push, настройки), RPC `inboxList`, `inboxAlerts`, `inboxSeen` (пробное оповещение не делаем: стенд проверяет настоящее). Тесты.

### Task 4: UI
Кнопка «Мои PR» с бейджем; страница: вкладки со счётчиками, поиск, группы аккаунт → репозиторий (свернуть, скрыть), строка с блокерами и полосой худшего, j/k/Enter, «New since you last looked», тосты. Проба стенда.

### Task 5: Приёмка и выпуск
Двойники входящих в `fake-forge.mjs` и `fake-gitlab.mjs`, проба `inbox.mjs`; независимое ревью; документация; версия 0.6.0.
