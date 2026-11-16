# Remote Hub [Experimental]

Менеджер SSH/RDP-подключений для BB. Пока реализован этап 1: каркас плагина,
Rust-помощник с жизненным циклом и проверенный IPC (echo-сессия на настоящем
PTY). SSH, RDP, сохранение профилей и учётных данных появятся на следующих
этапах.

## Что работает на этом этапе

- Rust-помощник `remote-hub-helper` (aarch64-apple-darwin) запускается из
  TS-адаптера и общается по версионированному протоколу stdio: length-prefixed
  JSON-кадры для управления и отдельные бинарные stream-кадры с session id и
  sequence number для терминальных байтов.
- RPC `helper_status` — версия, pid, платформа, число открытых сессий и
  живое состояние (`alive`).
- RPC `echo_open` / `echo_input` / `echo_close` — echo-сессия на настоящем
  PTY (`/bin/cat`), resize и закрытие без осиротевших процессов.
- Вкладка плагина показывает состояние помощника (loading / error / ready) и
  минимальную echo-консоль.

## Что работает после 2a

Один настоящий SSH-сеанс во встроенном терминале (xterm.js): форма
подключения (host, user, port), запуск через системный /usr/bin/ssh с
реальным PTY, resize, бинарный поток терминала через WebSocket
(attach/detach, переподключение со snapshot scrollback), статусы
connecting/running/closed и код завершения. Сохранение профилей, RDP,
agent tools и CLI — следующие этапы.

## Интеграционный тест (Docker)

npm run test:integration поднимает одноразовый sshd-контейнер на случайном
порту (изолированный временный каталог, свой ключ ed25519 и known_hosts,
никакого реального ~/.ssh) и гоняет сеансы через настоящий бинарник
помощника. Если Docker недоступен, скрипт выходит с кодом 3 и печатает
not run.

## Чего пока нет
SSH, RDP, сохранение профилей и учётных данных, agent tools и CLI. Всё это —
последующие этапы; здесь их не выдают за работающие.

## Бинарник помощника не хранится в репозитории

Каталог `bin/` не коммитится. Помощник собирается командой
`npm run build:helper` (нужен установленный Rust toolchain и цель
`aarch64-apple-darwin`). Без этого вкладка покажет ошибку `helper_missing`
с путём к ожидаемому бинарнику.

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

- `src/core` — zod-схемы протокола и кодек кадров (без host-кода).
- `src/adapters/bb` — запуск и управление помощником (Node/host-код).
- `src/ui` — компоненты без host-кода.
- `helper/` — Rust-помощник (PTY, сессии, stdio-протокол).
- `docs/architecture.md` — архитектура и проверка SDK-деклараций.

## Лицензия

MIT, см. LICENSE.
