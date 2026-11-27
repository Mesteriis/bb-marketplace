# Makosh Git — новый интерфейс: план срезов R1–R8

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** перевести весь UI `plugins/bb-git-dashboard` на утверждённый макет (светлая и тёмная темы, русский и английский) без потери функций.

**Architecture:** токены и примитивы — один слой CSS и маленьких React-компонентов в `src/ui/system/`; строки — словарь `ru`/`en` в `src/core/i18n/`; вычисления новых разделов (пункты и стадии обзора, виды проектов) — чистые функции в `src/core/`. Разделы переводятся целиком, по одному на срез. R1 расписан задачами; у R2–R8 здесь состав, данные и приёмка, а их задачи пишутся отдельным планом перед началом среза (по этому же образцу).

**Tech Stack:** React 19 и BB Plugin SDK 0.6.157 (`app.slots`, `experimental_sidebar`, `experimental_tab`), CSS на токенах BB с относительным синтаксисом цвета, `node:test`, стенд `docs/e2e-stand` (Playwright, chrome-headless-shell).

**Spec:** спецификация и эталоны — в хранилище родительского треда (спецификация редизайна, PNG-эталоны 80 артбордов, генератор макетов `base.css`, `build.py`, `more.py` для справки по разметке и токенам).

## Решения родителя (2026-11-27)

- Версия на каждом срезе: R1 = 0.14.0, R2 = 0.14.1 … R8 = 0.14.7; запись CHANGELOG под своей версией. Скаффолды — 0.15.0, миграция — 0.16.0.
- Тёмная тема на стенде — механизмом BB: `localStorage["bb.theme"] = "dark"` до загрузки (класс `.dark` на `<html>`); своей темы нет.
- Тест токенов проверяет контраст 4.5:1 на всех палитрах BB (default, catppuccin, dracula, gruvbox, nord, solarized — светлые и тёмные).
- Переключатель языка меняет только строки, уже переведённые на словарь; разделы уходят в словарь вместе со своим срезом.
- Классы системы — с префиксом `g-` (`g-btn`, `g-chip`…), чтобы утилиты BB внутри плагина их не задевали.
- Превью «Нового проекта» для машины не на macOS не обещает записи в Keychain — в R7.
- Стенд и тесты не вызывают системных окон.

## Global Constraints

- Цвета только из токенов BB: `--background`, `--foreground`, `--muted-foreground`, `--border`, `--accent`, `--card`, `--primary`, `--primary-foreground`, `--destructive`, `--ring`, `--font-mono`; свои — только `--git-*` (успех, предупреждение, фиолетовый, текст ошибки, четыре подложки); `prefers-color-scheme` не читается, своей темы нет; подложки смешиваются в `oklab`.
- Типографика: основной 13px, мета 12px, заголовок страницы 20px/650, моно 12px; числа `tabular-nums`. Сетка 4px; скругление 8px, кнопки 7px, чипы — пилюля, диалог 12px.
- Одна главная (тёмная) кнопка на экран; остальные — обводка или «призрак»; ряды из 6–10 кнопок → главная, 2–3 вторичные и меню «⋯»; карточки-счётчики → строка чисел или чипы-фильтры; карточек в карточках нет.
- Доступность: вкладки — `tablist`/`tab`; диалоги — `dialog` с ловушкой и возвратом фокуса; таблицы — `table` с заголовками; статус не только цветом; `:focus-visible`, hover, pressed, disabled у каждого элемента; цели не ниже 28px в плотных списках и 32px у кнопок форм; клавиши `/`, `j`/`k`, `n`/`p` сохраняются.
- Ширина: дашборд от 768px, панель рядом с тредом от 420 до 640px (резиновая); таблицы на узкой ширине прокручиваются внутри себя.
- `src/core` и `src/ui` без кода хоста; BB не правится; функции не меняются, кроме раздела 6 спецификации; новых запросов к форджам и прав не добавляется.
- Подтверждение записей — диалог с тем, что будет сделано, и одной главной кнопкой (образец `ci-dispatch`, `catalog-clone`).
- Старый и новый вид раздела не живут дольше одного среза.
- Не пушить; основной checkout и `design/` не трогать; в публичном коде нет настоящих хостов, аккаунтов и путей.

## Review Focus

- Тёмная тема BB: каждый `--git-*` читаем на `--background` тёмной темы (контраст текста не ниже 4.5:1) — тест токенов и снимок стенда в тёмной теме на каждом срезе.
- Длинные русские строки (в 1,3–1,5 раза длиннее английских) в кнопках, чипах и узкой панели 420px: не обрезают смысл и не ломают строку — снимки 768 и 420 на русском.
- Пустые, загрузка, ошибка, лимит форджа, нет аккаунта на каждой странице: тексты нынешних состояний сохранены — проба стенда переключает их (двойник отдаёт 429, 500, пусто).
- Клавиатура после перестройки навигации: `/` фокусирует поиск боковой колонки, `j`/`k` в списках, фокус возвращается из диалога на вызвавшую кнопку — проба в R1 и в каждом срезе со списками.
- Пробы стенда: селекторы меняются вместе с вёрсткой, проверяемое поведение — нет; каждый срез прогоняет все 16 проб.

---

## R1 — система, каркас, язык

Состав: токены `--git-*` и примитивы; боковая колонка с поиском, разделами, деревом «Папки проектов», «Подключениями» и переключателем языка вместо кнопок сверху; словарь `ru`/`en` и настройка языка; шапка страницы по макету. Содержимое разделов в R1 не перерисовывается (кроме того, что даёт новая система классов); маршрут по умолчанию до R2 ведёт на нынешнюю страницу проектов.

### Task 1: токены и примитивы CSS

**Files:**
- Create: `src/ui/system/tokens.css`, `src/ui/system/system.css`
- Test: `tests/ui-tokens.test.ts`

**Interfaces:**
- Produces: классы под `.git-ws` с именами макета — `nav`, `tree`, `views`, `seg`, `btn` (`pri`, `ghost`, `sm`, `off`), `chip` (`good`, `bad`, `warn`, `vio`, `line`), `tbl` (строка 40px, двухстрочная 46px), `it`, `file`, `diff`, `thr`, `banner`, `modal`, `tog`, `inp`; переменные `--git-success`, `--git-warning`, `--git-violet`, `--git-bad-text`, `--git-bad-bg`, `--git-good-bg`, `--git-warn-bg`, `--git-violet-bg`.

- [ ] **Step 1: тест** `tests/ui-tokens.test.ts`: в `tokens.css` и `system.css` каждое `var(--x)` — из списка токенов BB или `--git-*`; нет `prefers-color-scheme`; нет литеральных цветов (`#`, `rgb(`, `hsl(`) вне `oklch(from var(--background) …)`; `color-mix` подложек — `in oklab`.
- [ ] **Step 2:** `node --test tests/ui-tokens.test.ts` — FAIL (файлов нет).
- [ ] **Step 3:** `tokens.css` — значения из `base.css` (`:root`), где выбор светлое/тёмное выражен через фон: светлота `calc(Lсвет + (1 - l) * (Lтём - Lсвет) / 0.805)` от `oklch(from var(--background) …)` (0.805 = 1 − светлота тёмного фона BB 19.5%); `system.css` — компоненты по `base.css`/`more.py` с hover, pressed, `:focus-visible` (`--ring`), disabled.
- [ ] **Step 4:** тест — PASS; `npm run check`.
- [ ] **Step 5:** commit `feat(bb-git-dashboard): R1 tokens and primitives of the new interface`.

### Task 2: словарь и язык

**Files:**
- Create: `src/core/i18n/dictionary.ts`, `src/core/i18n/language.ts`, `src/ui/i18n/use-t.tsx`
- Modify: `src/adapters/bb/history-rpc.ts` (настройки интерфейса рядом с прочими)
- Test: `tests/i18n.test.ts`

**Interfaces:**
- Produces: `type Language = "ru" | "en"`; `type MessageKey = keyof typeof en`; `const ru: Record<MessageKey, string>` (тип требует все ключи); `format(language: Language, key: MessageKey, vars?: Record<string, string | number>): string` (подстановка `{name}`, русская множественная форма через `{n|файл|файла|файлов}`); `resolveLanguage(setting: "auto" | "ru" | "en", bbLang: string | undefined): Language` (`auto` берёт `ru` для `ru*`, иначе `en`); `LanguageProvider`, `useT(): (key, vars?) => string`; настройки `uiLanguage` (`auto`/`ru`/`en`, по умолчанию `auto`) и `overviewView` (`list`/`board`, по умолчанию `list`).

- [ ] **Step 1: тест**: `format("ru", "files", {n: 1})` → `"1 файл"`, `{n: 3}` → `"3 файла"`, `{n: 11}` → `"11 файлов"`, `{n: 21}` → `"21 файл"`; `format("en", "files", {n: 1})` → `"1 file"`; `resolveLanguage("auto", "ru-RU")` → `"ru"`, `("auto", "de")` → `"en"`, `("en", "ru")` → `"en"`; у `ru` и `en` одинаковые ключи и нет пустых значений.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** реализация; «Как в BB» читает `document.documentElement.lang`, затем `navigator.language` — в адаптере приложения, в ядро приходит строка.
- [ ] **Step 4:** PASS; `npm run check`.
- [ ] **Step 5:** commit.

### Task 3: каркас — боковая колонка и шапка

**Files:**
- Create: `src/ui/shell/sidebar.tsx`, `src/ui/shell/page-head.tsx`, `src/ui/shell/sections.ts`
- Modify: `app.tsx` (`ProjectsSidebar` → `Sidebar`, `Dashboard` без ряда кнопок разделов), `src/ui/project-workspace.tsx` (кнопки разделов сверху убираются)
- Test: `tests/ui-sections.test.ts`, проба `docs/e2e-stand/shell.mjs`

**Interfaces:**
- Consumes: `useT`, классы Task 1.
- Produces: `sections: {id: SectionId; path: string; icon: string; label: MessageKey}[]` для `overview`, `inbox`, `ci`, `reviews`, `projects`, `catalog`, `connections`; `sectionOf(subPath: string): SectionId` (тест: `""`→`overview`, `"inbox"`→`inbox`, `"<copyId>/actions"`→`projects`, `"pr/…"`→`inbox`, `"catalog"`→`catalog`, `"remotes"`→`connections`); `PageHead({title, sub?, actions?})`.

- [ ] **Step 1:** тест `sectionOf` с перечисленными путями.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** `sections.ts`; `Sidebar` — поиск «Проект, PR или ветка» (`/` фокусирует), разделы со счётчиками (`Мои PR` — непрочитанные, как сейчас значок), дерево «Папка проектов» из нынешнего источника дерева проектов, «Подключения», переключатель языка `seg` (RU/EN, пишет `uiLanguage`); `PageHead` по `.head`.
- [ ] **Step 4:** PASS; проба `shell.mjs`: разделы доступны с клавиатуры, `/` фокусирует поиск, язык переключается и переживает перезагрузку, нет горизонтального скролла на 768px; снимки 1440×1024 светлая/тёмная рядом с `overview-list.png` (колонка и шапка) с перечнем расхождений.
- [ ] **Step 5:** все 16 проб (селекторы кнопок разделов → ссылки колонки); commit.

### Task 4: диалог, состояния страниц, примитивы React

> Сделано в R1: `useModal` и `Dialog` (ловушка Tab, возврат фокуса) во всех трёх диалогах. `PageState`, `Views`, `Segmented`, `Toggle`, `Banner` переносятся в срезы, где у них появляется первое применение (R2 и дальше): без применения это непроверенный код.

**Files:**
- Create: `src/ui/system/dialog.tsx`, `src/ui/system/page-state.tsx`, `src/ui/system/controls.tsx` (`Button`, `Chip`, `Views` (tablist), `Segmented`, `Toggle`, `Banner`)
- Modify: `src/ui/ci/confirm-dialog.tsx` (поверх `Dialog`, внешний API тот же)
- Test: проба `docs/e2e-stand/shell.mjs` (фокус)

**Interfaces:**
- Produces: `Dialog({title, onClose, children, actions})` (ловушка фокуса, Esc, возврат фокуса); `PageState({kind: "loading" | "empty" | "error" | "rate-limit" | "no-account", text, action?})`; `Views({tabs, current, onChange})` с `role=tablist`/`tab` и стрелками.

- [ ] **Step 1:** в `shell.mjs` — открыть любой диалог подтверждения, Tab по кругу не выходит из диалога, Esc закрывает, фокус на вызвавшей кнопке.
- [ ] **Step 2:** FAIL на нынешнем диалоге (фокус не возвращается).
- [ ] **Step 3:** реализация; `ConfirmDialog` использует `Dialog`.
- [ ] **Step 4:** проба PASS; все пробы; commit.

### Task 5: приёмка R1

- [ ] `npm run check`, `npm run build`, `node ../../scripts/check-manifests.mjs`; все 16 проб; снимки 1440×1024 и 768 в двух темах и двух языках, и снимок каждого раздела в новом каркасе (старое содержимое не должно выглядеть сломанным); ревью на Opus; версия 0.14.0 и запись CHANGELOG под ней; доклад со снимками и расхождениями.

Тему стенда для снимков переключаю настройкой темы BB стенда (механизм выясняю в начале R1 по `bb guide`); если переключения извне нет — снимки тёмной темы через `color-scheme` нельзя, тогда спрошу.

---

## R2 — Обзор (список и доска)

Артборды `overview-list`, `overview-board`, `overview-list-en`. Чистые функции `src/core/overview/` (`overviewItems`, `overviewStages`) с тестами на эталонах; страница `src/ui/overview/`.

Данные (только имеющиеся):
- «Нужно ваше действие»: мой PR с упавшим CI, ревью ждёт меня, конфликт, комментарии без моего ответа — из списка «Мои PR» (поля `ci`, `myReview`/вкладка Review requested, `conflicts`, `unresolvedThreads` и счёт «ждут вашего ответа» 0.9.4).
- «Можно завершить»: готов к слиянию (открыт, CI зелёный, ревью одобрено, без конфликтов) — «Мои PR»; «не запушено» — копии с `ahead > 0` из статуса каталога (`catalogBulk` status, без fetch).
- «Идёт без вас»: CI выполняется — сводка CI/CD (`ciOverview`); «отстаёт от origin» — `behind > 0` из того же статуса.
- Доска: Локально (ahead > 0 без PR) → PR открыт → На ревью (ревьюеры есть, решения нет) → Готово к слиянию → Слито за неделю (вкладка Merged «Моих PR», 7 дней); строка «CI сейчас» — выполняющиеся запуски.
- Детали справа: одна главная кнопка по виду пункта (открыть PR, перезапустить упавшие job, открыть ревью, Push, Pull).
- Статус копий: один проход статуса по копиям при открытии и по кнопке «Обновить», с ограничением 50 и кешем на сессию — новых запросов к форджам нет.

Приёмка: тесты функций на всех правилах групп и стадий; проба `overview.mjs` (пункты из двойников Gitea и GitLab и копий стенда, переключатель вида и настройка `overviewView`); снимки с эталонами.

## R3 — Проекты и страница проекта, «Код»

Артборды `projects`, `project-code`, `project-conflict`, `project-branches`, `project-worktrees`, `project-activity`, `project-issues`, `project-variables`. Таблица «Папки проектов» с группами по категориям, сохранёнными видами (Все, Требуют внимания, С изменениями, Мои PR, CI упал — производные от статуса копий, «Моих PR» и сводки CI) и групповыми Fetch/Pull каталога. Страница проекта: шесть вкладок (Код, История, Ревью, CI/CD, Issues, Переменные) как `tablist`, внутри «Кода» — Изменения, Ветки, Worktrees, Активность; подвкладка History убирается. «Спросить агента» у issue — по образцу CI (`ciAsk`): тот же путь треда и промпта, тело issue — как недоверенный текст.

## R4 — Мои PR и страница PR

Артборды `my-prs`, `pr-overview`, `pr-checks`, `pr-files`, `pr-commits`, `pr-comments`. Плитки → строка чисел и чипы-фильтры; ряд действий → главная, две-три вторичные, «⋯». Черновик ответа агента: строка с «Отправить / Изменить / Отбросить» на «Комментариях» и та же правка в месте ответа (решение — показать в докладе со снимками обоих мест).

## R5 — CI/CD

Артборды `ci`, `ci-run`, `ci-dispatch`, `project-actions`, `project-ci-templates`. Плитки Running/Queued/Failed → строка чисел; запуск — диалог по `ci-dispatch`.

## R6 — Ревью и История

Артборды `reviews`, `project-review`, `project-review-ai`, `project-history`.

## R7 — Каталог, Подключения, Настройки

Артборды `catalog`, `catalog-local`, `catalog-clone`, `new-project`, `connections`, `connect-type`, `connect-verify`, `settings`. Форма «Новый проект» и шаги мастера подключения сверяются с кодом (спецификация оговаривает, что они додуманы); настройки языка и «Обзор открывается» — здесь же.

## R8 — панель рядом с тредом

Артборды `thread-panel`, `panel-changes`, `panel-ci`, `panel-history`, `panel-pinned-pr`, `panel-pinned-copy`. Вкладки Git, Git History, CI/CD, Review сводятся в одну закреплённую «Git»: сводка и вложенные экраны с «назад»; закреплённые PR и чужая копия остаются вкладками `availability: "action"`. Ширина панели BB измеряется на стенде; вёрстка резиновая 420–640. Версия R8 — 0.14.7; README и PLUGIN_OVERVIEW — по мере срезов.

## Каждый срез

Свой план задач по образцу R1 → TDD → все пробы стенда → снимки 1440×1024 и панели 520 в двух темах рядом с эталонами с названными расхождениями → `npm run check`, `npm run build`, манифесты → ревью на Opus → доклад.
