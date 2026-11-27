# Доноры Commander: сводка этапа 0

Подробности и ссылки на файлы/строки — в `donors/*.md`; источники закреплены в
`sources.lock.json`. «Код» = найдено в коде, «запуск» = проверено запуском,
«заявлено» = только README/описание.

| Функция | Кандидат | Файл/символ | Лицензия | Доказательство | Решение | Риски |
|---|---|---|---|---|---|---|
| Двухпанельный UI целиком | DotDir `@dotdirfm/ui` 0.1.34 | `packages/ui/lib/DotDir.tsx` | ISC только в поле package.json; `ui-bridge`, `ui-focus`, `ui-utils`, Rust-ядро без лицензии | код + запуск в тестовом BB (`spikes/ui-dotdir`) | не берём | перехват клавиш вне корня (F5, печатные символы), свой Catppuccin, 5.7 MB бандл, битые типы |
| Контракт Bridge, протокол конфликтов/прогресса | DotDir | `packages/ui-bridge/src/bridge.ts`, `ConflictDialog.tsx` | неясна | код | референс формы | — |
| Раскладка F-клавиш, условия `when` | DotDir | `ui/features/commands/registerKeybindings.ts` | ISC (поле) | код | референс | — |
| Модель вкладки (path, selection, history) | Bobroot | `src/lib/tabState.ts` | MIT | код | идея | — |
| Защита удаления корня/home, copy-into-self, replace-source, имена « copy N» | Bobroot | `src-tauri/src/lib.rs:588,1546,1955,1972` | MIT | код (21 Rust-тест) | переносим кейсы в наши тесты | их Replace удаляет цель до копирования |
| Сохранение состояния temp+rename, `.corrupt` | Bobroot | `lib.rs:1220,1249` | MIT | код | приём | — |
| Реестр просмотрщиков (priority, maxSize) | Xplorer next | `client/src/lib/preview-factory.ts` | AGPL-3.0 | код | только идея | AGPL: код не копировать |
| Подпись расширений Ed25519 + SHA-256 | Xplorer next | `extensions/signing.rs` | AGPL-3.0 | код | только идея, своя реализация | противоречие manager.rs и signing.rs |
| SFTP | Xplorer next | `packages/extensions/ssh/native/src/lib.rs` | AGPL-3.0 | код | не берём | нет проверки host key, пароль в args |
| navPanel + tab, realtime-инвалидации | xMinor File Manager 0.11.3 | `plugins/file-manager/app.tsx:65-134`, `src/signals.ts:19` | MIT | код | берём образец | один корень, только primary-хост |
| Резолверы путей (realpath до проверки префикса) | xMinor File Manager | `src/root.ts:101-165` | MIT | код (~330 тестов) | берём с атрибуцией | TOCTOU-окно |
| HTTP data plane (Range/ETag, chunked upload с докачкой, zip-stream) | xMinor File Manager | `src/http-routes.ts:142-284`, `zip-stream.ts` | MIT | код | берём образец | `local`-роуты принимают только JSON-тела (см. bb-api-map §3) |
| Адресация `{hostId, path}`, policy, host entry с O_NOFOLLOW и `.partial`+link | File Gateway | `server.ts:19-159`, `host.ts:44-87`, `policy.ts:6-38` | MIT | код (~27 тестов) | берём образец | base64-RPC до 256 MiB; SFTP только пароль и только чтение |
| Agent tool и CLI поверх ядра | File Gateway | `server.ts:144,146` | MIT | код | образец | — |
| Связь тред → environment → host, команды с хоткеями, Trash+undo, ripgrep-поиск | Workbench Explorer | `src/workspace.ts:18-22`, `app.tsx:13-85`, `src/host-trash.ts`, `src/host-search.ts` | MIT | код | идеи | лексический confinement без realpath (`src/paths.ts`) |
| TC API: загрузка WFX/WCX, ABI | Double Commander | `src/uwfxmodule.pas`, `src/uwcxmodule.pas` | GPL-2.0 | код | только референс поведения | GPL: заголовки не копировать |
| TC API: свои типы, runner | собственный spike | `spikes/tc/` | наш | запуск, 8/8 тестов | основа runner-а этапа 4 | только синтетические плагины |

Итог: готового кода для очереди операций с прогрессом, отменой, конфликтами по
каждому элементу, атомарной заменой и SFTP-записью нет ни у одного донора;
это пишем сами. Перенос любого фрагмента записывается в
`THIRD_PARTY_NOTICES.md` в том же изменении.
