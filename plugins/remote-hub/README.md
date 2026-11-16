# Remote Hub [Experimental]

Менеджер SSH/RDP-подключений для BB. Сейчас реализован этап 2a: один настоящий
SSH-сеанс во встроенном терминале (xterm.js), Rust-помощник с настоящими PTY и
проверенный IPC. Профили, учётные данные, RDP, agent tools и CLI — следующие
этапы.

## Что работает на этом этапе

- Rust-помощник remote-hub-helper (aarch64-apple-darwin) с жизненным циклом и
  версионированным протоколом stdio: length-prefixed JSON-кадры для управления
  и бинарные stream-кадры с session id и sequence number для терминальных
  байтов.
- Echo-консоль: RPC helper_status / echo_open / echo_input / echo_close.
- SSH-сеанс: форма подключения (host, user, port), запуск системного
  /usr/bin/ssh на собственном PTY помощника, xterm.js, resize, бинарный поток
  через WebSocket (attach/detach, повторное подключение со snapshot scrollback),
  статусы connecting/running/detached/closed и код завершения (exit code,
  signal, reason).

## Интеграционный тест (Docker)

npm run test:integration поднимает одноразовый sshd-контейнер на случайном
порту (изолированный временный каталог, свой ключ ed25519 и known_hosts,
никакого реального ~/.ssh), прогоняет 8 сценариев через настоящий бинарник
помощника, затем Node-тест service.ts + helper-process.ts. Если Docker
недоступен, Python-скрипт выходит с кодом 3 и печатает not run.

## Чего пока нет

Сохранение профилей и учётных данных, RDP, agent tools и CLI. Всё это —
последующие этапы; здесь их не выдают за работающие.

## Бинарник помощника не хранится в репозитории

Каталог bin/ не коммитится. Помощник собирается командой npm run build:helper
(нужен Rust toolchain и цель aarch64-apple-darwin). Без этого вкладка покажет
ошибку helper_missing с путём к ожидаемому бинарнику.

## Сборка и проверка

```
cd plugins/remote-hub
npm install
npm run build:helper   # cargo build + копия бинарника в bin/
npm run check          # typecheck + vitest
npm run build          # bb plugin build
```

Rust-тесты помощника: `cd helper && cargo test --locked --features test-hooks`.

## Структура

- src/core — zod-схемы протокола, кодек кадров, построитель ssh argv, credit (без host-кода).
- src/adapters/bb — запуск и управление помощником, service, WebSocket (Node/host-код).
- src/ui — компоненты без host-кода.
- helper/ — Rust-помощник (PTY, сессии, stdio-протокол, валидация ssh argv).
- docs/architecture.md — архитектура и проверка SDK-деклараций.

## Лицензия

MIT, см. LICENSE.
