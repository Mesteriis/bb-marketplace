# Клик в списке → тайл, связанные блоки — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** обычный клик по треду в списке Makosh Sidebar на странице Чертога добавляет тайл треда (или фокусирует уже открытый); субтреды и сущности, открытые из тайла, встают в связанный блок рядом с основным тайлом и закрываются и переносятся вместе с ним.

**Architecture:** чистые операции блока в `src/core/workspace/blocks.ts` поверх существующих `splitGroup`/`moveTab`/`activateTab`; связь «родитель → дети» вычисляется адаптером (дерево тредов BB для тредов, поле `parent` панели для сущностей). Сигнал из боковой панели — событие документа `chertog.open.v1` (по образцу `chertog.embed.v1`), которое принимает только окно, показывающее страницу Чертога.

**Tech Stack:** TypeScript, React, zod 4, vitest, `@get-bb/plugin-sdk` 0.6.157, Playwright-стенд из `docs/e2e-stand.md`.

**Spec:** `plugins/chertog/docs/absorption-design.md` (проект 1).

## Global Constraints

- `src/core` и `src/ui` без кода хоста; `tests/architecture.test.ts` не ослаблять.
- Без импортов между `plugins/chertog` и `plugins/sidebar`; общий только протокол события.
- Cmd/Ctrl/Shift/Alt-клик и средняя кнопка — всегда штатный переход BB.
- Вне страницы Чертога клик работает штатно (событие не принимается).
- Тред уже открыт в раскладке → фокус на его тайл, второго тайла нет.
- Субтред при открытом основном → в блок основного; основной не открыт → самостоятельный тайл.
- Блок: первый подчинённый — справа от основного; второй и третий — под предыдущим подчинённым; сверх трёх — вкладкой в последнем тайле блока.
- Родитель треда берётся из `parentThreadId` дерева BB в момент открытия, в документе не хранится.
- Проверки: `npm run check`, `npm run build` в обоих плагинах, `node ../../scripts/check-manifests.mjs`.
- Push и установка в рабочий BB — только с разрешения владельца.

## Review Focus

1. Клик по треду, пока Чертог открыт в другой вкладке/окне, но в этом окне не показан — переход штатный, тайл не добавляется ни в одном окне (Task 3: окно без показанной страницы не принимает).
2. Двойной быстрый клик по одному треду — один тайл (Task 2: идемпотентность через `panelIdOfRef`).
3. Закрытие основного тайла, когда подчинённый уже перенесён пользователем в другое место раскладки, — подчинённый всё равно закрывается вместе с основным, раскладка остаётся валидной (Task 4).
4. Субтред, чей родитель есть в документе, но скрыт (не размещён в открытой раскладке), — открывается самостоятельным тайлом (Task 2).
5. Боковая панель без Чертога (плагин выключен) — событие никто не принимает, переход штатный без задержки (Task 5).

---

### Task 1: Операции связанного блока в ядре

**Files:**
- Create: `src/core/workspace/blocks.ts`
- Modify: `src/core/workspace/index.ts` (экспорт)
- Test: `tests/core/workspace/blocks.test.ts`

**Interfaces:**
- Consumes: `splitGroup`, `moveTab`, `activateTab`, `closeTab`, `findGroupOfPanel`, `findGroup` из `src/core/layout`; `WorkspaceDocument`, `changeActiveLayout`, `registerPanel`, `removePanelFromLayout` из `src/core/workspace`.
- Produces:
  - `type ParentOf = (panelId: string) => string | undefined`
  - `BLOCK_SIDE_LIMIT = 3`
  - `blockChildren(document: WorkspaceDocument, parentPanelId: string, parentOf: ParentOf): string[]` — размещённые в открытой раскладке дети в порядке размещения.
  - `placeInBlock(document: WorkspaceDocument, parentPanelId: string, panelId: string, panel: WorkspacePanel, parentOf: ParentOf): WorkspaceChange`
  - `closeBlock(document: WorkspaceDocument, parentPanelId: string, parentOf: ParentOf, live: ReadonlySet<string>): WorkspaceChange`
  - `moveBlock(document: WorkspaceDocument, parentGroupId: string, targetGroupId: string, edge: Edge, parentOf: ParentOf): WorkspaceChange`

- [ ] **Step 1: Write the failing tests** — раскладка из одного тайла `p` (тред-родитель):
  - `placeInBlock(c1)` → группа `c1` справа от группы `p` (split `row`, порядок `[p, c1]`), фокус на `c1`.
  - `c2`, `c3` → каждый в новой группе под предыдущим ребёнком (split `column` внутри правой части), `blockChildren` = `[c1, c2, c3]`.
  - `c4` → вкладка в группе `c3`, активна; новых групп нет.
  - повторный `placeInBlock(c1)` → `activateTab`, документ без новых групп.
  - `closeBlock(p)` убирает `p`, `c1..c4` из открытой раскладки; другие тайлы не тронуты; `p` с живым экземпляром остаётся в `document.panels`.
  - `moveBlock(group(p), other, "left")` → `p` слева от `other`, дети снова справа от `p` в прежнем порядке.
  - ребёнок, вручную перенесённый в чужую группу, закрывается `closeBlock` вместе с родителем.
- [ ] **Step 2: Run** `npx vitest run --configLoader runner tests/core/workspace/blocks.test.ts` — FAIL (модуля нет).
- [ ] **Step 3: Implement** функции выше. `placeInBlock`: если дети уже есть и их < 3 — `splitGroup(группа последнего ребёнка, "bottom")`; детей нет — `splitGroup(группа родителя, "right")`; ≥ 3 — `moveTab` в группу последнего ребёнка. `moveBlock`: `moveGroup` родителя, затем каждый ребёнок `placeInBlock` заново.
- [ ] **Step 4: Run** тот же тест — PASS; `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(chertog): keep parent and child tiles together as a block`.

### Task 2: Открытие треда в сессии окна

**Files:**
- Modify: `src/adapters/bb/app/thread-source.ts` (`ThreadEntry.parentThreadId?: string`)
- Modify: `src/adapters/bb/app/register.tsx` (передать `thread.parentThreadId` из `experimental_useSidebarThreads`)
- Modify: `src/adapters/bb/app/workspace-session.ts`
- Test: `tests/adapters/app/workspace-session-open.test.ts`

**Interfaces:**
- Consumes: Task 1; `threadRef`, `panelIdOfRef`, `surfaceState()`.
- Produces:
  - `WorkspaceSession.openThread(threadId: string): "opened" | "focused" | "not-shown"`
  - `WorkspaceSession.parentOf: ParentOf` — тред: `parentThreadId` записи каталога → id панели родителя, размещённой в открытой раскладке; иначе поле `parent` панели (Task 6).

- [ ] **Step 1: Write the failing tests:** страница не показана → `"not-shown"`, документ не меняется; тред размещён → `"focused"`, фокус на его группе; новый тред без родителя → `"opened"`, новая группа справа от сфокусированной; субтред при размещённом родителе → в блоке родителя (`blockChildren` содержит его); субтред при родителе, известном документу, но не размещённом, → самостоятельная группа; два вызова подряд для одного треда → одна панель.
- [ ] **Step 2: Run** `npx vitest run --configLoader runner tests/adapters/app/workspace-session-open.test.ts` — FAIL.
- [ ] **Step 3: Implement** `openThread` через `this.controller.change` и `parentOf` выше; новый самостоятельный тайл — `splitGroup(focusedGroupId, "right")` с `registerPanel(threadRef(id))`.
- [ ] **Step 4: Run** — PASS; `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(chertog): open a thread as a tile or focus its tile`.

### Task 3: Протокол `chertog.open.v1` и приём в окне Чертога

**Files:**
- Create: `src/core/wire/open.ts`
- Modify: `src/core/wire/index.ts`, `src/adapters/bb/app/register.tsx`
- Create: `docs/open-wire-v1.md` (формат события, по образцу `docs/embed-wire-v1.md`)
- Test: `tests/core/wire/open.test.ts`, `tests/adapters/app/open-listener.test.tsx`

**Interfaces:**
- Produces:
  - `OPEN_EVENT = "chertog.open.v1"`
  - `openRequestSchema = z.strictObject({ kind: z.literal("thread"), threadId: z.string().min(1).max(200), accepted: z.boolean() })`
  - Протокол: отправитель создаёт `CustomEvent(OPEN_EVENT, { detail: { kind: "thread", threadId, accepted: false } })` и вызывает `window.dispatchEvent` синхронно; приёмник при успехе ставит `detail.accepted = true` до возврата. Принято → отправитель не переходит.
- [ ] **Step 1: Write the failing tests:** схема отклоняет лишние поля и пустой `threadId`; слушатель при показанной странице вызывает `openThread` и ставит `accepted: true`; при `"not-shown"` оставляет `false`; невалидная деталь игнорируется без исключения.
- [ ] **Step 2: Run** оба теста — FAIL.
- [ ] **Step 3: Implement** схему и `useOpenRequests(session)` в `register.tsx` (подписка в `ChertogOverlay`, отписка при размонтировании).
- [ ] **Step 4: Run** — PASS; `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(chertog): accept chertog.open.v1 thread requests on the workspace page`.

### Task 4: Закрытие и перенос блока из меню тайла

**Files:**
- Modify: `src/adapters/bb/app/workspace-session.ts` (скрытие и закрытие основного тайла идут через `closeBlock`; перенос группы основного — через `moveBlock`)
- Modify: `src/ui/tiles/tile-menu.tsx`, `src/ui/tiles/labels.ts` (подпись «Закрыть вместе с подчинёнными (N)» в вопросе о закрытии, когда у тайла есть дети)
- Test: `tests/adapters/app/workspace-session-blocks.test.ts`, `tests/ui/tiles/chrome.test.tsx`

- [ ] **Step 1: Write the failing tests:** скрытие основного убирает его детей из раскладки; закрытие основного с живыми детьми задаёт один вопрос и закрывает всех; перенос основного жестом переносит блок; тайл без детей ведёт себя как раньше (существующие тесты не меняются).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(chertog): close and move a parent tile together with its block`.

### Task 5: Боковая панель отправляет `chertog.open.v1`

**Files:**
- Create: `plugins/sidebar/src/adapters/bb/chertog-open.ts` — `requestChertogTile(threadId: string): boolean` (копия формы события, без импорта из Чертога)
- Modify: `plugins/sidebar/app.tsx:162-163` (строка треда), `:173` (строка «Требует внимания»)
- Modify: `plugins/sidebar/README.md`, `plugins/sidebar/PLUGIN_OVERVIEW.md` (одна фраза о Чертоге)
- Test: `plugins/sidebar/src/adapters/bb/chertog-open.test.ts`

- [ ] **Step 1: Write the failing tests:** без слушателя → `false`; слушатель ставит `accepted` → `true`; слушатель бросает исключение → `false`.
- [ ] **Step 2: Run** `npm test -- chertog-open` в `plugins/sidebar` — FAIL.
- [ ] **Step 3: Implement** и в обработчиках клика: после проверки модификаторов `if (requestChertogTile(id)) { e.preventDefault(); onNavigate(); return; }`, иначе прежний `navigate.toThread`. Для «Требует внимания» передаётся тот же id, что уходит в `navigate.toThread`.
- [ ] **Step 4: Run** `npm run check`, `npm run build` в `plugins/sidebar` — PASS.
- [ ] **Step 5: Commit** `feat(sidebar): offer thread clicks to an open Chertog workspace first`.

### Task 6: «Открыть рядом» — сущность как подчинённый тайл

**Files:**
- Modify: `src/core/workspace/document.ts` — `WorkspacePanel.parent?: string` (id панели), `SCHEMA_VERSION = 3`, миграция 2 → 3 без изменений данных
- Modify: `src/core/workspace/read.ts` (цепочка миграций), `src/core/workspace/operations.ts` (`replaceChoosePanel` переносит `parent` выбора на новую панель)
- Modify: `src/ui/tiles/tile-menu.tsx`, `labels.ts` — пункт «Открыть рядом…» создаёт тайл выбора в блоке этого тайла с `parent`
- Modify: `src/adapters/bb/app/workspace-session.ts` (`parentOf` учитывает `parent`)
- Test: `tests/core/workspace/document.test.ts`, `tests/core/workspace/blocks.test.ts`, `tests/ui/tiles/chrome.test.tsx`

- [ ] **Step 1: Write the failing tests:** документ v2 читается и сохраняется как v3; `parent`, ссылающийся на неизвестную панель, отклоняется схемой; «Открыть рядом…» ставит тайл выбора справа от родителя; выбор RDP в нём даёт панель с тем же `parent`, и `closeBlock` родителя закрывает её.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(chertog): open an entity next to a tile as its child`.

### Task 7: Сквозная проверка на стенде и документация

**Files:**
- Create: `tests/adapters/app/open-from-sidebar.browser.mjs`
- Modify: `docs/acceptance-bc.md` (новый раздел «Клик в списке → тайл»), `PLUGIN_OVERVIEW.md`, `package.json` `bb.description`, запись `marketplace.json` (меняются вместе)

- [ ] **Step 1:** сценарий на изолированном стенде с установленными Чертогом и Makosh Sidebar из рабочего дерева: клик по треду на странице Чертога → тайл, URL не изменился; повторный клик → тот же тайл в фокусе; клик по субтреду → в блоке справа; Cmd-клик → штатный переход; клик вне страницы Чертога → штатный переход; закрытие основного → блок закрыт; ни одной ошибки страницы.
- [ ] **Step 2: Run** сценарий — PASS; журнал в `docs/acceptance-bc/`.
- [ ] **Step 3:** `npm run check` и `npm run build` в обоих плагинах, `node ../../scripts/check-manifests.mjs` — PASS.
- [ ] **Step 4: Commit** `docs(chertog): record click-to-tile acceptance`.

## Вне этого плана

- Разворачивание и сворачивание блока целиком (maximize/minimize): сейчас разворачивается один тайл. Требует перевести `maximizedGroupId` на узлы `split`; отдельная задача после согласования.
- Поглощение Sidebar (проект 2) уберёт событие и заменит его внутренним вызовом.
