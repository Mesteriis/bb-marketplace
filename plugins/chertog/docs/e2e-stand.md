# Чертог: стенд сквозной проверки

Проверено 21.11.2026 на `HEAD` `4180a25a15916aa8320ba26092ed710c12c66c8a`, BB 0.50.1 (`/Applications/dev/bb.app`), Node 24.20.0, macOS на Apple Silicon. Относится к разделу 5 [spec.md](spec.md): «Установи и открой плагин в изолированной тестовой сборке этого checkout» и «один автоматический сквозной маршрут через реальные UI-действия».

## Вывод

Второй экземпляр BB поднимается штатно и не трогает рабочую установку. Это веб-стенд: сервер BB, host daemon и веб-интерфейс на своих портах, со своим каталогом данных. Чертог из этого checkout на нём установлен, загружен и отдан странице в headless-браузере. Экземпляр остановлен, в рабочем BB ничего не изменилось.

Изолированного Desktop-стенда нет. Строки приёмки про нативный браузер, окна и мониторы на веб-стенде не проверяются; для них нужно решение владельца (раздел «Чем веб-стенд отличается от Desktop»).

На `4180a25a` `app.tsx` не заполняет ни одного слота, поэтому «загружен» сейчас значит: сервер показывает `chertog@0.1.0 running`, а страница запросила его бандл и получила `200`. Интерфейса Чертога, который можно было бы открыть и двигать мышью, в этом коммите ещё нет.

## Как устроена изоляция

Запуск повторяет `scripts/smoke-boot.mjs` из пакета `bb-app`, которым upstream проверяет свою сборку: `bb-app --data-dir <каталог> --server-port <порт> --host-daemon-port <порт> --bundled`. Сверх него стенд делает четыре вещи, каждая закрывает наблюдавшийся путь к рабочей установке.

| Мера | Зачем | На чём основано |
|---|---|---|
| `env -i` для лаунчера и для каждой команды `bb` | В треде BB заданы `BB_SERVER_URL=http://127.0.0.1:38886`, `BB_HOST_DAEMON_PORT`, `BB_CLI`, `BB_THREAD_ID`. CLI без своего `BB_SERVER_URL` обращается к рабочему серверу: `bb plugin install` поставил бы плагин владельцу. | `bb guide`: «Outside a thread the CLI targets http://127.0.0.1:38886; set BB_SERVER_URL (and BB_HOST_DAEMON_PORT) only for a deliberate non-default target» |
| Отдельный `HOME` внутри стенда | Одного `--data-dir` мало. Провайдеры стенда пишут в домашний каталог, а `bb plugin build` кладёт туда набор сборки. | После прогона в `HOME` стенда появились `.claude/`, `.claude.json`, `.codex/`, `.cursor/`, `.hermes/`, `.local/state/`, `Library/Caches/`, `.bb/plugins/toolchain-0.28.2-4.3.0-4.3.0-4.3.0/`, `.npm/` |
| Свободные порты, выбранные перед запуском | Рабочий BB занимает 38886 и 38887. | `bb status`, `BB_HOST_DAEMON_PORT` в окружении треда |
| Копия плагина из `git archive HEAD:plugins/chertog` | Установка по локальному пути регистрирует каталог на месте, а сборка пишет в него `node_modules/` и `dist/`. Копия оставляет worktree чистым и фиксирует, какой коммит проверен. | `quickstart.md` навыка `bb-plugin-authoring`: «registers the directory in place» |

`--bundled` и `--no-in-app-updates` запускают именно установленный пакет и выключают обновление приложения. `BB_SKIP_ONBOARDING=true` пропускает экран первой настройки, `BB_TELEMETRY=false` отключает телеметрию.

## Запуск

Нужны: `git`, `node`, `npm`, `curl`, доступ к `registry.npmjs.org` (зависимости плагина, набор сборки BB, `playwright-core`) и `chrome-headless-shell` в `~/Library/Caches/ms-playwright` (на этой машине есть сборка 1248; из рабочего `HOME` она только читается).

Скрипты лежат вне репозитория. Сохрани три файла ниже в один каталог, например `$TMPDIR/chertog-stand-scripts`, и выполни из корня checkout:

```sh
S="$TMPDIR/chertog-stand"
P="$TMPDIR/chertog-stand-scripts"
"$P/prepare.sh" "$PWD" "$S"                       # копия плагина, npm ci, bb plugin build
(mkdir -p "$S/tools" && cd "$S/tools" && npm init -y >/dev/null \
  && npm_config_cache="$S/home/.npm" npm i --no-audit --no-fund playwright-core)
"$P/run.sh" "$S"                                  # запуск, установка, проба, остановка
```

`prepare.sh`:

```sh
#!/bin/sh
# Snapshot plugins/chertog at HEAD into the stand, install deps, build.
set -eu
REPO="$1"; STAND="$2"
BB_APP=/Applications/dev/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app
rm -rf "$STAND"; mkdir -p "$STAND/plugin" "$STAND/home" "$STAND/data"
git -C "$REPO" archive HEAD:plugins/chertog | tar -x -C "$STAND/plugin"
git -C "$REPO" rev-parse HEAD > "$STAND/plugin-sha"
cd "$STAND/plugin"
# Clean environment: no BB_* of the owner's BB, throwaway HOME, proxies kept.
clean() {
  env -i HOME="$STAND/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    ${HTTP_PROXY:+HTTP_PROXY="$HTTP_PROXY"} ${HTTPS_PROXY:+HTTPS_PROXY="$HTTPS_PROXY"} \
    ${http_proxy:+http_proxy="$http_proxy"} ${https_proxy:+https_proxy="$https_proxy"} \
    ${NO_PROXY:+NO_PROXY="$NO_PROXY"} ${no_proxy:+no_proxy="$no_proxy"} \
    ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS"} \
    npm_config_cache="$STAND/home/.npm" "$@"
}
clean npm ci --no-audit --no-fund
clean node "$BB_APP/dist/bb.js" plugin build
ls -la dist
```

`run.sh`:

```sh
#!/bin/sh
# Start an isolated BB, install the stand copy of Chertog, record the load, probe the web UI, stop.
set -eu
STAND="$1"
BB_APP=/Applications/dev/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app
CHROME=$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell | tail -1)
PORTS=$(node -e 'const n=require("node:net");const f=()=>new Promise(r=>{const s=n.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>r(p))})});(async()=>console.log(await f(),await f()))()')
SERVER_PORT=${PORTS% *}; DAEMON_PORT=${PORTS#* }
URL="http://127.0.0.1:$SERVER_PORT"
cli() {
  env -i HOME="$STAND/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" BB_TELEMETRY=false \
    BB_DATA_DIR="$STAND/data" BB_SERVER_URL="$URL" BB_HOST_DAEMON_PORT="$DAEMON_PORT" \
    node "$BB_APP/dist/bb.js" "$@"
}
# env execs node, so $! is the launcher itself; SIGTERM to it stops server and host daemon.
env -i HOME="$STAND/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  BB_TELEMETRY=false BB_SKIP_ONBOARDING=true NODE_ENV=production \
  node "$BB_APP/dist/bb-app.js" --data-dir "$STAND/data" \
  --server-port "$SERVER_PORT" --host-daemon-port "$DAEMON_PORT" \
  --bundled --no-in-app-updates > "$STAND/bb-app.log" 2>&1 &
LAUNCHER=$!
stop() {
  kill -TERM "$LAUNCHER" 2>/dev/null || true
  i=0; while kill -0 "$LAUNCHER" 2>/dev/null && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done
  if kill -0 "$LAUNCHER" 2>/dev/null; then kill -KILL "$LAUNCHER"; fi
}
trap stop EXIT
i=0; until curl -fsS --max-time 2 "$URL/health" >/dev/null 2>&1; do
  kill -0 "$LAUNCHER" 2>/dev/null || { echo "bb-app exited early"; cat "$STAND/bb-app.log"; exit 1; }
  i=$((i+1)); [ $i -gt 240 ] && { echo "health timeout"; cat "$STAND/bb-app.log"; exit 1; }
  sleep 0.5
done
echo "== launcher pid $LAUNCHER, server $URL, host daemon port $DAEMON_PORT"
echo "== health"; curl -fsS "$URL/health"; echo
echo "== status"; cli status
echo "== install"; cli plugin install "$STAND/plugin" --yes
echo "== chertog in plugin list"
cli plugin list --json > "$STAND/plugin-list.json"
node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).plugins??[];const p=l.find(x=>x.id==="chertog");console.log(JSON.stringify({plugins:l.length,id:p?.id,version:p?.version,status:p?.status,source:p?.source,sdkVersion:p?.app?.bundle?.sdkVersion,compatible:p?.app?.bundle?.compatible,jsUrl:p?.app?.bundle?.jsUrl}));process.exit(p?.status==="running"?0:1)' "$STAND/plugin-list.json"
JS=$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).plugins;console.log(l.find(x=>x.id==="chertog").app.bundle.jsUrl)' "$STAND/plugin-list.json")
echo "== plugin bundle over HTTP"; curl -fsS -o /dev/null -w "GET $JS -> %{http_code} %{size_download} bytes\n" "$URL$JS"
echo "== headless probe"
node "$(dirname "$0")/probe.mjs" "$URL/" "$STAND/tools" "$CHROME" "$STAND/probe.png" "$JS" || echo "probe failed: exit $?"
if [ -n "${STAND_HOLD:-}" ]; then echo "holding at $URL; touch $STAND/stop to finish"; while [ ! -e "$STAND/stop" ]; do sleep 1; done; fi
stop; trap - EXIT
echo "== after stop"
if curl -fsS --max-time 2 "$URL/health" >/dev/null 2>&1; then echo "server still answers"; exit 1; fi
echo "server stopped: $URL/health refuses connections"
```

`probe.mjs`:

```js
// Headless probe of the stand web UI: load, plugin bundle request, DOM rects, trusted mouse gesture.
import { createRequire } from "node:module";
const [url, toolsDir, chrome, shot, chertogJs] = process.argv.slice(2);
const { chromium } = createRequire(toolsDir + "/")("playwright-core");
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const assets = [];
page.on("response", (r) => { if (r.url().includes("/plugin-app-assets/")) assets.push(`${r.status()} ${new URL(r.url()).pathname}`); });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector("#root, #app, main")?.childElementCount > 0, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);
await page.evaluate(() => {
  window.__probe = [];
  for (const t of ["pointerdown", "pointermove", "pointerup"])
    window.addEventListener(t, (e) => window.__probe.push({ type: e.type, trusted: e.isTrusted, x: e.clientX, y: e.clientY }), true);
});
await page.mouse.move(700, 450); await page.mouse.down();
await page.mouse.move(820, 520, { steps: 4 }); await page.mouse.up();
const out = await page.evaluate(() => ({
  title: document.title, path: location.pathname,
  viewport: [innerWidth, innerHeight],
  landmarks: [...document.querySelectorAll("nav, aside, main, [role=main], [role=navigation]")].slice(0, 6).map((el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), rect: [r.left, r.top, r.right, r.bottom].map(Math.round) };
  }),
  pointer: { events: window.__probe.length, allTrusted: window.__probe.every((e) => e.trusted), first: window.__probe[0], last: window.__probe.at(-1) },
  text: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
}));
await page.screenshot({ path: shot });
console.log(JSON.stringify({ ...out, pluginAppAssetResponses: assets.length, chertogBundle: assets.find((a) => a.endsWith(chertogJs)) ?? "not requested", pageErrors: errors }, null, 1));
await browser.close();
```

Чтобы оставить стенд работать для ручного или автоматического прохода, запусти `STAND_HOLD=1 "$P/run.sh" "$S"`: скрипт напечатает адрес и будет ждать файл `$S/stop`. Этот режим в данном срезе не запускался.

## Остановка

`run.sh` останавливает экземпляр сам, в том числе при ошибке (`trap stop EXIT`): `kill -TERM` лаунчеру, ожидание до 30 секунд, затем `kill -KILL`. Лаунчер по `SIGTERM` завершает сервер и host daemon. После остановки скрипт проверяет, что `/health` больше не отвечает.

Остановить экземпляр, оставленный в режиме `STAND_HOLD`:

```sh
touch "$TMPDIR/chertog-stand/stop"
```

Остановить вручную, если скрипт был прерван:

```sh
ps -axo pid,ppid,command | grep -F "chertog-stand/data" | grep -v grep   # строка с dist/bb-app.js
kill -TERM <pid лаунчера>
```

Удалить стенд целиком после остановки: `rm -rf "$TMPDIR/chertog-stand"`. В рабочем BB убирать нечего.

Сигнал нужно слать самому процессу `bb-app.js`. В первом прогоне лаунчер был запущен через функцию оболочки, `$!` указывал на подоболочку, и `SIGTERM` сервер не остановил; в `run.sh` выше лаунчер запускается прямо через `env`, который заменяет себя на `node`. Команда `bb-app stop --data-dir <каталог>` существует, но в песочнице команд агента она не видит чужие процессы и ответила «bb was not running (removed a stale record of pid …)» при живом сервере. Вне песочницы она не проверялась.

## Что проверено фактически

Два полных прогона `run.sh` на пустом каталоге данных: первый внутри песочницы команд агента (запись разрешена только в `$TMPDIR` и worktree), второй вне её, потому что Chromium в песочнице не стартует. `S` во втором прогоне: `/tmp/claude-501/chertog-stand`.

Подготовка (`prepare.sh`):

```text
Downloading the plugin build toolchain (one time)…
  esbuild@0.28.2, @tailwindcss/node@4.3.0, @tailwindcss/oxide@4.3.0, tailwindcss@4.3.0
Toolchain ready (2.0s)
dist/server.js
dist/server.js.map
dist/server.meta.json
dist/app.js
dist/app.css
dist/app.meta.json
```

Запуск, установка, загрузка и остановка (`run.sh`, второй прогон):

```text
== launcher pid 49577, server http://127.0.0.1:60837, host daemon port 60838
== health
{"ok":true,"launchId":"03780ed4-de35-4c43-a617-89e38875519d"}
== status
Project: (not set)

Thread: (not set)

Data dir: /tmp/claude-501/chertog-stand/data

Tip: run bb guide for help getting started.
== install
Installing bb-plugin-chertog@0.1.0 from /tmp/claude-501/chertog-stand/plugin
Plugins are full-trust code running inside the BB server. They can read all local BB data, including other plugins' secrets.
Installed:
chertog@0.1.0  running
  source: path:/tmp/claude-501/chertog-stand/plugin
== chertog in plugin list
{"plugins":42,"id":"chertog","version":"0.1.0","status":"running","source":"path:/tmp/claude-501/chertog-stand/plugin","sdkVersion":"0.6.157","compatible":true,"jsUrl":"/api/v1/plugin-app-assets/653524671c361b63/app.js"}
== plugin bundle over HTTP
GET /api/v1/plugin-app-assets/653524671c361b63/app.js -> 200 3381 bytes
== after stop
server stopped: http://127.0.0.1:60837/health refuses connections
```

Проба в headless Chromium (`probe.mjs`, `playwright-core` 1.65.1, окно 1440×900), вывод сокращён до значимых полей:

```text
"title": "bb", "path": "/", "viewport": [1440, 900]
"landmarks": nav [0, 0, 48, 853]; main [320, 0, 1440, 900]
"pointer": { "events": 7, "allTrusted": true, first pointermove (700, 450), last pointerup (820, 520) }
"text": "New thread Threads No threads Mobile apps Provider usage Report a bug More Select model No project Full Access Toggle Sidebar"
"pluginAppAssetResponses": 52
"chertogBundle": "200 /api/v1/plugin-app-assets/653524671c361b63/app.js"
"pageErrors": []
```

Что из этого следует:

| Факт | Доказательство |
|---|---|
| Стенд работает на своих данных | `bb status` стенда: `Data dir: /tmp/claude-501/chertog-stand/data`; в нём свои `bb.db`, `host-id`, `auth-secret`, `plugins/`, `logs/` |
| Чертог из этого checkout загружен сервером | `chertog@0.1.0  running`, источник `path:…/chertog-stand/plugin`, SDK бандла `0.6.157`, `compatible: true` |
| Веб-интерфейс открывается без входа и грузит бандл Чертога | страница `/` отрисовала оболочку BB, ответ `200` на `app.js` Чертога, ошибок страницы нет |
| Жесты мышью настоящие | семь событий `pointermove`/`pointerdown`/`pointerup` с `isTrusted: true` от `page.mouse` |
| Границы DOM измеримы | `getBoundingClientRect()` в координатах окна: область содержимого `main` занимает `[320, 0, 1440, 900]` |
| Экземпляр остановлен | `/health` стенда отказывает в соединении; в `ps` нет процессов с `chertog-stand` |
| Рабочий BB не изменён | `bb plugin list` рабочего сервера до и после: 127 плагинов, `chertog` нет; в `~/.bb/plugins` нет каталога `chertog`; `http://127.0.0.1:38886/health` отвечает с тем же `launchId` |
| В песочнице стенд не пытался писать наружу | в логах первого прогона одна ошибка `EPERM`: провайдер `pi` не смог открыть сокет в `$TMPDIR` (ограничение песочницы, не стенда) |

Особенности для агента в песочнице команд: запуск и остановка должны быть в одной команде, потому что следующая команда не видит и не может остановить процессы предыдущей; Chromium падает на `bootstrap_check_in … Permission denied`, для пробы нужен запуск вне песочницы.

## Чем делать жесты и измерять

Проверено: `playwright-core` с готовым `chrome-headless-shell`.

- Мышь: `page.mouse.move/down/up` с `steps` для промежуточных точек. Состояние «во время удержания» из строки про покрытие снимается между `down` и `up`.
- Клавиатура: `page.keyboard.press` для Tab, Escape и сочетаний.
- Геометрия: `getBoundingClientRect()` всех тайлов и разделителей за один `page.evaluate`, чтобы координаты были из одного кадра; округление задаёт тест.
- Ширина окна и compact: `page.setViewportSize`.
- iframe-панель: `page.frames()` и `frame.evaluate` для boot ID; тождественность узла проверяется ссылкой, сохранённой в `window` страницы до жеста.
- Перезагрузка Home: `page.reload()`. Рестарт сервера: остановка и повторный запуск лаунчера на том же `--data-dir`.
- Выключение плагина: `bb plugin disable chertog` с окружением стенда (функция `cli` в `run.sh`).

Не опробовано: `bb browser-automation` (сессии принадлежат треду рабочего BB и создаются в его данных), Playwright MCP, `agent-browser`, `cua_*` для окон Desktop.

Сквозного теста в пакете плагина пока нет. Чтобы маршрут запускался одной командой из `plugins/chertog`, нужны `playwright-core` в `devDependencies` и каталог с тестом; это отдельный срез, здесь код плагина не менялся.

## Чем веб-стенд отличается от Desktop

| Свойство | Веб-стенд | Desktop |
|---|---|---|
| Поверхность | `bb-app-runtime.json` стенда: `"surface": "web"`; страница в Chromium | Electron, окна приложения |
| Нативный браузер | нет: `desktop-browser-view`, WebContents ID, выгрузка скрытых вкладок, `attach`/`detach` существуют только в Desktop | есть |
| Окна и мониторы | «окно» — вкладка или контекст браузера; дисплеев, рабочей области и масштаба нет | есть |
| Каналы `BB_DESKTOP_*`, меню приложения | нет | есть |
| Сервер, host daemon, плагины, split-панели, `ThreadChat`, iframe, терминал через host daemon | тот же код `bb-app` 0.50.1 | тот же |
| Провайдеры агентов | установлены, но без входа: `HOME` пустой | вход владельца |
| Плагины | 42 встроенных и Чертог | 127 у владельца, включая Telegram, Meetings, Remote Hub |

Почему нет изолированного Desktop-стенда. В `app.asar` установленного Desktop `runDesktopApp` начинается с `app.requestSingleInstanceLock()`; второй запуск при работающем BB завершается, а первый получает `second-instance` и выводит вперёд своё окно либо открывает новое. Флага каталога данных или профиля для Desktop в `bb --help` и `bb guide` нет, среди переменных `BB_DESKTOP_*` бандла такой тоже нет, строк `user-data-dir` и `setPath` в бандле нет. `BB_DATA_DIR` в бандле встречается; отделяет ли он блокировку единственного экземпляра и профиль Electron, не установлено. Запуск второго Desktop не пробовался: любой вариант затрагивает работающий BB владельца или требует его решения.

Варианты для владельца, ни один не проверен:

1. Закрыть рабочий BB на время прогона и запустить Desktop с отдельным `HOME`. Рабочие треды на это время останавливаются.
2. Отдельная учётная запись macOS со своей копией BB.
3. Сборка Desktop из checkout `get-bb/bb`: неупакованное приложение называется `bb-dev`. Даёт ли это отдельную блокировку и данные, не установлено.

## Строки приёмки

Строки взяты из таблицы раздела 5 [spec.md](spec.md). «Веб-стенд» значит стенд из этого документа с Playwright. Оценка «проверяема» относится к возможностям стенда: сами строки не пройдены, интерфейса Чертога в `4180a25a` нет.

| Строка приёмки | Стенд | Что нужно от владельца |
|---|---|---|
| Штатный Home | Веб-стенд: переход «Домой» из треда, уход и возврат, `page.reload()`, `bb plugin disable chertog` на стенде, прямой адрес треда. Политика старта Desktop (восстановление треда при запуске приложения) на вебе не видна. | Для веб-части ничего. Для старта Desktop: Desktop-стенд. |
| Полное покрытие и реальные жесты мышью | Веб-стенд полностью: `page.mouse`, `getBoundingClientRect`, `setViewportSize`, перетаскивание границы sidebar. | Ничего. |
| Два реальных BB-треда | Веб-стенд частично: черновики, Tab, клик, палитра, поздний mount, maximize, два `ThreadChat`. Подтверждение ID получателя требует отправки, а у провайдеров стенда нет входа. | Разрешить один из путей: тестовый вход провайдера в `HOME` стенда, либо агент-заглушка через встроенный `provider-acp` (не проверено, что он настраивается без входа). |
| Лимит и компактный экран | Веб-стенд: восемь панелей и девятая, compact через `setViewportSize`. Нужны проект и треды на стенде; проект создаётся из временного git-репозитория (не опробовано). | Ничего, если треды создаются без входа провайдера; иначе то же, что в строке выше. |
| Живая iframe-панель | Веб-стенд полностью: boot ID, тождественность узла, текст и caret, счётчик загрузок через `frame.evaluate`. | Ничего. |
| Браузер и Zoom | Только Desktop: выгрузка вкладок и WebContents ID есть лишь в нативном backend. Zoom требует реальной встречи и второго клиента. | Desktop-стенд (один из трёх вариантов выше); тестовая учётная запись и встреча Zoom; второй участник, который подтвердит звук и одно участие; разрешение на камеру и микрофон. |
| Telegram | Веб-стенд, если на него поставить плагин Telegram из checkout и войти тестовым аккаунтом. Не проверено, работает ли плагин без Desktop. | Тестовый аккаунт Telegram с двумя тестовыми чатами; разрешение установить плагин в стенд и выполнить вход; второй аккаунт для входящего сообщения. |
| BB-терминал и Remote Hub | BB-терминал: веб-стенд, PTY создаёт host daemon стенда (не опробовано). Remote Hub: веб-стенд с установленным плагином и тестовыми целями. | Тестовая SSH-машина и RDP-цель с учётными данными только для стенда (подойдёт локальный контейнер с sshd); разрешение установить Remote Hub в стенд. |
| Окна и хранилище | Хранилище на веб-стенде: две именованные схемы после рестарта лаунчера, конфликт двух окон как двух контекстов браузера, недоступный поставщик через `bb plugin disable`. Второй дисплей, отключение дисплея, передача между окнами: только Desktop. | Для хранилища ничего. Для окон: Desktop-стенд и физический второй дисплей, который можно отключать. |
| Освобождение и деградация | Веб-стенд частично: число iframe, хостов и подписок, PTY через `bb terminal`, `disable`/`reload` поставщика, падение renderer через закрытие или сбой страницы. Число WebContents и нативная выгрузка: только Desktop. | Для веб-части ничего. Для WebContents: Desktop-стенд. |

## Не проверено

- Изолированный Desktop: не запускался. Поведение второго экземпляра выведено из чтения `app.asar`, не из запуска.
- Ни одна строка приёмки раздела 5 не пройдена. Проверены только возможности стенда: загрузка плагина, открытие страницы, доверенные события мыши, измерение границ.
- Режим `STAND_HOLD` и остановка через файл `stop`.
- `bb-app stop --data-dir` вне песочницы команд.
- Создание проекта и тредов на стенде, отправка сообщения без входа провайдера, агент-заглушка через `provider-acp`.
- Терминал BB на стенде: создание PTY и вывод.
- Установка на стенд плагинов Telegram, Meetings и Remote Hub и их работа без Desktop.
- Какой backend у браузерной панели BB на вебе (iframe или её отсутствие).
- Работа стенда без сети после первой подготовки и на другой версии BB или Node.
- Что стенд ничего не пишет вне своих каталогов при запуске вне песочницы: это следует из `env -i` и отдельного `HOME`, а прямо наблюдалось только в прогоне внутри песочницы. Сравнение содержимого рабочего `~/.bb`, `~/.claude` и `~/.codex` до и после не делалось, потому что рабочий BB пишет туда постоянно.
- `bb browser-automation`, Playwright MCP, `agent-browser` и `cua_*` как средства прохода.
