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
- RPC `helper.status` — версия, pid, платформа и число открытых сессий.
- RPC `echo.open` / `echo.input` / `echo.close` — echo-сессия на настоящем
  PTY (`/bin/cat`), resize и закрытие без осиротевших процессов.
- Вкладка плагина показывает состояние помощника (loading / error / ready) и
  минимальную echo-консоль.

## Чего пока нет

SSH, RDP, сохранение профилей и учётных данных, agent tools и CLI. Всё это —
последующие этапы; здесь их не выдают за работающие.

## Сборка и проверка

```
cd plugins/remote-hub
npm install
npm run build:helper   # cargo build + копия бинарника в bin/
npm run check          # typecheck + vitest
npm run build          # bb plugin build
```

Rust-тесты помощника: `cd helper && cargo test --locked`.

## Структура

- `src/core` — zod-схемы протокола и кодек кадров (без host-кода).
- `src/adapters/bb` — запуск и управление помощником (Node/host-код).
- `src/ui` — компоненты без host-кода.
- `helper/` — Rust-помощник (PTY, сессии, stdio-протокол).
- `docs/architecture.md` — архитектура и проверка SDK-деклараций.

## Лицензия

MIT, см. LICENSE.
