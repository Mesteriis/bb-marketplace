# Makosh Git 0.5.0 — GitLab

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** GitLab (gitlab.com и self-hosted) как полноценный форж: подключение аккаунта, каталог проектов, merge requests, CI/CD (пайплайны, jobs, живые логи, запуск с переменными, retry, cancel), issues и переменные.

**Architecture:** REST API v4 через существующий `provider-http` (`Authorization: Bearer <PAT>`). `src/adapters/bb/forges/gitlab-provider.ts` реализует `Provider`, `gitlab-pipelines.ts` — `Pipelines`, `repository-features.ts` получает ветку GitLab. Ядро: состояния GitLab, разметка логов GitLab (секции, `ERROR:`), форма запуска из предзаполняемых переменных `.gitlab-ci.yml`.

**Spec:** `docs/superpowers/specs/2026-11-27-unified-git-plugin-design.md` (§5 п.6, §6).

## Global Constraints

- Токен — PAT в Credential Vault (существующий механизм); `glab` как источник не используется (не обновляет OAuth-токен в песочнице).
- Значения переменных CI GitLab не показываются: там обычно секреты. Видны имя, защищённость и маскирование.
- Проект адресуется числовым id из каталога или URL-кодированным `group/subgroup/name`.
- Живые проверки на gitlab.com — только с согласия владельца; по умолчанию двойник на стенде.

## Review Focus

- вложенные группы (`group/sub/project`) — путь кодируется целиком одним сегментом;
- MR из форка: `source_project_id` ≠ `target_project_id`;
- лог job, пока он выполняется (GitLab отдаёт частичный trace);
- пайплайн без `name` и пайплайн, созданный расписанием;
- self-hosted GitLab на нестандартном порту.

### Task 1: Ядро — состояния, логи, форма
`gitlabState`, разбор секций и строки ошибки GitLab, `gitlabDispatchSpec` из `variables` с `description`/`options`. Тесты.

### Task 2: Provider GitLab
Каталог (`projects?membership=true`), `repository(path)`, MR (список, детали с diff из `/diffs`, заметки, пайплайн головы), ветка, мутации (создать MR, комментарий, ревьюер, merge с `sha`, reopen), проверка подключения (`/user`). Мастер подключения предлагает GitLab. Тесты на двойнике API.

### Task 3: Pipelines GitLab
Пайплайны с фильтрами, jobs, trace, запуск `POST /pipeline` с переменными, retry, новый пайплайн для «re-run all», cancel. Тесты.

### Task 4: Issues и переменные
`repository-features` для GitLab: issues проекта, переменные без значений. Тесты.

### Task 5: Приёмка и выпуск
Двойник GitLab на стенде и проба `gitlab.mjs`; независимое ревью; документация; версия 0.5.0.
