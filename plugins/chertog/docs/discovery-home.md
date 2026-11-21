# Чертог: проверка интеграции Home и SDK

Отчёт по разделам 1 и 2 задания [spec.md](spec.md). Только чтение кода: плагин и хост не менялись, BB не запускался и не перенастраивался. Дата проверки: 21.11.2026.

## Итог

1. Штатный «Домой» в BB не открывает отдельную страницу. Это действие `goHome`: возврат к последнему маршруту списка тредов (тред, экран нового треда или страница проекта). Если такой маршрут уже открыт, действие ничего не делает.
2. Публичного способа заменить содержимое Home целиком нет ни в одной из трёх проверенных версий SDK (0.6.132, 0.6.157, 0.6.178). Нет ни слота, ни настройки выбора домашней поверхности.
3. `homepageSection` только добавляет секцию под композером на экране нового треда. `experimental_appOverlay` рисует поверх окна и по условию задания заменой не считается. `navPanel` владеет своим маршрутом целиком, но хост не считает его Home.
4. На этапе A Чертог публично занимает только маршрут своей `navPanel` (`/plugins/chertog/<path>`). Чтобы на него вёл штатный «Домой», нужен узкий отключаемый патч хоста (раздел «Пробел хоста»). Без патча строка приёмки «Штатный Home» остаётся открытой.
5. Установленный BB Desktop 0.50.1 собран с SDK 0.6.157, а не 0.6.178, как upstream на проверенном SHA. В установленной сборке нет `experimental_useActiveComposer`; в SDK 0.6.132, доступном в репозитории, нет ещё и `context.composer`.

## Что и где проверено

| Объект | Значение | Как получено |
|---|---|---|
| Worktree | ветка `feature/slice-item-id-itm-mwqar0sl-7g1sb1-home-thr_s6iu7qik8z`, HEAD `ccad3f570dc3381b1a88858042650989ba293c6f`, до отчёта чистый | `git rev-parse HEAD`, `git status` |
| Локальный `main` | `3ed0189aa265476b1a22583261c5551846a33106`; HEAD worktree опережает его на один коммит (`docs(chertog): implementation brief…`) | `git log` |
| BB Desktop (установлен) | 0.50.1, `/Applications/dev/bb.app`; запущен 18.11.2026, поверхность `desktop` | `bb --version`, `Info.plist`, `~/.bb/bb-app-runtime.json` |
| SDK в установленном BB | `PLUGIN_SDK_VERSION = "0.6.157"` | `…/app.asar.unpacked/node_modules/@bb/domain/src/plugin-sdk-version.ts` |
| SDK в репозитории | в worktree `node_modules` нет; в основном checkout установлены 0.6.132 (15 плагинов), 0.6.94, 0.5.9, 0.4.84. В `package.json` плагинов встречается максимум 0.6.140 (один плагин, не установлен) | `plugins/*/node_modules/@get-bb/plugin-sdk/package.json` |
| Upstream | `get-bb/bb@35a03bbbb3f4d8dc814c1a152db5a463102b4250`: SDK 0.6.178, Desktop 0.50.1 | архив исходников на этом SHA |

Сигнатуры ниже взяты из `bundled-types` SDK 0.6.132 (самая новая установленная версия): `plugins/mail/node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts` основного checkout, дальше `app.d.ts`. Серверная часть: `bb-plugin-sdk.d.ts` там же, дальше `sdk.d.ts`. Пути `apps/app/…`, `packages/plugin-sdk/…` и `plugins/navigation/…` относятся к upstream на указанном SHA.

Установленный бинарник проверен только поиском строк в собранных файлах `…/bb-app/app/dist/assets/*.js`. Это подтверждает наличие или отсутствие имени, но не поведение.

## Расхождения версий по затрагиваемым контрактам

| Контракт | SDK 0.6.132 (репозиторий) | Установленный BB (SDK 0.6.157) | Upstream 0.6.178 |
|---|---|---|---|
| `homepageSection`, `experimental_appOverlay`, `navPanel` | есть, сигнатуры совпадают с upstream | имена есть в сборке | есть |
| `goHome`, `isHomeActive` | есть | `goHome` есть в сборке | есть, тот же текст контракта |
| `ThreadChat` (`threadId`, `layout`) | есть | есть в сборке | есть, те же поля |
| `useSidebarSplitLayout` | есть | есть в сборке | есть, та же форма |
| `useComposer`, `useComposers` | есть | `useComposers` есть в сборке | есть |
| `context.composer` у команд | **нет**: `PluginCommandContext` содержит только `threadId`, `projectId`, `experimental_panel` (`app.d.ts:22305`) | не проверено (по минифицированной сборке не установить) | есть: `composer: PluginComposerApi \| null` (`app-contract.ts:3674`, контекст команды `:3748`) |
| `experimental_useActiveComposer` | **нет** (0 вхождений) | **нет** (0 вхождений в сборке) | есть (`app-contract.ts:5973`) |
| Выбор домашней поверхности | нет | не найдено | нет |

Следствия:

- Номер Desktop 0.50.1 совпадает с upstream, но сборка другая. PR #7960 (`context.composer`, `experimental_useActiveComposer`) и #7971 (фокус split) в установленном BB не подтверждены. Для `experimental_useActiveComposer` отсутствие подтверждено.
- Плагин, собранный против 0.6.132, не может типизированно использовать `context.composer`. Версию SDK для Чертога нужно выбрать отдельно: 0.6.157 соответствует установленному BB, 0.6.178 требует обновления BB.
- Наличие версий 0.6.157 и 0.6.178 в npm, новые релевантные PR и их статус: не проверено.

## Действие «Домой»

**Контракт.** `app.d.ts:19470`, внутри `ExperimentalSidebarNavigationActions`:

```ts
/**
 * Return to the thread list and the last thread or new thread screen the
 * user had open before visiting Settings, Plugins, Skills, or a plugin
 * panel. Target `tab` instead opens the new thread screen in a browser
 * tab …
 */
goHome(options?: {
    target: Exclude<ExperimentalSidebarNavigationTarget, "split">;
}): void;
```

`app.d.ts:19506`: `isHomeActive: boolean` — «True on the thread list's routes: a thread, the new thread screen, or a project page. Settings, Plugins, Skills, and plugin panels are not home.» Оба поля доступны через `experimental_useSidebarNavigation()` (`app.d.ts:24294`); вне sidebar хук возвращает пустые действия.

**Реализация в upstream.**

- Кнопка: `plugins/navigation/app/Rail.tsx:135-145`, `RailButton label="Home"` вызывает `actions.goHome({ target })`. В раскладке Top list кнопки Home нет; её роль выполняет строка «Back to app» и команда `app.back` (`apps/app/src/lib/app-command-metadata.ts:116`, `apps/app/src/components/layout/BackToAppCommandHandler.tsx:7`).
- Действие: `apps/app/src/components/sidebar/SidebarNavigationModel.tsx:370-377`. При `target: "tab"` открывает экран нового треда во вкладке. Если `isHomeActive`, выходит без действий. Иначе переходит на `homeRoutePathRef.current`.
- Цель: там же, строки 248-258. `isHomeActive` истинно, когда путь не относится к настройкам, не является маршрутом панели плагина и активный пункт навигации пуст или равен «Новый тред». `homeRoutePathRef` запоминает последний такой маршрут, а до первого посещения равен экрану нового треда.
- Поверхность: все эти маршруты рисует `SplitWorkspaceRoute` (`apps/app/src/views/SplitWorkspaceRoute.tsx:36-49`): корневой путь даёт содержимое `new-thread`, маршрут треда даёт `thread`, маршрут панели плагина даёт `plugin-panel`.

Вывод: Home, корневой URL и «Новый тред» не тождественны. Home — это «последний маршрут списка тредов», корневой URL — экран нового треда, он же служит Home по умолчанию. Отдельной страницы Home, которую можно подменить, в хосте нет.

## Механизмы

| Механизм | Подтверждено | Решение |
|---|---|---|
| `homepageSection` | `app.d.ts:22576` `homepageSection(registration: PluginHomepageSectionRegistration): void`; регистрация `app.d.ts:19921` `{ id: string; title: string; component: ComponentType<PluginHomepageSectionProps> }`; пропсы `app.d.ts:19167` `{ projectId: string \| null }`. Хост: `apps/app/src/views/RootComposeSecondaryContent.tsx:128` передаёт секции в `RootComposeHome`; `apps/app/src/components/plugin/PluginHomepageSections.tsx:31` кладёт их в колонку `mt-6 space-y-6` с заголовком `h2` под композером. Секции добавляются, прежнее содержимое остаётся. Монтируется только на экране нового треда. | Не использовать как Home. Слот не даёт ни полной поверхности, ни замены, ни показа при возврате в тред. |
| `experimental_appOverlay` | `app.d.ts:22583` `experimental_appOverlay(registration: ExperimentalAppOverlayRegistration): void`; регистрация `app.d.ts:19951` `{ id: string; component: ComponentType<ExperimentalAppOverlayProps> }`; пропсы пустые (`app.d.ts:19201`). «The host mounts each registration once per app window… BB supplies no chrome, positioning, visibility, or interaction policy». Хост: `apps/app/src/components/plugin/PluginAppOverlays.tsx:31` (обёртка `className="contents"`), монтируется в `apps/app/src/components/layout/AppLayout.tsx:888` рядом с основной областью, вне маршрутов. | Для Home не использовать: overlay, накрывающий исходную страницу, заданием запрещён. Годится как постоянный родитель живых панелей одного окна (стабильные хосты), если их геометрию задаёт страница Чертога. Прямоугольник рабочей области хост не сообщает; его нужно измерять самим. |
| `navPanel` и страницы плагина | `app.d.ts:22590` `navPanel(registration: PluginNavPanelRegistration): void`; регистрация `app.d.ts:20038` `{ id; title; icon: BbIconName; path; component: ComponentType<PluginNavPanelProps>; experimental_sidebar?; experimental_usePageTitle?; … }`; пропсы `app.d.ts:19230` `{ subPath: string }`. Маршрут `/plugins/<pluginId>/<path>/*`, панель «owns its whole route». Хост: `apps/app/src/views/PluginPanelView.tsx:46-58`, контейнер `-m-4 flex min-h-0 flex-1 flex-col overflow-hidden` без собственных полей. Переход: `useBbNavigate().toPluginPanel(path, { subPath?, replace? })` (`app.d.ts:23882`). Панель может быть содержимым штатного split (`plugin-panel`). | Единственная публичная полноразмерная поверхность. Workspace Чертога живёт в `navPanel`. Не задавать `experimental_sidebar`: тогда левое дерево проектов и тредов остаётся на месте. Ограничение: `isHomeActive` на маршруте панели ложно, «Домой» с него уводит. |
| Настройка домашней поверхности | Нет. `UI_PREFERENCE_KEYS` (`app.d.ts:215`) содержит ключи `sidebar.*`, `composer.provider`, `threadContextCard.pinned`, `infoPanel.collapsedSections`; ключа Home нет. В upstream поиск `homeSurface`, `homeProvider`, `homepageProvider`, `"home.` по `apps/app/src` и `packages/plugin-sdk/src` пуст. Эксклюзивные слоты есть только для списка тредов и навигации (`experimental_threadList` `app.d.ts:22602`, `experimental_sidebarNavigation` `app.d.ts:22608`). | Пробел хоста. Замена навигации целиком ради своей кнопки Home не подходит: это другая навигация пользователя, а `app.back` и «Back to app» по-прежнему ведут на старый Home. |
| `ThreadChat` | `app.d.ts:24446` `ThreadChat: ComponentType<ThreadChatProps>`; `app.d.ts:23335`: `threadId: string` (обязателен), `variant?: "compact" \| "full" \| "timeline"`, `layout?: "contained" \| "document"` (по умолчанию `contained`: «fills and scrolls inside a bounded parent»), `focusRequest?: number`, `permissionPolicy?: "editable" \| "inherit"`, `className?`, `leadingContent?`, `messageActions?`. Образец: `plugins/side-chat/app.tsx:272-280` в upstream. | Использовать для тайлов тредов этапа A: `threadId` существующего треда, `layout="contained"`. Создание дочернего треда из Side Chat не копировать. Два `ThreadChat` в одном хосте и сохранение черновика, прокрутки и фокуса при перестройке: не проверено, проверяется на стенде. |
| `context.composer`, `experimental_useActiveComposer` | В 0.6.132 нет обоих. Есть `useComposer(): PluginComposerApi` (`app.d.ts:24160`) и `useComposers(): readonly PluginComposerApi[]` (`app.d.ts:24174`): все композеры на экране, включая композер `ThreadChat`; у каждого `scope` с `threadId`. В upstream: `composer: PluginComposerApi \| null` в контексте команды (`app-contract.ts:3674`), `experimental_useActiveComposer(): PluginComposerApi \| null` (`app-contract.ts:5973`). В установленном BB `experimental_useActiveComposer` отсутствует. | На установленном BB адресата команды определять по `useComposers()` и `scope.threadId` выбранного тайла, не по DOM и не по фокусу. Команды «текущему композеру» через `context.composer` включать только при SDK, где поле есть; при `null` команда недоступна. Маршрутизация клавиатуры между двумя `ThreadChat`: не проверено. |
| `useSidebarSplitLayout` | `app.d.ts:24336` `useSidebarSplitLayout(): PluginSidebarSplitLayout \| null`; `app.d.ts:21406`: `panes: readonly { paneId: string; rect: { x; y; width; height }; threadId: string \| null; isFocused: boolean }[]`, доли площади split. `null` при одной панели, compact viewport и выключенных split. Хост: `apps/app/src/lib/plugin-split-layout.ts:13-43`, для содержимого не-треда `threadId` равен `null`. | Только чтение, для индикаторов. Это не setter дерева и не реестр экземпляров: тип и параметры панели плагина из него не восстановить. Раскладку Чертог хранит сам. Открыть тред в штатном split можно через `toThread(threadId, { split: true })` (`app.d.ts:23871`); на лимите панелей хост заменяет сфокусированную, поэтому вслепую не вызывать. |
| Storage API | Сервер: `sdk.d.ts:21683` `readonly storage: PluginStorage`; `sdk.d.ts:19824` `PluginKvStorage { get<T>(key): Promise<T \| undefined>; set(key, value): Promise<void>; delete(key): Promise<void>; list(prefix?): Promise<string[]> }`, значения до 256 КБ в `bb.db`; `sdk.d.ts:19843` `database(): Database.Database` — собственный `data.db` плагина с помощником миграций. Фронтенд: прямого storage нет; есть `useRpc()` (`app.d.ts:24070`), `useSettings()` (`app.d.ts:24079`, только чтение несекретных значений), `experimental_usePluginId()` (`app.d.ts:24114`) для ключей `localStorage`. | Именованные раскладки хранить на сервере плагина в `bb.storage.kv` с версией схемы, доступ из UI через RPC. `localStorage` только для состояния одного окна, которое не жалко потерять. Под ключи BB не писать. Конфликт двух окон при сохранении: не проверено. |

## Вывод для этапа A

**Публичный способ.** Чертог регистрирует `navPanel` без `experimental_sidebar` и рисует в ней workspace на всю область маршрута. Треды показывает через `ThreadChat` с явным `threadId` и `layout="contained"`. Раскладки хранит через свой RPC в `bb.storage.kv`. Этого достаточно для всех пунктов этапа A, кроме входа через штатный «Домой».

**Чего этот способ не даёт.**

- «Домой» с маршрута Чертога уводит на последний тред или экран нового треда, потому что маршрут панели не считается Home.
- Из треда «Домой» ничего не делает: `isHomeActive` уже истинно.
- Пользователь попадает в Чертог через отдельный пункт навигации. Задание это прямо исключает («не открывает отдельную страницу плагина», «второй пункт „Домой“ не считается заменой»).

Обходы без изменения хоста отклонены: перенаправление с экрана нового треда из `homepageSection` или overlay ломает команду нового треда и историю навигации; overlay поверх Home запрещён заданием; замена навигации меняет чужую поверхность и не затрагивает `app.back`.

## Пробел хоста

**Минимальное воспроизведение на штатном BB** (по коду upstream; на запущенном BB не проверено):

1. Включить плагин с одной `navPanel` (`path: "home"`) и одной `homepageSection`.
2. Открыть любой тред и нажать «Домой» в Rail. Ожидается страница плагина. Фактически ничего не происходит (`SidebarNavigationModel.tsx:376`).
3. Открыть Settings и нажать «Домой». Фактически открывается прежний тред или экран нового треда (`SidebarNavigationModel.tsx:377`). Секция плагина видна только под композером нового треда.
4. Открыть панель плагина. Кнопка «Домой» не подсвечена (`isHomeActive` ложно); нажатие уводит с панели.

**Ожидаемая семантика.**

- Плагин объявляет одну из своих `navPanel` домашней поверхностью. Объявление эксклюзивно, как у `experimental_threadList` и `experimental_sidebarNavigation`: по умолчанию активен первый сторонний поставщик, пользователь может закрепить штатный Home в настройках.
- Пока поставщик активен, `goHome()` без `target` и с `target: "current"` ведёт на маршрут этой панели из любого раздела, включая тред. `isHomeActive` истинно только на этом маршруте. `app.back` и «Back to app» ведут туда же.
- `goHome({ target: "tab" })`, команда нового треда, корневой URL, прямые ссылки на треды, восстановление треда при старте и история назад/вперёд не меняются.
- Плагин выключен, удалён, упал или панель не зарегистрирована: поведение в точности прежнее, без перезагрузки окна. Сохранённый выбор не стирается.

**Узкий патч хоста, отдельно от плагина.** В объёме этого среза не вносился; правки хоста требуют отдельного разрешения владельца.

- SDK: необязательное поле `experimental_home?: boolean` в `PluginNavPanelRegistration` (аддитивно, прежние плагины не затронуты).
- Настройка: ключ `home.provider` в `UI_PREFERENCE_KEYS` со значением по умолчанию, равным штатному Home; выбор в Settings → Appearance по образцу `sidebar.navigationProvider` (`apps/app/src/components/sidebar/sidebarNavigationProvider.ts:124`).
- Хост: одно место, `SidebarNavigationModel.tsx:248-258` и `:370-377`. При активном поставщике цель `goHome` — маршрут его панели, а `isHomeActive` сравнивается с этим маршрутом. Тот же путь передаётся в `BackToAppCommandHandler`.
- Тесты хоста: поставщика нет — прежние ожидания без изменений; поставщик есть — `goHome` из треда и из Settings ведёт на панель; `target: "tab"` открывает экран нового треда; после выключения плагина возвращается прежняя цель; закреплённый отсутствующий поставщик даёт штатный Home.

Патч не трогает split, overlay, композеры и хранилище. Плагин не импортирует приватные модули хоста.

## Не проверено

- Поведение на запущенном BB: ни один сценарий не выполнялся в интерфейсе; всё выше — чтение типов, исходников upstream и поиск строк в установленной сборке.
- Соответствие установленной сборки конкретному коммиту upstream; наличие в ней PR #7960, #7971, #7878, #7803 (кроме отсутствия `experimental_useActiveComposer`).
- `context.composer` в установленном BB.
- Наличие SDK 0.6.157 и 0.6.178 в npm; новые релевантные PR после 21.11.2026 и статус PR #7801.
- Два `ThreadChat` в одном хосте: независимость черновиков, прокрутки, фокуса, адресата команд; поведение при перестройке раскладки и переходе `1 → 2 → 1`.
- Сохранение состояния `navPanel` при уходе с маршрута и возврате (перемонтирование компонента панели).
- Измерение рабочего прямоугольника из overlay и порядок слоёв относительно палитры, диалогов и sidebar.
- Поведение `navPanel` в compact viewport и на лимите восьми панелей split.
- Конкурентная запись раскладок из двух окон в `bb.storage.kv`.
- Пункты 2 и 3 раздела 2 задания для остальных поверхностей (браузер, терминал, Telegram, Zoom, Remote Hub): вне этого среза.
