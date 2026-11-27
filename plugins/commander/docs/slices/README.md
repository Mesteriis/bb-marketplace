# Срезы этапа 1 Commander

Основание: ADR 0001 (`../adr/0001-foundation.md`, принят 2026-11-27), ТЗ §11
«Этап 1». Исполнителей и ревьюеров запускает тред планирования
`thr_mn6uyba78h`; принятые diff сливает в ветку
`feature/commander-thr_ba4dpyzux4` тред Commander (`thr_ba4dpyzux4`).

## Правила для всех срезов

- Каждый файл принадлежит ровно одному срезу (таблица ниже). Срез меняет только
  свои файлы; нужна правка чужого — стоп и вопрос в тред Commander.
- Каркас Makosh: `src/core` импортирует только `zod` и себя; `src/ui` —
  `react`, core, `@/components`, `@/lib`, `@/hooks`; хост — только
  `src/adapters/bb`, `server.ts`, `app.tsx`, `host.ts`. Не ослаблять
  `tests/architecture.test.ts`.
- SDK — декларации `@get-bb/plugin-sdk` 0.6.132 в
  `node_modules/@get-bb/plugin-sdk/bundled-types/`; символы только из upstream
  main (`experimental_keyScope`, `storage.experimental_directory`) не
  использовать.
- TDD: сначала падающий тест, ожидаемые значения — литералы из спецификации,
  не тем же кодом. Заглушки, `assert true`, постоянный успех не считаются.
- Перед сдачей: `npm run check` в `plugins/commander`; срезы, меняющие
  `package.json`/каталог, ещё `node ../../scripts/check-manifests.mjs`.
  Сдаётся diff + вывод проверок.
- Никаких реальных секретов, адресов и личных путей в fixtures; временные
  каталоги через `mkdtemp`.
- Заимствованный код (MIT-доноры) — запись в корневой `THIRD_PARTY_NOTICES.md`;
  записями о коде доноров владеет S2. Исключение: S0 добавляет туда запись о
  вендоренных компонентах `components/**`, `lib/**`, `hooks/**` в том же
  изменении (AGENTS.md). Запись о иконках Lucide в артбордах `docs/design/v2`
  уже есть (тред Commander) — не дублировать.

## Исключения владения

- `bb.description` в `package.json`, первая строка `PLUGIN_OVERVIEW.md` и
  запись `commander` в `marketplace.json` меняет синхронно любой срез,
  который вводит видимое поведение (S7, S8), — только эти поля.
- `bb.skills` в `package.json` добавляет S7 вместе с
  `skills/commander/SKILL.md`.
- `THIRD_PARTY_NOTICES.md`: S0 — запись о вендоренных компонентах, S2 —
  записи о коде доноров; новые записи добавляются рядом, чужие не
  переписываются.
- `src/core/provider.ts` (S1): правит S3 — `WriteSession.tempPath`,
  `rename(…, { replace, expectTarget? })`, `remove(…, { kind, expect? })`;
  S4 и S5 реализуют сверку непосредственно перед действием и документируют
  окно неатомарности.
- `src/core/model.ts` (S1): S2 добавляет `PlanItem.expectTarget:
  Fingerprint | "absent" | null` (входит в digest); planner заполняет его
  stat-ом цели.
- `src/core/model.ts` (S1): S3 добавляет в `Conflict` опциональное
  `allowedResolutions: ConflictAction[]`.
- `Checkpoint` (S3): `tempPath`, `targetPath`, `expectTarget`, `verified`,
  опциональное `committed: Fingerprint`; S6 хранит их в `*_json`-колонках.
  Контракт S3 зафиксирован в коммите `77e204b9`; S4, S5, S6 вливают его в
  свои ветки.
- `JobStore.update` может менять `awaitsOwner` (S3 — контракт, S6 —
  колонка `awaits_owner`); выход из `pending` атомарно сбрасывает флаг.
- `src/ui/index.ts` создаёт S0 как заглушку, дальше им владеет S8;
  `src/core/index.ts` — заглушка S0, срезы ядра её не трогают (экспорт из
  своих модулей).

## Порядок и владение

| Срез | Файл спецификации | Зависит от | Владеет (пути от `plugins/commander/`, если не указано иное) |
|---|---|---|---|
| S0 | `S0-scaffold.md` | — | `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `tests/architecture.test.ts`, `components/**`, `lib/**`, `hooks/**`, `assets/icon.svg`, `src/core/index.ts`, `src/ui/index.ts` (заглушки слоёв), `PLUGIN_OVERVIEW.md`, `README.md`, `CHANGELOG.md`, `.gitignore`; в корне: запись `commander` в `.bb/plugins.json` и `marketplace.json`, запись о вендоренных компонентах в `THIRD_PARTY_NOTICES.md` |
| S1 | `S1-core-model.md` | S0 | `src/core/model.ts`, `src/core/provider.ts`, `src/core/errors.ts`, `src/core/size.ts`, `src/core/path.ts` и их `*.test.ts` |
| S2 | `S2-core-planning.md` | S1 | `src/core/planner.ts`, `src/core/guards.ts`, `src/core/naming.ts`, `src/core/permissions.ts` и их тесты; корневой `THIRD_PARTY_NOTICES.md` |
| S3 | `S3-core-jobs.md` | S1 | `src/core/job-machine.ts`, `src/core/job-runner.ts`, `src/core/reconcile.ts`, `src/core/job-store.ts`, `src/core/testing/fake-provider.ts`, `src/core/testing/memory-job-store.ts` и тесты |
| S4 | `S4-host-local-fs.md` | S1 | `src/core/wire/host-fs.ts`, `src/adapters/bb/host-fs/**`, `src/adapters/bb/local-provider.ts`, `tests/host-fs/**` |
| S5 | `S5-sftp-provider.md` | S1 | `src/core/wire/remote-hub-sftp.ts`, `src/adapters/bb/sftp-provider.ts`, `src/adapters/bb/testing/remote-hub-mock.ts`, их тесты |
| S6 | `S6-job-store-sqlite.md` | S1, интерфейс `JobStore` из S3 | `src/adapters/bb/job-store-sqlite.ts`, `src/adapters/bb/migrations.ts` и тесты |
| S7 | `S7-server-rpc-agents.md` | S2–S6 | `server.ts`, `host.ts`, `src/core/wire/rpc.ts`, `src/adapters/bb/rpc-handlers.ts`, `src/adapters/bb/endpoints.ts`, `src/adapters/bb/agent-tools.ts`, `src/adapters/bb/agent-grants.ts`, `src/adapters/bb/cli.ts`, `skills/commander/SKILL.md`, `docs/security.md`, `server.test.ts` |
| S8 | `S8-ui.md` | S7, выбор дизайна | `app.tsx`, `app.test.tsx`, `src/ui/**` |

S2, S3, S4, S5 идут параллельно после S1. Порядок слияния: S2 → S3 → S6,
S4, S5 (контракты `model.ts` от S2 и `provider.ts`/`job-store.ts` от S3
должны быть в ветке раньше реализаций).
S8 ждёт выбора варианта на Design canvas. Заглушки `server.ts`, `app.tsx`,
`host.ts` создаёт S0; после слияния S0 ими владеют только S7 (`server.ts`,
`host.ts`) и S8 (`app.tsx`).

## Приёмка этапа (ТЗ §11) — где закрывается

| Сценарий | Срезы |
|---|---|
| Слева локальная папка, справа SFTP | S4, S5, S7, S8 |
| Клавиатурой выделить и скопировать, видеть очередь | S3, S7, S8 |
| Конфликт и выбор действия | S2, S3, S8 |
| Закрыть и открыть UI без потери состояния | S6, S7, S8 |
| Обратная передача, каталог, переименование, удаление | S3, S4, S5 |
| Агент из треда выполняет те же операции, человек видит и контролирует | S2, S7 |
| Ошибки соединения, host-key rejection, отказ в доступе | S5, S7 |

SFTP против настоящего Remote Hub проверяется, когда тред remote-hub сдаст
контракт (`research/remote-hub-task.md`); до этого S5 работает против мока
по той же схеме.

Отложенные замечания ревью — `after-stage-1.md`.
