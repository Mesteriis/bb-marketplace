# Воспроизведение проб S9

На исходном замере — Mac17,7, Apple Silicon arm64, 64 ГиБ RAM, APFS
(`/private/tmp` на томе Data), Node 24.20.0, rustc 1.97.0
(`2d8144b78 2026-07-07`). По одному измеренному проходу на операцию
и библиотеку. Это пиковая RSS процесса целиком. Кеш ФС не сбрасывался,
проходы записи и чтения выполнялись подряд, статистического разброса нет.
Для JS `maxRssKiB` в KiB, для Rust и `bsdtar` в байтах.
Пробный Rust-бинарник использует системный `getrusage` на macOS.

## Архивы, память и diff

Из корня репозитория, с Node, Cargo, Python 3 и системным bsdtar.
Понадобится около 11 ГиБ для временных архивов. Скрипты и lockfile
копируются в отдельный каталог, туда же устанавливаются зависимости
без lifecycle-скриптов. Зависимости Commander здесь не участвуют.

```sh
set -eu
s9_work=$(mktemp -d /private/tmp/commander-s9.XXXXXX)
cp -R plugins/commander/research/s9/. "$s9_work/"
cd "$s9_work"
mkdir fixtures
npm ci --cache .npm-cache --ignore-scripts --no-audit --no-fund
cargo build --locked --release --manifest-path rust/Cargo.toml
for format in tar zip; do
  node bench.mjs "$format" write "$s9_work/fixtures"
  node bench.mjs "$format" read "$s9_work/fixtures"
  rust/target/release/s9-archive-probe "$format" "$s9_work/fixtures/mass.$format"
  rust/target/release/s9-archive-probe "$format" "$s9_work/fixtures/rust.$format" write
  rust/target/release/s9-archive-probe "$format" "$s9_work/fixtures/rust.$format"
done
node bench.mjs compat test "$s9_work/fixtures"
for encryption in aes zipcrypto; do
  rust/target/release/s9-archive-probe compat "$s9_work/fixtures/$encryption.zip"
done
node bench.mjs diff test "$s9_work/fixtures"
python3 bsdtar-probe.py "$s9_work/fixtures"
bsdtar -tf "$s9_work/fixtures/mass.7z" | wc -l
bsdtar -xOf "$s9_work/fixtures/mass.7z" | wc -c
stat -f '%z %N' rust/target/release/s9-archive-probe
codesign -dv rust/target/release/s9-archive-probe
xattr rust/target/release/s9-archive-probe
```

Ожидаются 100 000 записей и 2 147 483 648 байт на каждом чтении
нагрузочного архива, 100 000 строк для листинга 7z. Строки записи JS
показывают время и RSS, размеры и число записей проверяются при чтении.
Скрипт bsdtar выводит коды возврата и останавливается при ошибке.
Измерение Rust использует локальный файл. Прокси `Read + Seek` по stdio
не участвовал в замерах.

## Редактор BB 0.50.1

Из корня репозитория. `s9_bb_app` — абсолютный путь к каталогу
`bb-app` версии 0.50.1 с `dist/bb-app.js` и `dist/bb.js`;
`s9_chrome` — путь к совместимому Chromium headless shell. Проверить
версию через `node -p 'require(process.argv[1]).version' "$s9_bb_app/package.json"`.
Commander должен иметь установленный SDK 0.6.132 в `node_modules`.
Остановить стенд можно созданием файла `done` или по тайм-ауту.
Снимок сохраняется рядом с логами стенда. Сборка пробы использует SDK из
копии локальных зависимостей, а стенд устанавливает только пакет пробы
в отдельный dataDir.

```sh
set -eu
s9_repo=$PWD
s9_source="$PWD/plugins/commander/research/s9"
s9_stand=$(mktemp -d /private/tmp/commander-s9-editor.XXXXXX)
mkdir -p "$s9_stand/home" "$s9_stand/data" "$s9_stand/plugin" "$s9_stand/probe"
cp "$s9_source/editor/"*.ts "$s9_source/editor/app.tsx" \
  "$s9_source/editor/package.json" "$s9_stand/plugin/"
cp "$s9_repo/plugins/commander/assets/icon.svg" "$s9_stand/plugin/icon.svg"
cp -R "$s9_repo/plugins/commander/node_modules" "$s9_stand/plugin/"
cp "$s9_source/package.json" "$s9_source/package-lock.json" "$s9_stand/probe/"
cp "$s9_source/editor/browser.mjs" "$s9_stand/probe/"
(cd "$s9_stand/probe" && npm ci --cache .npm-cache --ignore-scripts --no-audit --no-fund)
(cd "$s9_stand/plugin" && bb plugin build)
bash "$s9_source/editor/stand.sh" "$s9_stand" "$s9_bb_app" &
s9_launcher=$!
trap 'touch "$s9_stand/done"; wait "$s9_launcher" || true' EXIT
for attempt in $(seq 1 80); do
  if test -s "$s9_stand/url"; then break; fi
  kill -0 "$s9_launcher"
  sleep 1
done
test -s "$s9_stand/url"
node "$s9_stand/probe/browser.mjs" "$s9_stand" "$s9_chrome"
```

Пробный RPC работает только с одним синтетическим файлом под
`experimental_paths.dataDir`, без принимаемых от UI путей. Это проверка
стыка API. Привязка к заданиям, права и транзакционная запись — работа S16.
