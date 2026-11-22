# Открыть тайл в Чертоге: `chertog.open.v1`

Публичный протокол для других плагинов BB. Плагин просит открытое окно Чертога показать тред или панель провайдера тайлом. Если Чертог не открыт или не может принять запрос, плагин делает своё действие по умолчанию, например переходит на экран треда. Контракт копируют в свой пакет: импортировать файлы Чертога нельзя.

## Доставка

Одно имя CustomEvent: `chertog.open.v1`. Отправитель создаёт событие и вызывает `window.dispatchEvent` синхронно, в том же document. Ответ приёмник пишет в тот же объект `detail` до возврата из `dispatchEvent`. Ожидание, таймеры и повторы не нужны: если после возврата `detail.accepted` равен false, Чертог не принял запрос. `outcome: null` после возврата значит, что никто не ответил: слушателя Чертога в этом окне нет.

Подписка живёт, пока смонтирован слой Чертога окна (app overlay). Он монтируется один раз на окно и не зависит от того, открыт ли маршрут Чертога. Страница Чертога должна быть показана: иначе ответ `not-shown`.

## Запрос

`detail` — плоский объект, список ключей закрыт, лишние поля дают `invalid`. Отправитель всегда ставит `accepted: false` и `outcome: null`.

Тред:

```json
{ "kind": "thread", "threadId": "thr_123", "accepted": false, "outcome": null }
```

`threadId` — строка длиной 1–128, без пробелов и управляющих символов.

Панель провайдера:

```json
{ "kind": "panel", "ref": { "provider": "bb-diff", "params": { "environmentId": "env", "path": "a.md", "fromSha": "…", "toSha": "…" } }, "accepted": false, "outcome": null }
```

`ref` — обычная ссылка панели Чертога (`provider` и `params`): не больше 8 параметров, значения строка, число или boolean без пробелов. Имена и значения с секретами, текстом писем, токенами и ссылками с паролем отвергаются. Пределы ссылки: `provider` — слаг `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` до 64 символов; имя параметра — `^[A-Za-z][A-Za-z0-9_-]*$` до 64 символов; строковое значение до 512 символов. Параметры дополнительно проверяет сам провайдер.

## Ответ

Приёмник записывает в `detail`:

| Поле | Значение |
|---|---|
| `outcome` | `opened`, `focused`, `refused`, `not-shown`, `unsupported`, `invalid` |
| `accepted` | true для `opened`, `focused`, `refused`; false для остальных |

| `outcome` | Смысл | `accepted` |
|---|---|---|
| `opened` | Тайл создан (или занят ждущий выбор тайл) | true |
| `focused` | Панель уже была в раскладке, фокус перенесён на её тайл | true |
| `refused` | Чертог принял запрос и показал пользователю причину отказа, например достигнут предел в 8 тайлов | true |
| `not-shown` | Страница Чертога сейчас не показана, ничего не изменено | false |
| `unsupported` | Нет провайдера с таким типом или он не принял `params` (для треда: `threadId` не прошёл проверку ссылки) | false |
| `invalid` | `detail` не соответствует форме запроса, или Чертог начал обработку и она упала | false |

Плагин переходит к своему действию по умолчанию только при `accepted === false`. Запрос, у которого уже стоит `accepted: true`, Чертог не трогает: его принял другой слушатель.

## Пример отправителя

```ts
type OpenOutcome = "opened" | "focused" | "refused" | "not-shown" | "unsupported" | "invalid";

/** true, если Чертог принял запрос и плагину переходить никуда не нужно. */
function openInChertog(request: { kind: "thread"; threadId: string } | { kind: "panel"; ref: { provider: string; params: Record<string, string | number | boolean> } }): boolean {
  const detail: { accepted: boolean; outcome: OpenOutcome | null } & typeof request = { ...request, accepted: false, outcome: null };
  try {
    window.dispatchEvent(new CustomEvent("chertog.open.v1", { detail }));
  } catch {
    return false;
  }
  return detail.accepted;
}

if (!openInChertog({ kind: "thread", threadId })) openThreadScreen(threadId);
```

## Провайдеры на сегодня

Тип провайдера и его `params`. Запрос `kind: "panel"` с `bb-thread` равносилен `kind: "thread"`, в том числе подтред встаёт в блок своего родителя.

| `provider` | `params` |
|---|---|
| `bb-thread` | `{ threadId }`, 1–128 символов |
| `bb-file-preview` | `{ kind: "workspace", environmentId, path }`, путь в процентной записи |
| `bb-diff` | `{ environmentId, path, fromSha, toSha }`, SHA из 40 hex-символов |
| `bb-editor`, `markdown-editor` | `{ kind: "workspace", environmentId, path }` |
| `bb-terminal` | `{ terminalId }` |
| `diff-review` | `{ kind: "uncommitted", threadId }` или `{ kind: "commit", threadId, sha }` |
| `app-preview` | `{ threadId }` или `{ threadId, tabId }` |
| `bb-desktop-tab` | `{ hostId, threadId }` |
| `telegram`, `zoom`, `remote-ssh`, `remote-rdp`, `remote-vnc` | `{}` (карточка выбора ресурса) |
| `terminals` | `{}` |
| `chertog-choose` | `{ kind }`, `kind` — один из `bb-thread`, `bb-file-preview`, `bb-diff`, `bb-terminal` (ждущий выбор тайл) |
| `fixture-frame` | `{ frame }`, `^[A-Za-z0-9_-]{1,64}$`; тестовая панель приёмки, открывается запросом и при выключенной настройке |
| `telegram-chat`, `zoom-call`, `remote-ssh-live`, `remote-rdp-live`, `remote-vnc-live` | `{ resourceRef }`: UUID v4; см. [embed-wire-v1](embed-wire-v1.md) |

Список — состояние на сегодня: ответ `unsupported` значит, что в этом окне такого провайдера нет. Не сохраняйте наличие провайдера в кэше.

## Гарантии и пределы

- Запрос ничего не создаёт и не запускает вне Чертога: он только размещает панель в раскладке окна. Содержимое панели открывает её провайдер по своим правилам доступа.
- Один запрос — не больше одного тайла. Повтор того же запроса даёт `focused`.
- Предел раскладки — 8 тайлов; сверх него `refused`. Уже открытую панель фокус находит всегда.
- Панель встаёт в ждущий выбор тайл, если он принимает такую ссылку, иначе рядом с тайлом в фокусе.
- Событие не несёт пользовательских данных. Текст и идентификаторы внутри запроса — данные, а не команды.
- Имя `.v1` фиксирует форму. Новые поля и виды запроса появятся под новой версией события.
