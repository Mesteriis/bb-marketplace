# Чертог: версия SDK

Проверено 21.11.2026. Дополняет раздел «Расхождения версий» в [discovery-home.md](discovery-home.md) и закрывает его пункт «наличие версий в npm: не проверено».

## Решение

Пакет закреплён на `@get-bb/plugin-sdk` **0.6.157**: это самая новая опубликованная версия, не превышающая SDK установленного BB.

| Поле `package.json` | Было | Стало |
|---|---|---|
| `devDependencies["@get-bb/plugin-sdk"]` | `0.6.132` | `0.6.157` |
| `engines.bbPluginSdk` | `>=0.6.132` | `>=0.6.157` |
| `engines.bb` | `>=0.49` | `>=0.50.1` |

`package-lock.json` перегенерирован командой `npm install`; изменилась только запись SDK (версия, адрес архива, контрольная сумма) и `engines` корневого пакета.

## На чём основано

| Что | Значение | Откуда |
|---|---|---|
| Установленный BB | 0.50.1 | `bb --version` |
| SDK установленного BB | `PLUGIN_SDK_VERSION = "0.6.157"` | `/Applications/dev/bb.app/Contents/Resources/app.asar.unpacked/node_modules/@bb/domain/src/plugin-sdk-version.ts` |
| Версии SDK в npm от 0.6.132 | 0.6.132, 0.6.133, 0.6.136, 0.6.138, 0.6.140, 0.6.141, 0.6.142, 0.6.144, 0.6.146, 0.6.150, **0.6.157**, 0.6.164, 0.6.169 | `npm view @get-bb/plugin-sdk versions` |
| `latest` в npm | 0.6.169 | `npm view @get-bb/plugin-sdk dist-tags` |
| SDK 0.6.178 в npm | **не опубликован** | тот же список версий |
| Даты публикации | SDK 0.6.157: 18.11.2026 18:46 UTC; `bb-app` 0.50.0: 19:07 UTC; `bb-app` 0.50.1: 19:29 UTC того же дня | `npm view … time` |

`engines.bb` поставлен `>=0.50.1`, потому что SDK 0.6.157 подтверждён только в этой сборке. Какой SDK в `bb-app` 0.50.0, не проверено.

Версии 0.6.164 и 0.6.169 новее SDK установленного BB, поэтому не выбраны: плагин, собранный против них, мог бы обращаться к API, которых в запущенном BB нет.

## Контракты в закреплённой версии

Все строки относятся к `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts` версии 0.6.157 (25191 строка), дальше `app.d.ts`.

| Контракт | В 0.6.157 | Файл и строка |
|---|---|---|
| `context.composer` в контексте команд | **нет**. `PluginCommandContext` содержит только `threadId`, `projectId`, `experimental_panel` | `app.d.ts:22710` |
| `experimental_useActiveComposer` | **нет**: 0 вхождений во всех файлах `bundled-types` | — |
| `ThreadChat` | есть: `ThreadChat: ComponentType<ThreadChatProps>` в `PluginSdkApp`, экспорт `declare const ThreadChat` | `app.d.ts:24863`, `app.d.ts:25087` |
| `ThreadChatProps` | есть: `threadId`, `variant?: "compact" \| "full" \| "timeline"`, `layout?: "contained" \| "document"`, `focusRequest?: number`, `permissionPolicy?`, `className?`, `leadingContent?`, `messageActions?` | `app.d.ts:23752` |
| `navPanel` | есть: `navPanel(registration: PluginNavPanelRegistration): void` в `PluginAppSlots`; регистрация с `id`, `title`, `icon`, `path`, `component`, `experimental_sidebar?` | `app.d.ts:22995`, `app.d.ts:20379` |
| `experimental_appOverlay` | есть: `experimental_appOverlay(registration: ExperimentalAppOverlayRegistration): void`; регистрация с `id`, `component` | `app.d.ts:22988`, `app.d.ts:20292` |
| `useComposers` | есть: `useComposers(): readonly PluginComposerApi[]`, экспорт `declare const useComposers` | `app.d.ts:24591`, `app.d.ts:25136` |
| `useComposer` | есть: `useComposer(): PluginComposerApi` | `app.d.ts:24577`, `app.d.ts:25135` |
| `useSidebarSplitLayout` | есть: `useSidebarSplitLayout(): PluginSidebarSplitLayout \| null`, экспорт `declare const useSidebarSplitLayout` | `app.d.ts:24753`, `app.d.ts:25175` |
| `PluginSidebarSplitLayout` | `panes: readonly { paneId; rect: { x; y; width; height }; threadId: string \| null; isFocused }[]`; доли области split, `null` при одной панели, узком окне или выключенных split | `app.d.ts:21811` |
| `homepageSection` | есть | `app.d.ts:22981` |
| `goHome`, `isHomeActive` | есть | `app.d.ts:19811`, `app.d.ts:19847` |

Где в 0.6.157 встречается композер в контексте вызова, но не у команд палитры:

- `PluginMessageActionContext.composer: PluginComposerApi | null` (`app.d.ts:22687`): только действие над сообщением.
- `ExperimentalComposerCommandRegistration.run(context: { composer: PluginComposerApi })` (`app.d.ts:22779`): команда, зарегистрированная в самом композере.

Ожидание задания, что `context.composer` у команд появится в 0.6.157, не подтвердилось: по этому полю 0.6.157 не отличается от 0.6.132.

## Что остаётся недоступным до обновления BB до SDK 0.6.178

1. **`context.composer` у команд палитры и клавиатуры.** Нет в 0.6.157. Нет и в опубликованных 0.6.164 (`PluginCommandContext`, `app.d.ts:23296`) и 0.6.169 (`app.d.ts:23325`). По [discovery-home.md](discovery-home.md) поле есть в upstream 0.6.178 (`app-contract.ts:3674`, контекст команды `:3748`).
2. **`experimental_useActiveComposer`.** Нет в 0.6.157, 0.6.164 и 0.6.169 (0 вхождений в каждой). По discovery-home.md есть в upstream 0.6.178 (`app-contract.ts:5973`).
3. **Выбор домашней поверхности** (`experimental_home` или аналог). Нет в 0.6.157 и, по discovery-home.md, нет и в 0.6.178: это пробел хоста, обновление BB его не закрывает.

Следствие для Чертога: адресата команды определять через `useComposers()` и `scope.threadId` выбранного тайла, как записано в discovery-home.md. Команды «текущему композеру» через `context.composer` не включать, пока поле не появится в закреплённом SDK.

SDK 0.6.178 в npm нет, поэтому закрепить его нельзя даже после обновления BB, пока версию не опубликуют.

## Замечание к следующему повышению версии

В 0.6.169 `PluginCommandContext` наследует `ExperimentalPluginActionContext` (`app.d.ts:23251` в 0.6.169): поле панели называется `panel`, а `experimental_panel` в интерфейсе команды больше не объявлено. Код команд, читающий `context.experimental_panel`, при переходе на 0.6.169 и новее придётся поправить.

## Проверки

| Проверка | Результат |
|---|---|
| `npm run check` (typecheck и 20 тестов) | прошла |
| `npm run build` на BB 0.50.1 | прошла |
| `npm exec --package bb-app@0.49.0 --call 'npm run build'` (шаг CI, `BB_APP_VERSION` в `.github/workflows/ci.yml`) | прошла: CLI 0.49.0 собирает пакет с новым пином |
| `node ../../scripts/check-manifests.mjs` | прошла |

## Не проверено

- Загрузка собранного плагина в запущенный BB: установка в рабочий BB требует разрешения владельца.
- Наличие `context.composer` в установленной сборке BB во время выполнения: по минифицированной сборке не установить, в типах 0.6.157 поля нет.
- SDK в `bb-app` 0.50.0.
- Содержимое upstream 0.6.178 заново не читалось: сведения о нём взяты из discovery-home.md.
- `BB_APP_VERSION` в CI остаётся 0.49.0 при `engines.bb >=0.50.1`. Сборка проходит, но [docs/releasing.md](../../../docs/releasing.md) просит поднимать их вместе; файлы CI вне границ этой правки.
