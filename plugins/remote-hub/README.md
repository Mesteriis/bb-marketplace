# Remote Hub [Experimental]

Менеджер SSH/RDP-подключений для BB. Сейчас реализованы один настоящий
SSH-сеанс во встроенном терминале (xterm.js) и один настоящий RDP-сеанс на
canvas, Rust-помощник с настоящими PTY и отдельным процессом RDP на сеанс,
проверенный IPC. Профили, сохранённые учётные данные, agent tools и CLI —
следующие этапы.

## Что работает

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

- RDP-сеанс: форма (host, port, user, password, domain), рабочий стол на
  canvas, мышь, колесо и клавиатура, кнопка Ctrl+Alt+Del, режимы Fit и 1:1,
  скриншот PNG, отключение и повторное подключение. Сертификат сервера
  проверяется строго; если ему не доверяют, показываются отпечаток, subject,
  издатель и срок, и можно принять один раз, довериться на время работы BB или
  отклонить. Другой сертификат на доверенном хосте показывается как изменённый
  и никогда не принимается автоматически. Вход — через NLA/CredSSP, если сервер
  его предлагает. Отключение не завершает сеанс пользователя на сервере.

## Интеграционный тест (Docker)

npm run test:integration поднимает одноразовые sshd- и xrdp-контейнеры на случайных
портах (изолированный временный каталог, свой ключ ed25519 и known_hosts,
никакого реального ~/.ssh), прогоняет 8 сценариев через настоящий бинарник
помощника, затем Node-тест service.ts + helper-process.ts. Если Docker
недоступен, Python-скрипт выходит с кодом 3 и печатает not run.

## Чего пока нет

Сохранение профилей, учётных данных и доверенных сертификатов (доверие живёт
до перезапуска BB), agent tools, CLI, буфер обмена, изменение размера рабочего
стола, Kerberos. NLA и строгий TLS проверены вручную на настоящем Windows;
внутри живого BB плагин в остальном не проверялся.

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
