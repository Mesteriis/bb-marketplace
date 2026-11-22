# Протокол тайла одного окна

Версия `chertog.embed.v1`. Стороны копируют контракт в свой пакет. Чертог владеет размещением, провайдер владеет порталом и всеми операциями с ресурсом. Модель доверия и правила принятия временного тайла описаны в [проекте встраивания](provider-embed.md).

## Доставка и адресация

Три имени CustomEvent: `chertog.embed.v1.query`, `chertog.embed.v1.host`, `chertog.embed.v1.owner`. Query отправляется на document текущего окна. Host и owner отправляются на DOM-элемент контейнера с bubbles=true, composed=false. Адаптеры подписываются на document. Detail содержит только плоский JSON-объект. Узел берут из event.target. Ответ адресуется тому же узлу.

Единственный корень слоя в document несёт data-chertog-embed-layer="v1". Его непосредственный ребёнок с data-live-host="<instanceId>" содержит ровно один div с data-chertog-embed-target="v1", data-provider="<provider>", data-instance-id="<instanceId>", data-generation="<generation>". Между ребёнком и div допускаются обёртки. Маркеры ставит Чертог до объявления. Проверить ownerDocument, isConnected, единственность слоя, ближайший [data-live-host], его прямое родство со слоем, единственность экземпляра в слое и единственность target внутри host. Сверить все атрибуты с detail, включая точную десятичную запись поколения. Обе стороны держат ссылку на принятый узел. Подмена узла в пределах поколения запрещена. Маркеры служат маршрутизации между доверенными расширениями.

## Формы сообщений

У каждого сообщения обязательны version, provider и kind. Provider принимает ровно telegram-chat, zoom-call, remote-ssh-live, remote-rdp-live, remote-vnc-live. У каждого сообщения, кроме query, обязательны instanceId (1–128 ASCII-букв, цифр, подчёркиваний или дефисов) и generation (положительное безопасное целое). Дополнительные поля заданы таблицей примеров. Список ключей каждого варианта закрыт. resourceRef — UUID v4 в нижнем регистре с RFC-вариантом. Неверную версию, тип, комбинацию, лишнее поле и ошибочный адрес игнорируют без ответа. В wire отсутствуют пользовательские данные, причины ошибок и исполняемые значения.

| Событие | Литеральный detail |
|---|---|
| query | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"query"}` |
| host | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"announce","instanceId":"view-1","generation":1,"mode":"choose"}` |
| owner | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"selected","instanceId":"view-1","generation":1,"resourceRef":"12345678-1234-4123-8123-123456789abc"}` |
| host | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"announce","instanceId":"view-1","generation":1,"resourceRef":"12345678-1234-4123-8123-123456789abc"}` |
| host | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"visibility","instanceId":"view-1","generation":1,"visible":false}` |
| host | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"close","instanceId":"view-1","generation":1}` |
| host | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"release","instanceId":"view-1","generation":1}` |
| owner | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"choosing","instanceId":"view-1","generation":1}` |
| owner | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"ready","instanceId":"view-1","generation":1}` |
| owner | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"denied","instanceId":"view-1","generation":1}` |
| owner | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"ended","instanceId":"view-1","generation":1}` |
| owner | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"lost","instanceId":"view-1","generation":1}` |
| owner | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"revoked","instanceId":"view-1","generation":1}` |
| owner | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"cancelled","instanceId":"view-1","generation":1}` |
| owner | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"keep","instanceId":"view-1","generation":1}` |
| owner | `{"version":"chertog.embed.v1","provider":"telegram-chat","kind":"hide","instanceId":"view-1","generation":1}` |

Для тестов Zoom и Remote Hub подставить в литералы свой provider. Для положительного теста видимости заменить false на true. Негативные примеры — generation=0, поле url, target из соседнего host, version="chertog.embed.v2", announce одновременно с mode и resourceRef, selected с UUID чужого поколения.

## Жизненный цикл

1. Чертог подписывается на query и owner. Провайдер подписывается на host, затем посылает query своего типа. В ответ Чертог повторяет текущие announce и visibility каждого экземпляра типа. При добавлении экземпляра Чертог также объявляет его сам. Для позднего слушателя повтор идентичного announce отвечает текущим статусом. Повтор сохраняет портал и не запускает действий пользователя. Хост может повторять announce для проверки доступности. По истечении локального ограниченного тайм-аута без ответа состояние unknown.
2. Добавление резервирует временный instanceId и mount до получения UUID. Объявление с mode="choose" открывает интерфейс владельца, choosing подтверждает его наличие. Owner отправляет selected после явного выбора и проверки доступа. Чертог принимает только первый допустимый ответ с ещё открытого выбора и подтверждает его announce с этим resourceRef на том же узле и поколении. Это единственная разрешённая смена содержания announce внутри поколения. Owner принимает переход только для собственного ожидающего UUID. До принятия запрещены attach и открытие ресурса. Сохранение раскладки включает UUID только после принятия. При восстановлении первым объявлением может быть announce с resourceRef. Owner проверяет доступ до первого чтения и каждого действия. Ready означает доступный экран. Denied означает отказ доступа, ended — подтверждённое завершение, lost — неопределённый исход.
3. Отмена в picker отправляет cancelled. Отмена хостом, потеря группы или отказ принять UUID отправляет release до удаления узла. Любой поздний ответ игнорируется. Новая попытка использует строго большее generation. Адаптеры помнят отозванные поколения до конца жизни соответствующего экземпляра. При размонтировании overlay владелец посылает revoked, снимает подписки и порталы. Чтобы возобновить после revoked/lost, Чертог создаёт новое поколение. Reload не повторяет ввод, отправку или подключение.
4. Visibility меняет доступность ввода и видимость для агента. Чертог скрывает и делает тайл inert. Узел, портал и привязка остаются прежними. Все стороны применяют фактическую видимость тайла и его предков. Скрытие не завершает сессию.
5. Close просит владельца показать подтверждение для последнего разрушающего вида. Keep отменяет запрос, hide оставляет вид скрытым, ended после подтверждённого завершения разрешает release. Для неразрушающего вида ended подтверждает закрытие только этого вида. Повторы close идемпотентны. До подтверждения и при потере ответа источник сохраняется. Release снимает портал и обработчики вида. Release сам по себе не завершает внешнюю сессию. Чертог игнорирует ответы, недопустимые для текущего состояния, включая keep/hide без close и ready перед принятием выбора.
