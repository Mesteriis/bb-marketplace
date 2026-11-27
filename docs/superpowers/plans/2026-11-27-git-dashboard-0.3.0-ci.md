# Makosh Git 0.3.0 — стенд и CI/CD для GitHub, Gitea, Azure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** изолированный стенд BB для браузерной приёмки и раздел CI/CD уровня `github-actions` для GitHub, Gitea и Azure.

**Version note:** в дизайне срез CI назван «0.4», но идёт раньше истории; версии должны расти, поэтому CI выпускается как **0.3.0**, история — 0.4.0.

**Architecture:** чистое ядро `src/core/ci/` (модель запусков, статусы, settle, поиск строки ошибки, форма inputs, промпты); порт `Pipelines` с адаптерами `src/adapters/bb/forges/{github,gitea,azure}/pipelines.ts`; сервис `ci-service.ts` (RPC, кэш, подписки, агент) и фоновый `ci-poller.ts`; UI `src/ui/ci/*`. Стенд — `docs/e2e-stand/` по образцу GitWand (`gitwand/v0.2.0`).

**Tech Stack:** TypeScript, zod 4, `yaml` (ISC) для разбора workflow, `node --test`, BB SDK 0.6.157, Playwright core + chrome-headless-shell 1248 для стенда.

**Spec:** `docs/superpowers/specs/2026-11-27-unified-git-plugin-design.md` (§5 п.3, §7).

## Global Constraints

- Перенос из `plugins/github-actions` (MIT, © 2026 pers0na2dev, ревизия `337890140c9503fedde7dd7da8e8ea4ed24c7f0b`) — запись в `THIRD_PARTY_NOTICES.md` в том же коммите.
- Запись (dispatch, rerun, cancel) живьём — только в `Mesteriis/makosh-git-sandbox`; реальные проекты владельца — только чтение. Azure — только двойники, Gitea — двойник API и (если доступен) Docker-Gitea.
- Действия записи идут через подтверждение пользователя (как publication preview).
- Тексты логов и сообщения форджа — недоверенные данные: в промпте агенту они в ограждённом блоке, без токенов и URL с кредами.
- Стенд не трогает BB владельца: свой `HOME`, `BB_DATA_DIR`, порты.

## Review Focus

- лог GitHub во время выполнения job отсутствует (404) — UI говорит «лог будет после завершения», не «ошибка».
- запуск «висит» in_progress при завершённых jobs — settle по jobs.
- workflow без `workflow_dispatch` — кнопки запуска нет, а не ошибка при нажатии.
- фордж без операции (Gitea без rerun) — кнопка скрыта с пояснением из матрицы возможностей.
- лог длиной в мегабайты — хвост с явной пометкой об обрезке.

---

### Task 1: Стенд
`docs/e2e-stand/{README.md,prepare.sh,run.sh,smoke.mjs,fake-forge.mjs}`: копия плагина, `npm ci`, сборка, `playwright-core` в каталоге стенда; отдельный BB; репозиторий с `origin` и проект; `fake-forge.mjs` — HTTPS-двойник Gitea API с самоподписанным сертификатом (`NODE_EXTRA_CA_CERTS`). `smoke.mjs`: Git-панель открывается, копия подключается, строка форджа видна (проверка 0.2.0 в браузере). Выход 0 только при `STAND PASS`.

### Task 2: Ядро CI
`src/core/ci/model.ts` (Run, Job, Step, нормализация статусов форджей в `queued|running|success|failure|cancelled|skipped|neutral`), `settle.ts`, `log.ts` (очистка ANSI и меток времени, строка ошибки: `##[error]` GitHub/Gitea/Azure, `ERROR:`/`exit code` GitLab-ready), `dispatch.ts` (перенос `parseDispatchSpec`), `prompt.ts`. Тесты на каждое.

### Task 3: Адаптеры Pipelines
Порт `Pipelines`: `runs(filter,page)`, `jobs(run)`, `log(job)`, `workflows()`, `dispatchForm(workflow,ref)`, `dispatch(workflow,ref,inputs)`, `rerun(run,{failedOnly})`, `cancel(run)`. GitHub — REST actions; Gitea — `/api/v1/repos/{o}/{r}/actions/{runs,jobs,workflows}`; Azure — builds, timeline, logs, queue с parameters, retry, cancel. Тесты на HTTP-двойниках с фиксированными ответами.

### Task 4: Сервис, RPC, опрос, агент
`ci-service.ts`: RPC `ciSummary`, `ciRuns`, `ciRun`, `ciLog`, `ciForm`, `ciPrepare`/`ciConfirm` (запись с подтверждением), `ciAsk` (spawn треда), `ciSend` (send в выбранные треды), `ciSubscriptions`. `ci-poller.ts` — фоновый опрос (не чаще 15 с при активных, иначе 60 с), realtime-событие, автоотправка подписанным тредам при новом падении.

### Task 5: UI
`src/ui/ci/{summary,run-list,run-detail,log-view,dispatch-form,agent-actions}.tsx`; вкладка Actions заменяется разделом CI.

### Task 6: Приёмка и выпуск
Сценарий стенда `ci.mjs` на двойнике Gitea; живой сценарий на `makosh-git-sandbox` (dispatch outcome=failure → лог на `src/greeting.txt:2`, rerun failed, cancel slow); документация, версия 0.3.0, `check`/`build`/`check-manifests`.
