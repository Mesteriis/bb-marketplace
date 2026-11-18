# Makosh Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Создать плагин настраиваемой навигации BB с группами, вложенными меню,
линиями-разделителями и редактором общей раскладки в настройках плагина.

**Architecture:** Отдельный пакет `plugins/navigation`. Чистый core проверяет
документ и преобразует дерево; React UI получает props и callbacks; BB adapters
обеспечивают каталог, host navigation, RPC, storage и realtime. Публичные SDK
контракты подтверждаются до реализации зависимых путей.

**Tech Stack:** TypeScript, React, Zod, установленный BB Plugin SDK,
Vitest и Testing Library; plugin-scoped SQLite через SDK для атомарных ревизий.
UI primitives — локальная vendored seam, без импорта других плагинов.

**Spec:** `docs/superpowers/specs/2026-11-15-navigation-customizer-design.md`.

## Global Constraints

- «Одна раскладка действует для всех проектов текущего аккаунта BB в текущей установке».
- «Между разными аккаунтами раскладка не переносится».
- «Только существующие пункты навигации BB: встроенные действия и панели плагинов».
- «Разделитель — только линия без подписи, доступен на панели и внутри групп».
- «Редактор находится в настройках плагина; панель служит для навигации».
- «Host-импорты разрешены только в adapter и entry points по `docs/architecture.md`».
- Название группы после trim обязательно, до 80 символов; одинаковые названия допустимы.
- Никаких root npm workspaces, cross-plugin imports, приватных host API или DOM injection.
- Не менять `plugins/sidebar` и чужие изменения mail/telegram/steel-browser.
- Не устанавливать, не переключать и не перезагружать плагины в живом BB без
  отдельного разрешения. Не push/tag/publish и не открывать marketplace PR.
- План не разрешает коммиты автоматически: контрольные точки ниже сохранять
  отдельными коммитами только при авторизации; иначе оставлять проверенный diff.
- Сохранять сырые отчёты проверок и exit code в `$BB_THREAD_STORAGE/navigation/`.
- После каждого изменения нового пакета: `npm run check`; перед завершением:
  `npm run build`. Изменения манифестов требуют repository manifest checker.

## Review Focus

- Смена аккаунта при незавершённом запросе: старый ответ не попадает в новый UI
  и не записывается в другую область хранения. Тесты задач 1, 4.
- Загрузка каталога частями: временно отсутствующие панели не уничтожаются,
  состояние loading не считается полным снимком для destructive reset. Задачи 1, 3.
- Два редактора и пропущенное realtime-событие: атомарный конфликт и перечитывание
  при reconnect сохраняют черновик. Задачи 4, 6.
- Группа-якорь скрылась/исчезла при открытом меню: меню закрывается, фокус получает
  доступный Home, страница не падает. Задача 5.
- Очень глубокий или большой hostile JSON: ограниченная проверка до рекурсивного
  обхода; отказ без RangeError и без перезаписи документа. Задача 2.

## Файлы и ответственность

Все пути ниже относительно `plugins/navigation/`, кроме явно обозначенных.

- `app.tsx`: регистрация navigation/header/settings slots и композиция adapters.
- `server.ts`: регистрация RPC/realtime и создание scoped store; без tree/UI логики.
- `src/core/model.ts`, `document.ts`: типы, схема, ограничения входа и совместимость.
- `src/core/tree.ts`: создание, перемещение, скрытие и удаление узлов.
- `src/core/catalog.ts`: согласование stable IDs, отсутствующие/новые пункты.
- `src/core/presentation.ts`: видимое дерево, разделители, активность и badge.
- `src/core/ports.ts`, `contract.ts`: узкий storage port и wire schemas без SDK imports.
- `src/adapters/bb/layout-store.ts`: SQLite, account scope, CAS.
- `src/adapters/bb/catalog-bridge.ts`: scoped immutable snapshot каталога, без actions в storage.
- `src/adapters/bb/navigation-controller.tsx`: hook BB, иконки и активация.
- `src/adapters/bb/use-layout.ts`: подтверждённая раскладка, запросы и invalidation.
- `src/adapters/bb/settings-controller.tsx`: загрузка/черновик/сохранение и guard ухода.
- `src/ui/navigation-rail.tsx`, `group-menu.tsx`: рабочая панель и одноуровневое окно меню.
- `src/ui/layout-editor.tsx`, `editor-tree.tsx`, `group-properties.tsx`,
  `icon-picker.tsx`, `layout-preview.tsx`: редактор по отдельным обязанностям.
- `src/ui/navigation.css`: темы, расположение, overflow и responsive states.
- `components/ui/*`, `lib/*`: только необходимые локальные UI primitives.
- `tests/architecture.test.ts`, colocated `*.test.ts(x)`, `app.test.tsx`,
  `server.test.ts`: изоляция слоёв, поведение, adapter/slot integration.
- `README.md`, `PLUGIN_OVERVIEW.md`, `CHANGELOG.md`, `package.json`, lockfile,
  `tsconfig.json`, test/build configuration: самостоятельный пакет.

## Task 1: Проверить интеграционные контракты до создания продукта

**Files:** create `docs/navigation-sdk-feasibility.md` в корне репозитория;
экспериментальные harness-файлы только в `$BB_THREAD_STORAGE/navigation/feasibility/`.

**Interfaces:** produces подтверждённые API и их области действия для задач 4–6;
это исследование, не фиктивная реализация storage или каталога.

- [ ] Прочитать доступные SDK declarations и узкие references authoring для
  frontend settings, navigation, RPC/storage/realtime, tests. Проверить версии
  непосредственно перед работой; не обновлять SDK попутно.
- [ ] Проверить `settingsSection` одновременно с активным rail: каталог передаётся
  через adapter-local subscription, а не через вызов navigation hook в settings.
  Отдельно проверить неактивный provider: сохранённое дерево читается; stale
  catalogue помечен; полный reset недоступен без полного живого снимка.
- [ ] Проверить account identity/lifecycle и авторизацию RPC/realtime. Scope
  получается только из доверенного host context, не из client-supplied accountId.
  Доказать на тестовом host, что account A не читает/изменяет документ B.
- [ ] Проверить SQLite transaction и условную запись по revision; подтвердить
  событие invalidation, возможность перечитать при reconnect и disposal.
- [ ] Проверить поддерживаемый guard ухода со страницы настроек с действиями
  сохранить/отбросить/остаться, включая переход по host navigation. Browser
  beforeunload сам по себе не доказывает перехват SPA navigation.
- [ ] Записать минимальные версии, точные SDK symbols и результаты probes.
  Если account isolation, guard или каталог нельзя обеспечить публичным API,
  оформить конкретный SDK gap и остановить зависимый путь до решения владельца;
  не заменять требование молчаливым упрощением. Остальные независимые core-задачи
  можно выполнять после разрешения реализации.

**Gate:** product implementation начинается только с подтверждённой границей
account scope; UI сохранения/ухода не объявляется готовым без guard evidence.
Для живого BB понадобится отдельное разрешение; fake-host probes — отдельный
вид доказательства. Не считать наличие declaration доказательством live acceptance.

## Task 2: Самостоятельный пакет и валидируемый документ

**Files:** scaffold/config перечисленные выше; `src/core/model.ts`, `document.ts`,
`contract.ts`, `ports.ts`, `document.test.ts`, `tests/architecture.test.ts`.

**Interfaces:**
- `LayoutNode = ItemNode | GroupNode | SeparatorNode`; у всех `id`, `hidden`;
  item: `kind:'item', itemId`; group: `kind:'group', name, icon, children`;
  separator: `kind:'separator'`. ID узла и itemId — разные сущности.
- `LayoutDocument = {version:1, revision:number, nodes:LayoutNode[]}`.
- `decodeDocument(input:unknown): DecodeResult` → `valid | corrupt | unsupported`.
- `LayoutStore.read(): Promise<ReadResult>`; `save(document:LayoutDocument,
  expectedRevision:number): Promise<SaveResult>`; scope привязан к экземпляру
  adapter доверенным context, не параметром RPC.
- `ReadResult` различает `empty`, `valid`, `corrupt`, `unsupported`.
  `SaveResult` различает `saved` с новым документом и `conflict` с актуальной
  revision; ошибки транспорта/диска не превращаются в saved.
- `ReadResult` также содержит opaque `baselineToken`, привязанный к scope и
  исходной записи; `LayoutStore.reset(document, baselineToken): Promise<SaveResult>`
  допускает явное восстановление corrupt записи и отказывает при смене baseline.
  Unsupported newer version не перезаписывается даже reset первой версии.

- [ ] Проверить отсутствие коллизии package/slot ID. Создать пакет штатным
  scaffold после чтения quickstart; убрать неиспользуемые scaffold handlers.
  Согласовать выбранную версию с результатом Task 1, не копировать node_modules.
- [ ] RED: tests `accepts 80 code points after trim`, `rejects blank/81`,
  `rejects duplicate node IDs and duplicate itemIds`, `rejects unknown kind`,
  `version 2 is unsupported and not defaulted`, `negative revision rejected`.
  Expected значения буквальные: `'  Работа  '` → `'Работа'`; 80/81 кодовых
  точек, включая astral symbol, не UTF-16 code units.
- [ ] RED: защитные границы как решение исполнителя фиксируются здесь:
  JSON до 256 KiB UTF-8, до 4096 узлов, до 64 уровней групп. Проверить каждый
  предел и превышение на один, не конструируя expected той же функцией.
  Циклический object input отбрасывается без зависания; слишком глубокий вход
  проверяется bounded/iterative до вызова recursive validator.
- [ ] Run `npx vitest run src/core/document.test.ts tests/architecture.test.ts`;
  подтвердить RED именно из-за отсутствующего поведения. Реализовать схемы и
  контракт; повторить команду до PASS, затем `npm run check`.

## Task 3: Операции дерева, каталог и представление

**Files:** `src/core/tree.ts`, `catalog.ts`, `presentation.ts` и их tests.

**Interfaces:** consumes Task 2 types. Produces:
- `TreeEditResult = {ok:true,nodes:LayoutNode[]} | {ok:false,reason:
  'not-found'|'invalid-target'|'cycle'|'invalid-index'|'item-delete-forbidden'}`;
  ошибка не мутирует исходные nodes.
- `moveNode(nodes, nodeId, parentId:string|null, index:number): TreeEditResult`;
  индекс означает позицию в целевом списке после извлечения исходного узла.
- `setHidden(nodes, nodeId, hidden): TreeEditResult`;
  `removeContainer(nodes, nodeId): TreeEditResult` (group unwrap / separator delete).
- `CatalogEntry = {id,label,iconKey,isVisible,isLoading,isDisabled,badgeLabel}`;
  host icon/action objects не входят в core или persisted JSON.
- `CatalogSnapshot = {entries:CatalogEntry[], completeness:'live'|'stale'|'loading'}`.
- `reconcileCatalog(document, snapshot): LayoutDocument` — чистая функция;
  не повышает revision и не пишет storage.
- `presentLayout(nodes, snapshot, activeItemId): PresentedNode[]`;
  `isGroupActive` и `hasGroupBadge` выводятся из видимых доступных ссылок.

- [ ] RED: move fixture `[a,g(children:[b]),c]`, перенести `b` в корень index 1
  → `[a,b,g(children:[]),c]`; `g` в собственного потомка → отказ и прежнее дерево;
  индексы вне диапазона → отказ. Hidden `b` сохраняет hidden при переносе.
- [ ] RED: unwrap `g(children:[b,c])` в `[a,g,d]` → `[a,b,c,d]`; попытка удалить
  item → отказ. Скрытие/возврат родителя не меняет hidden ребёнка.
- [ ] RED: catalogue `[a,b]` + новый `c` → `[a,b,c]` один раз; исчезновение `b`
  сохраняет его позицию; возвращение `b` восстанавливает hidden. Переименование
  BB не создаёт новый item. Loading/stale snapshot не считается основанием
  удалить запись или разрешить reset. Последнее имя хранится в scoped metadata.
- [ ] RED: visible projection `sep,a,sep,sep,hidden(b),sep,c,sep` → `a,sep,c`,
  исходный документ unchanged; hidden descendant badge не учитывается;
  два видимых badge дают точку, а не сумму; hidden active item не раскрывает группу.
- [ ] Run `npx vitest run src/core/tree.test.ts src/core/catalog.test.ts src/core/presentation.test.ts`
  → RED; реализовать функции без host IO → PASS; `npm run check`.

## Task 4: Scoped storage, RPC и обновление нескольких окон

**Files:** `src/adapters/bb/layout-store.ts`, `catalog-bridge.ts`, `use-layout.ts`,
их tests; `server.ts`, `server.test.ts`; schemas в `src/core/contract.ts`.

**Interfaces:** `layout_get(null): ReadResult`; `layout_save({document,
expectedRevision}): SaveResult`; event `layout_changed:{revision:number}`.
Явное восстановление: `layout_reset({document,baselineToken}): SaveResult`;
token сравнивается внутри транзакции с текущей raw записью и текущим scope.
Событие — invalidation, не источник документа. Никакой client accountId в wire.
`useLayout()` возвращает read state, save и refresh; adapter-local catalog
bridge предоставляет `subscribe/getSnapshot` и явный cleanup/scope reset.

- [ ] RED на реальной временной SQLite: empty read; first save expected 0 →
  revision 1; два save с expected 1 → ровно один saved revision 2 и один conflict;
  failure/rollback оставляет revision 1; corrupt/future raw JSON не переписывается
  обычным save. Явный reset требует подтверждённого opaque baseline из read,
  чтобы заменить corrupt документ атомарно, не обходя проверку ревизии.
  Для первого save проверка содержит буквальные assertions
  `expect(result.kind).toBe('saved')` и
  `expect(result.document.revision).toBe(1)`; имена discriminants зафиксировать
  одинаково в schemas, port и UI. Reset future version всегда отказ; reset с
  устаревшим baseline → conflict без изменения raw записи.
- [ ] RED: scopes A/B имеют разные документы и snapshots; late response A после
  switch B игнорируется; client spoof accountId отклоняется boundary schema.
  Если SQL scope задаёт хост отдельной БД, подтвердить именно это по Task 1.
- [ ] Реализовать append-only migrations и транзакционный CAS. Сервер повторно
  валидирует размер/структуру перед записью, emit только после commit.
- [ ] RED: event потерян → reconnect refresh даёт latest; duplicate/out-of-order
  invalidation не откатывает revision; при dirty editor remote document не
  заменяет draft; disposal убирает listeners и игнорирует late responses.
- [ ] Реализовать adapter bridge без глобальных DOM events, private stores и
  сериализации callbacks; catalog metadata scoped, не содержит содержимого
  почты/чатов. При incomplete catalogue reset запрещён.
- [ ] Run `npx vitest run src/adapters/bb/layout-store.test.ts src/adapters/bb/catalog-bridge.test.ts src/adapters/bb/use-layout.test.tsx server.test.ts`
  → RED перед implementation, PASS после; `npm run check`.

## Task 5: Рабочая панель и вложенное меню

**Files:** `navigation-controller.tsx`, `src/ui/navigation-rail.tsx`,
`group-menu.tsx`, `navigation.css`, `app.tsx`, `app.test.tsx`, UI tests.

**Interfaces:** UI receives PresentedNode[], active state и callbacks
`onActivate(itemId,target)`, `onHome(target)`, icon renderer из entry/adapter.
Menu state — rootGroupId + path group IDs; ни routes, ни host actions в core.

- [ ] RED slot integration: `placement:'rail'`, Home и new-thread header,
  Settings остаётся host-owned; item activation вызывает SDK с точным ID и
  target `current`; Ctrl/Cmd → `split`, Home Ctrl/Cmd → `tab`. Loading/disabled
  не вызывает activation; badge label включён в доступное имя.
- [ ] RED menu: root click/repeat/other root; nested click заменяет список в том
  же popup; Back/Escape по одному уровню; leaf закрывает; click outside закрывает;
  reopening начинает root; project change закрывает. Проверить focus enter,
  back, close и host handoff отдельно, без универсального refocus после activation.
- [ ] RED lifecycle: скрытие/удаление anchor во время открытия → закрытие и Home
  fallback focus; пустая группа показывает точный текст спецификации.
- [ ] Реализовать menu через локальный primitive с positioning/focus callbacks.
  Не допускать автоматического Escape-dismiss primitive до обработки nested Back.
  Host icons рендерить через SDK component, group icons — встроенный allowlist.
- [ ] Добавить темы, scroll rail/menu, clamp к viewport, long-label ellipsis с
  полной доступной подписью и reduced-motion. Не перетаскивать элементы рабочей
  панели: reorder только в editor.
- [ ] Run `npx vitest run app.test.tsx src/ui/group-menu.test.tsx src/ui/navigation-rail.test.tsx`
  RED → implementation → PASS; `npm run check`.

## Task 6: Редактор настроек, черновик и безопасное сохранение

**Files:** `settings-controller.tsx`, все editor UI файлы из карты, их tests;
settings slot в `app.tsx`, styles; `contract.ts` reset schema по Task 4.

**Interfaces:** `EditorState = {baseRevision,draft,dirty,saveState,catalogState}`;
controller commands addGroup/addSeparator/move/setHidden/rename/setIcon/unwrap,
save/discard/requestReset/requestLeave. `LayoutEditor` получает callbacks,
snapshot и preview; не вызывает SDK или RPC.

- [ ] RED: group creation root/selected group; trimmed 80-character name valid,
  blank/81 disables save; icon search filters allowlist; item label not editable;
  hidden rows remain selectable. DnD и buttons дают идентичное literal дерево
  fixture Task 3, cycle drop оставляет original и показывает причину.
- [ ] RED: editor changes меняют preview, рабочая панель unchanged до сохранения;
  discard восстанавливает baseline. Reset с cancel unchanged; confirm только
  меняет draft; stale/loading catalogue блокирует reset.
- [ ] RED: save pending блокирует повторный запрос; success публикует confirmed
  revision; disk failure оставляет draft и старую рабочую панель; conflict не
  заменяет draft, показывает возможность перечитать baseline, повторная запись
  требует явного действия. Не автоматически rebasing поверх чужого документа.
- [ ] RED: new item во время dirty edit добавляется в reconciled draft один раз,
  не убирая изменения; удалённый ID остаётся unavailable; scope change очищает
  draft без показа прежних названий. Corrupt/future документ read-only до
  разрешённого reset; future schema не понижается обычным save.
- [ ] RED: host navigation при dirty editor открывает Save/Discard/Stay;
  save error оставляет на странице, Stay не меняет draft, успешный Save/Discard
  завершает исходный переход ровно раз. Без подтверждённого guard Task 1 этот
  критерий BLOCKED, а не PASS.
- [ ] Реализовать редактор/контроллер и регистрацию settings section. На narrow
  viewport editor/preview идут вертикально; preview не выполняет реальные host
  navigation actions. Иконки и primitives импортировать через локальную UI seam.
- [ ] Run `npx vitest run src/ui/layout-editor.test.tsx src/ui/editor-tree.test.tsx src/adapters/bb/settings-controller.test.tsx app.test.tsx`
  RED → implementation → PASS; `npm run check`.

## Task 7: Интеграция пакета, документация и конфигурация проекта

**Files:** plugin README/overview/changelog/package; root `.bb/plugins.json`,
`marketplace.json`, `README.md`, `README.ru.md`, `THIRD_PARTY_NOTICES.md`;
активный checkout `.zed/settings.json`, `.zed/tasks.json`, `.zed/debug.json`.

- [ ] Описать только реализованное, включая experimental API, stale catalogue,
  account scope, сохранение/конфликты, guard и восстановление. Согласовать
  package description / bb.description / marketplace, limits checker.
- [ ] Добавить navigation в collection/catalog, сохраняя актуальные чужие записи
  после повторного чтения файлов. Это repo metadata, не install в работающий BB.
  Записать любое vendored BB/UI происхождение в notices в той же правке.
- [ ] После осмотра реальной структуры вызвать
  `/Users/avm/.local/bin/zed-init --update /Users/avm/projects/Personal/bb-main`
  (при исполнении из worktree — его фактический абсолютный root). Проверить diff
  и cwd задач, сохранить ручные записи; не запускать Zed/другие приложения.
- [ ] Run из package `npm run check`, `npm run build`; из root
  `node scripts/check-manifests.mjs`. Отчёты хранить с exit codes; чужие failures
  отделить, не править вне scope для зелёного результата.

## Task 8: Приёмка UI и итоговая проверка

**Files:** исправления только в уже затронутых файлах; reports/screenshots в
`$BB_THREAD_STORAGE/navigation/acceptance/`; добавить краткое factual acceptance
в plugin README, не включать приватные runtime IDs/paths в репозиторий.

- [ ] Для browser task применить steel-browser skill и `bb surf project` в
  текущем проекте. Использовать synthetic catalogue; не собирать данные почты.
  Нужный test harness включить в пакет только как dev-only fixture entry.
  Запуск preview только если пользователь разрешил открыть/preview на этом этапе.
- [ ] Проверить 1440×900 и 390×844, обе темы: rail overflow, deep 12-level group,
  empty group, line normalization, 80-character names, menu возле нижнего края,
  editor DnD/keyboard alternative, icon picker, dirty guard, errors/conflict.
  Сохранить screenshots и реальные результаты, не заменять их mockup checker.
- [ ] После отдельного разрешения live install: проверить выбор провайдера,
  редактор при активном/неактивном provider, restart persistence, project switch,
  two-window conflict, account boundary и fallback после disable. Без разрешения
  live integration остаётся NOT TESTED; не устанавливать плагин ради отчёта.
- [ ] Самостоятельно просмотреть diff на scope, безопасность, потерю данных,
  соответствие spec и documentation drift. Запустить финальные `npm run check`,
  `npm run build` и manifest checker после последних изменений; повторять только
  проверки, затронутые последующими правками.
- [ ] Handoff: Changes + Acceptance по каждому пути, ссылки на evidence;
  показать реальные PASS/FAIL/BLOCKED/NOT TESTED. Не объявлять runtime integration
  готовой по одним SDK fakes или успешной сборке.

## Проверка покрытия плана (self-review)

- Панель, menu/focus, keyboard и badge → Task 5; editor/draft/guard → Task 6.
- Дерево/согласование/visibility/separators → Tasks 2–3; storage, CAS, scope и
  realtime/reconnect → Task 4 с обязательной feasibility Task 1.
- Documentation/manifests/Zed → Task 7; responsive/live/fallback → Task 8.
- Все пять Review Focus условий привязаны к тестовым шагам; сигнатуры core и
  wire согласованы. Proposed symbols — интерфейсы нового плагина, не заявления
  о существующих API BB. Точные host symbols фиксирует Task 1.
- Scope согласованной спецификации сохранён. При несовместимости SDK требуется
  явное решение по конкретному gap, а не самовольная потеря требования.

## Исполнение

План подготовлен; реализация не начата. Рекомендуемый способ — native в текущей
сессии: задачи тесно связаны общими типами и одним BB adapter, исходный контекст
не потребуется передавать заново. Делегирование возможно только после выбора
пользователя и в рамках активных правил моделей/контекста. Никакой другой модели
или quorum этот план не включает.
