# S0. Каркас плагина

## Цель

Пустой, но собираемый и устанавливаемый плагин `makosh-commander` на каркасе
Makosh, с архитектурным тестом слоёв. Функциональности нет.

## Принятые пути

`plugins/commander/`: `package.json`, `package-lock.json`, `tsconfig.json`,
`vitest.config.ts`, `tests/architecture.test.ts`, `components/**`, `lib/**`,
`hooks/**`, `assets/icon.svg`, `PLUGIN_OVERVIEW.md`, `README.md`,
`CHANGELOG.md`, `.gitignore`, а также временные заглушки `server.ts`,
`app.tsx`, `host.ts` (дальше ими владеет S7/S8).
Корень репозитория: запись `commander` в `.bb/plugins.json` и в
`marketplace.json`.

Не трогать: `research/**`, `docs/**`.

## Контракт

- `package.json`: `name: "bb-plugin-makosh-commander"`, `version: "0.1.0"`,
  `private: true`, `type: "module"`,
  `engines: {bb: ">=0.50", bbPluginSdk: ">=0.6.132"}`,
  `bb: {name: "Makosh Commander [Experimental]", description, branding: {icon: "./assets/icon.svg"}, server: "./server.ts", app: "./app.tsx", host: "./host.ts", skills: ["skills"]}`,
  `scripts` как в `plugins/mail` (`build`, `typecheck`, `test`, `check`).
  `dependencies`: `zod` (та же мажорная версия, что в mail). `devDependencies`:
  `@get-bb/plugin-sdk` `0.6.132`, `@types/node`, `@types/react`,
  `@types/react-dom`, `typescript`, `vitest`, `jsdom`,
  `@testing-library/react`, `@testing-library/dom`, `better-sqlite3` и его
  типы (для тестов S6), ровно те `@radix-ui/*`, которые нужны вендоренным
  компонентам.
- `bb.description` = первая строка `PLUGIN_OVERVIEW.md` = описание в
  `marketplace.json`: «Two-pane file manager for local folders and BB hosts
  (SFTP via Remote Hub in progress). Experimental.» — только текущее
  поведение.
- `tsconfig.json`, `vitest.config.ts` — по образцу `plugins/mail`
  (alias `@/`), `include` дополнен `host.ts`.
- `tests/architecture.test.ts` — копия из `plugins/mail` с теми же слоями
  (core: `zod`; ui: `react`, `@/components`, `@/lib`, `@/hooks`, core).
- `components/ui/*`: вендоренные из `plugins/mail/components/ui` только
  `button`, `input`, `dialog`, `select`, `checkbox`, `icon`, `card` и их
  зависимости из `lib/`, `hooks/` (как есть, без правок).
- Заглушки: `server.ts` — `export default function activate(bb: BbPluginApi) {}`;
  `app.tsx` — `definePluginApp` с `slots.navPanel({id: "commander", path:
  "commander", title: "Commander", icon: "Folders", component})`, компонент
  рисует «Commander — в разработке»; `host.ts` — `experimental_defineHostEntry`
  с пустым контрактом `defineRpcContract({})` (если тип требует хотя бы
  один метод — `ping: () => "pong"`).
- `.gitignore`: `node_modules/`, `dist/`, `research/upstream/`,
  `research/spikes/**/node_modules/`, `research/spikes/**/target/`.

## Проверки

1. `npm install` (без `--ignore-scripts` только для better-sqlite3, как в
   mail), `npm run check` — зелёный, есть хотя бы архитектурный тест.
2. Негативный контроль архитектурного теста: временно добавить
   `import "node:fs"` в `src/core/x.ts` → тест падает; убрать.
3. `npm run build` — создаёт `dist/server.js`, `dist/app.js`, `dist/host.js`.
4. `node ../../scripts/check-manifests.mjs` — `manifests ok`.
5. `research/` не попадает в сборку.

## Ожидаемый diff

~15–25 новых файлов в `plugins/commander`, по одной строке/записи в
`.bb/plugins.json` и `marketplace.json`. Ни одного изменения в других
плагинах.
