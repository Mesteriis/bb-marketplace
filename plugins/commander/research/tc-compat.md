# Commander: ранняя оценка совместимости с плагинами Total Commander (WCX/WFX/WDX/WLX)

Метод: только чтение исходников в `research/upstream/` (ничего не собиралось и не запускалось, бинарники не скачивались). Пути ниже относительны `research/upstream/`. Статусы: native | unchanged-via-runner | ported | reimplemented | unsupported | unverified.

## 1. Контракт TC API

### Лицензии SDK
- `WCX-SDK`, `WFX-SDK`, `WDX-SDK`, `WLX-SDK`: в `README.md` и в заголовках `src/*.h|*.pas` нет ни лицензии, ни copyright (grep по licen/copyright пуст); LICENSE-файлов нет. Статус: лицензия не указана, права на повторное распространение неясны (unverified). Документацию и заголовки ghisler.com нельзя считать свободными, в репозиторий Commander их без решения владельца не копировать.
- `doublecmd/LICENSE.md` — чистый GPL-2, текста исключения нет. `doublecmd/sdk/*.h` (`wcxplugin.h`, `wfxplugin.h`, `common.h`, `extension.h`) — собственные заголовки DC без лицензионной шапки, то есть под GPL-2 по умолчанию репозитория. Заимствовать их в код под другой лицензией рискованно.

### WCX (архиваторы)
- Минимум для чтения по `WCX-SDK/docs/overview.htm`: `OpenArchive`, `ReadHeader`, `ProcessFile`, `CloseArchive`, плюс `SetChangeVolProc` и `SetProcessDataProc`. Реальный загрузчик DC строже и мягче одновременно (`doublecmd/src/uwcxmodule.pas:403-436`): обязательны `OpenArchive`+`ReadHeader`+`ProcessFile`+`CloseArchive`, либо вариант `OpenArchiveW`+`ReadHeaderExW`+`ProcessFileW`+`CloseArchive`. `ReadHeaderEx` желателен для файлов более 2 ГБ (`WCX-SDK/docs/readheaderex.htm`: PackSizeHigh/UnpSizeHigh).
- Опционально: `PackFiles`, `DeleteFiles`, `GetPackerCaps`, `ConfigurePacker`, `StartMemPack`/`PackToMem`/`DoneMemPack`, `CanYouHandleThisFile`, `PackSetDefaultParams`, `PkSetCryptCallback`, `GetBackgroundFlags`, `ExtensionInitialize`/`ExtensionFinalize` (расширение DC, не TC). Если `GetPackerCaps` нет, TC считает плагин read-only (`overview.htm`).
- W-варианты есть только у: OpenArchiveW, ReadHeaderExW, ProcessFileW, SetChangeVolProcW, SetProcessDataProcW, PackFilesW, DeleteFilesW, StartMemPackW, CanYouHandleThisFileW. Только ANSI: ReadHeader, ReadHeaderEx, CloseArchive, GetPackerCaps, ConfigurePacker, PackToMem, DoneMemPack, PackSetDefaultParams (`WCX-SDK/docs/unicode_support.htm`). Для 64-битного TC достаточно только W (`64_bit_support.htm`).
- Callbacks WCX: `tChangeVolProc(ArcName,Mode)`, `tProcessDataProc(FileName,Size)` (возврат 0 = прервать), `tPkCryptProc(CryptoNr,Mode,ArchiveName,Password,maxlen)` (`WCX-SDK/src/wcxhead.h:162-172`). Режимы crypt: SAVE/LOAD/LOAD_NO_UI/COPY/MOVE/DELETE (`wcxhead.h:66-73`). Прогресс и ChangeVol устанавливаются на конкретный `hArcData`.
- Вызывающая последовательность: листинг `OpenArchive(PK_OM_LIST)` -> цикл `ReadHeader`+`ProcessFile(PK_SKIP)` -> `CloseArchive`; извлечение то же с `PK_EXTRACT` (`overview.htm`). `ProcessFile`: либо DestName полный путь и DestPath NULL, либо раздельно (`processfile.htm`).
- Потоки и реентерабельность: по умолчанию однопоточно. `GetBackgroundFlags` декларирует безопасность: BACKGROUND_UNPACK (Open/ReadHeader/ProcessFile/Close), BACKGROUND_PACK (PackFiles), BACKGROUND_MEMPACK (`wcxhead.h:55-57`, `getbackgroundflags.htm`). Состояние должно жить в `hArcData`, а не в глобальных переменных. DC учитывает флаги только для пакетных операций (`doublecmd/src/filesources/wcxarchive/uwcxarchivecopyinoperation.pas:180,396-398`).
- Layout: C-заголовок `wcxhead.h` без `#pragma pack`, а Pascal-эталон `WCX-SDK/src/wcxhead.pas:103-173` и DC `sdk/wcxplugin.pas:122-163` объявляют `packed record`. В `tHeaderDataEx` после 2048 байт имён идут 11 int (до смещения 2092), затем указатель `CmtBuf`: на 64-битной ABI в C-варианте будут 4 байта выравнивания, в packed-варианте нет. Нужные поля (ArcName..FileAttr) лежат до указателя и не затронуты, но смещение `CmtBuf` и после него зависит от компилятора плагина. Статус: unverified, проверить на spike (offsetof против sizeof в тестовой сборке).
- Типы: `WCHAR` = 16-бит UTF-16 и на Unix (`doublecmd/sdk/common.h:15-24` — `typedef uint16_t WCHAR`). Строки в W-вариантах всегда UTF-16, макс. 1024 (ex-структуры).

### WFX (файловые системы)
- Минимум по `WFX-SDK/docs/overview.htm`: `FsInit`, `FsFindFirst`, `FsFindNext`, `FsFindClose`. DC: обязательны `FsInit`+`FsFindFirst`+`FsFindNext` (A) либо `FsInitW`+`FsFindFirstW`+`FsFindNextW` (`doublecmd/src/uwfxmodule.pas:689-712`); `FsFindClose` не проверяется, но нужен для освобождения. Остальное грузится по одному (`overview.htm`: «не добавляйте пустые заглушки»).
- Функции только ANSI: `FsFindClose`, `FsGetDefRootName`, `FsSetDefaultParams`, `FsLinksToLocalFiles`, `FsContentGetSupportedField` (имена полей строго ANSI), `FsContentGetSupportedFieldFlags`, `FsContentGetDefaultSortOrder`, `FsContentPluginUnloading` (`WFX-SDK/docs/unicode_support.htm`). Остальные имеют W-пару (`FsInitW`, `FsFindFirstW`, `FsGetFileW`, ...).
- Callbacks: `tProgressProc(PluginNr,Src,Dst,Percent)` (возврат 1 = отмена), `tLogProc(PluginNr,MsgType,str)`, `tRequestProc(PluginNr,RequestType,Title,Text,Returned,maxlen)` (RT_* 0-10), `tCryptProc(PluginNr,CryptoNr,Mode,ConnName,Password,maxlen)` (`WFX-SDK/src/fsplugin.h:23-37,86-95,119-135`). `PluginNr` обязателен в каждом вызове callback.
- Порядок: плагин при установке грузится только ради `FsGetDefRootName` без `FsInit`; реально грузится при заходе в корень (`overview.htm`). `FsSetDefaultParams` с `FsDefaultParamStruct` (ini-путь) вызывается после загрузки (DC: `uwfxmodule.pas:866-877`, `PluginInterfaceVersionHi=2`). `FsFindFirst` может быть вызван сразу для подкаталога, не только для `\`. Пока реализован `FsStatusInfo`, любые вызовы кроме `FsInit`/`FsDisconnect` приходят внутри пары start/end.
- Кодировка путей: путь всегда с обратными косыми, корень `\`; ошибка `FsFindFirst` = `INVALID_HANDLE_VALUE (-1)`, пустой каталог = `SetLastError(ERROR_NO_MORE_FILES)` (`WFX-SDK/docs/fsfindfirst.htm`). Без W-варианта путь до 259 символов, с ним до 1023. На Unix-расширение: `dwFileAttributes | 0x80000000` и `dwReserved0` = mode (`doublecmd/sdk/wfxplugin.h:103`, `fsfindfirst.htm`).
- Отличие DC от TC: DC на Unix использует `PathDelim` (`/`) вместо `\` (`doublecmd/src/uwfxmodule.pas:903-906`); unix-WFX под DC не обязаны принимать `\`. Наш runner на Windows обязан передавать `\` (поведение TC), на mac для нативных плагинов нужно решение по разделителю.
- Callback и потоки: `FsGetBackgroundFlags` (BG_DOWNLOAD=1, BG_UPLOAD=2, BG_ASK_USER=4, `fsplugin.h:75-77`); по умолчанию 0 = только основной поток. DC защищает загрузку мьютексом (`uwfxmodule.pas:680`, `FMutex`) и иконки отдельным (`:632`). Множественные одновременные FindFirst-handle возможны (`overview.htm`: рекурсивный обход) — handle должен быть указателем на состояние.
- Копирование: `FsGetFile` вызывается дважды (первый раз с 0/MOVE: вернуть `FS_FILE_EXISTSRESUMEALLOWED/EXISTS`; второй с RESUME/OVERWRITE); при MOVE плагин сам удаляет источник; обязан вызывать ProgressProc минимум в начале и конце (`WFX-SDK/docs/fsgetfile.htm`).

### Соглашения вызова
- TC: `__stdcall`; на x64 Windows единая конвенция, поэтому `stdcall` значения не имеет. Для 32-бит нужны .def-файлы (имена `_Func@N`; `WCX-SDK/docs/overview.htm`).
- DC: `dcpcall` = `stdcall` на Windows, `cdecl` на остальных (`doublecmd/sdk/calling.inc:1-6`; C: `sdk/common.h:8-12,74-76`, `DCPCALL` пустой на не-Windows). На arm64 macOS `cdecl` = AAPCS64, различий нет. Целые параметры остаются 32-битными, только указатели и handle 64-битные (`64_bit_support.htm`).
- 64-битные Windows-плагины имеют расширение `.wcx64/.wfx64/.wdx64/.wlx64` (`64_bit_support.htm`; DC: `doublecmd/src/platform/udefaultplugins.pas:37-40`, `:385-389`).

## 2. Как Double Commander грузит плагины на Linux/macOS

- Модули: `doublecmd/src/uwcxmodule.pas` (TWcxModule), `uwfxmodule.pas` (TWFXModule), `uwdxmodule.pas`, `uwlxmodule.pas`, `udsxmodule.pas`; файловые источники: `src/filesources/wfxplugin/uwfxpluginfilesource.pas`, `src/filesources/wcxarchive/uwcxarchivefilesource.pas`.
- Загрузка: `mbLoadLibrary` -> `SafeLoadLibrary(CeUtf8ToSys(Name))` на не-Windows (`doublecmd/components/doublecmd/dcosutils.pas:1930-1955`), то есть обычный `dlopen` (FPC `dynlibs`). Расширение у плагина остаётся `.wcx/.wfx/.wdx/.wlx` и на Linux/macOS: это переименованные ELF `.so` или Mach-O dylib (маски: `udefaultplugins.pas:37-40`). Расширение `.dylib` DC для самих плагинов не использует.
- Проверка бинарника: `GetPluginBinaryType` читает заголовок (PE/ELF/Mach-O 32/64) и отказывает при несовпадении архитектуры (`udefaultplugins.pas:40-65,385-420`). Windows PE-плагин на macOS не загрузится: это принципиальная граница между «TC API» (ABI-контракт экспортов) и «Windows DLL» (бинарный формат и WinAPI).
- Что даёт «TC API» на Unix: те же имена экспортов, UTF-16 `WCHAR`, `WIN32_FIND_DATA` с `pack(1)` (`sdk/common.h:27-68`), FILETIME как Windows (100 нс с 1601). Чего нет: WinAPI (HWND, GDI, `SetLastError`-семантика, реестр, `LoadLibrary` зависимостей, регистр имён).
- Общие вызовы после загрузки: WCX: `PackSetDefaultParams(PluginInterfaceVersion Hi=2 Low=22, DefaultIniName)` (`uwcxmodule.pas:471-482`), `GetBackgroundFlags`, `ExtensionInitialize` (`:495-501`). WFX: `FsInit(PluginNr, progress, log, request)` затем `FsSetDefaultParams`, затем `FsSetCryptCallback` (`uwfxpluginfilesource.pas:496-511`, `uwfxmodule.pas:866-890`). WCX crypt: `uwcxarchivefilesource.pas:553-562`.
- Список по умолчанию зависит от ОС (`udefaultplugins.pas:335-345,370-377`): на macOS добавляются `MacCloud.wfx` и `MacPreview.wlx`.

## 3. Плагины в `doublecmd/plugins` (все на Free Pascal/Lazarus, C-плагинов нет)

Сборка `plugins/build.sh`: `lazbuild`; на Darwin собираются wcx base64/cpio/deb/rpm/unrar/zip, wdx rpm/deb/audioinfo, wfx ftp + MacCloud, wlx MacPreview, dsx DSXLocate. samba и wlxmplayer исключены из macOS (`plugins/build.sh`, ветка `uname | grep Darwin`). Примечание: условие для sevenzip `[ -n $(uname | grep Linux) ]` в build.sh без кавычек, оно выглядит ошибочным (всегда истинно) — не опираться на него.

| Плагин | Тип | Лицензия (по заголовку) | Кросс-платформенность и зависимости | Роль для пилота |
|---|---|---|---|---|
| `plugins/wcx/sample` | WCX | заголовка нет | Pascal, 74 строки `.lpr`, `winapi`-конвенция | образец, читать; минимальный ported-кандидат |
| `plugins/wfx/sample` | WFX | заголовка нет | Pascal, 141 строка, `dcpcall`, два фиктивных файла | образец/ported-кандидат для FsInit/FindFirst |
| `plugins/wdx/textline` | WDX | LGPL-2.1+ (`textline/src/TextLine.lpr`) | Pascal, 161 строка | ported-кандидат для WDX |
| `plugins/wcx/zip` | WCX | GPL-2+ (`ZipFunc.pas`), `COPYING.txt` GPL | собственный fparchive, inflate64, lzma; собирается на macOS | native-кандидат (zip/tar/gz/bz2/xz) |
| `plugins/wcx/sevenzip` | WCX | LGPL-2.1+ | грузит внешний `7z` (Windows `7z.dll`, Linux/mac `7z.so`), собирается только на Linux по build.sh | зависит от внешней библиотеки, на macOS ненадёжно (unverified) |
| `plugins/wcx/unrar` | WCX | GPL-2+ | нужен `libunrar.dylib` с wchar_t=4 (`unrar/src/unrarfunc.pas:40-47`), лицензия unrar ограничивающая | не брать |
| `plugins/wcx/base64`, `cpio`, `deb`, `rpm`, `torrent` | WCX | base64/torrent LGPL-2.1+; cpio/deb/rpm: наследие Mandryka/Maximov + DC, отдельные `license.txt` | чистый Pascal | ported-кандидаты (малый размер); лицензии разные, проверять по файлам |
| `plugins/wfx/ftp` | WFX | LGPL-2.1+ (`FtpFunc.pas`), synapse BSD-подобная | Pascal; sftp через `libssh2.dylib` на Darwin (`ftp/src/sftp/libssh.pas:364-365`) | native-кандидат для WFX, но с сетью и зависимостями (spike не для этапа 0) |
| `plugins/wfx/samba` | WFX | LGPL-2.1+ | `libsmbclient`, не собирается на macOS | не для macOS |
| `plugins/wfx/MacCloud` | WFX | GPL-2+ (`MacCloud.lpr`) | только macOS, Objective-C через FPC, OAuth в Safari; 12 драйверов облаков | native-кандидат, но GPL и привязан к DC-расширениям (unverified) |
| `plugins/wdx/audioinfo` | WDX | в `.lpr` нет шапки, 20 pas-файлов | Pascal | ported-кандидат; лицензию уточнить по `src/` |
| `plugins/wdx/rpm_wdx`, `deb_wdx` | WDX | не проверены | Pascal | малый приоритет |
| `plugins/wdx/scripts/*.lua` | WDX (Lua) | не проверены | скрипты, исполняются самим DC | reimplemented-кандидат (идея, не API) |
| `plugins/wlx/MacPreview` | WLX | LGPL-2.1+ | macOS, QuickLook, `NSView` вместо HWND | пример нативного WLX (см. п. 7) |
| `plugins/wlx/simplewlx`, `preview`, `richview`, `wmp`, `wlxmplayer` | WLX | richview/wmp LGPL-2.1+; wlxmplayer GPL (Qt4), simplewlx без шапки | зависимы от виджет-тулкитов (Qt/Win) | см. п. 7 |

Вывод: все открытые плагины DC написаны на Pascal; для маршрута «ported» (перенос на наш runner) это означает перепись, а не перекомпиляцию на clang. Для «native» нужно собрать FPC/Lazarus под macOS arm64 (выходит за рамки этапа 0 и ограничения «ничего не собирать»).

## 4. Примеры на C для clang/macOS

- В четырёх `*-SDK` репозиториях ghisler нет ни одного примера плагина, только заголовки и HTML-документация (`WCX-SDK/src`, `WFX-SDK/src`, `WDX-SDK/src`, `WLX-SDK/src`; в `docs` ссылки на sample на ghisler.com: `fsplugin`, Visual C++/Delphi — не в репозитории). Заголовки ghisler рассчитаны на `windows.h`: `DWORD`, `WCHAR`, `MAX_PATH`, `HANDLE`, `WIN32_FIND_DATA`, `__stdcall` не определены вне Windows.
- В DC есть C-заголовки с портируемым слоем типов: `doublecmd/sdk/common.h` (ветка `__GNUC__`: `DCPCALL` пустой на не-Windows, `WCHAR=uint16_t`, `HWND=void*`, packed `WIN32_FIND_DATA`), `wcxplugin.h`, `wfxplugin.h`, `wdxplugin.h`, `wlxplugin.h`, `extension.h`. Они предназначены для clang/gcc на Linux/macOS (не собиралось, это вывод по чтению).
- Примеры самих плагинов в DC все на Pascal (`plugins/wcx/sample`, `plugins/wfx/sample`, `plugins/wdx/textline`), на C в `plugins/` нет ничего (единственный `.c` в репозитории: `libraries/src/libbz2/error.c`, не плагин).
- Следствие: для spike нужно написать собственные минимальные C-плагины (по 50-100 строк на WFX и WCX) поверх `doublecmd/sdk/*.h`, ориентируясь на логику `wfx/sample/src/sample.lpr` и `wcx/sample/src/sample.lpr`. Лицензия `sdk/*.h`: GPL-2 по умолчанию DC (см. п. 1), поэтому собственный spike-код держать вне дерева продукта или переписать заголовки по документации. Тестовые плагины ничего не заимствуют, если их ABI-структуры написаны по `docs/*.htm`.

## 5. План compatibility spike, этап 0

Цель этапа: доказать, что runner на macOS arm64 может загрузить плагин, вызвать контракт TC API без падений и вернуть данные по JSON-RPC. Реальные сторонние Windows-плагины здесь не запускаются.

1. Тестовые плагины (свои, C, clang `-shared -arch arm64 -o spike.wfx`/`spike.wcx`, макрос `DCPCALL` пустой):
   - `spike.wfx`: экспорты `FsInit`, `FsFindFirst`, `FsFindNext`, `FsFindClose`, `FsGetFile`, `FsGetDefRootName`, `FsSetDefaultParams`; плюс `FsInitW`/`FsFindFirstW`/`FsFindNextW`/`FsGetFileW`, чтобы проверить выбор W-пути.
   - `spike.wcx`: `OpenArchive`, `ReadHeader`/`ReadHeaderEx`, `ProcessFile`, `CloseArchive`, `SetProcessDataProc`, `SetChangeVolProc`, `GetPackerCaps`, `GetBackgroundFlags`, `OpenArchiveW`/`ReadHeaderExW`/`ProcessFileW`.
   - Для эталонности параллельно взять `doublecmd/plugins/wfx/sample` и `wcx/sample` как образцы поведения (не компилировать, если нет FPC).
2. Runner: отдельный процесс, Rust (`libloading`), протокол JSON-RPC 2.0 по stdio (Content-Length или NDJSON), один процесс на плагин и сессию, чтобы падение плагина не убивало BB. Rust выбран из-за безопасной работы с FFI-указателями и простых `repr(C, packed)`; C допустим только для макета структур в тесте.
   - Методы: `plugin.load{path,kind}`, `plugin.exports`, `wfx.init`, `wfx.list{path}`, `wfx.getFile{remote,local,flags}`, `wcx.open{archive,mode}`, `wcx.readHeaders`, `wcx.processFile{op,destPath,destName}`, `wcx.close`, `plugin.unload`.
   - Callbacks плагина превращаются в JSON-RPC уведомления: progress (`PluginNr`, имена, процент; результат 0/1 берётся из ответа клиента или из флага отмены), log, request (по умолчанию отказ без UI), crypt (по умолчанию отказ).
3. Вызовы WFX: `FsInit` -> `FsSetDefaultParams` -> `FsFindFirst("\\")`/`FsFindNext` до false -> `FsFindClose` -> `FsFindFirst("\\subdir")` -> `FsGetFile` (двухэтапный сценарий: первый вызов при существующем локальном файле должен вернуть EXISTS, второй с OVERWRITE) -> `FsDisconnect`. Проверить ERROR_NO_MORE_FILES-эквивалент, INVALID_HANDLE_VALUE (-1), множественные открытые handle.
4. Вызовы WCX: `OpenArchive(PK_OM_LIST)` -> цикл `ReadHeaderEx`+`ProcessFile(PK_SKIP)` -> `CloseArchive`; затем `OpenArchive(PK_OM_EXTRACT)` и `PK_EXTRACT`/`PK_TEST` для выбранного файла; `ProcessDataProc` прерывание (возврат 0 -> `E_EABORTED`).
5. Критерии прохождения (все должны быть выполнены):
   - Загрузка `dlopen` без ошибок; проверка Mach-O arm64 до загрузки (`PE` отвергается с ясной ошибкой).
   - Все обязательные экспорты найдены по именам (см. п. 1); при отсутствии A-варианта используется W-вариант.
   - Структуры совпадают по `sizeof`/`offsetof` с эталоном (в т.ч. `tHeaderDataEx` до и после `CmtBuf`, `WIN32_FIND_DATAW`: dwFileAttributes, FILETIME, имена UTF-16 с 1024 символами для W).
   - Кириллические и emoji-имена (суррогатные пары) проходят в обе стороны.
   - Размер файла более 4 ГБ через `*High` (синтетически, без реального файла).
   - Отмена через callback возвращает корректный код, нет утечек handle (`CloseArchive`/`FsFindClose` вызваны в каждой ветке).
   - Падение плагина (сигнал) убивает только runner; родитель получает структурированную ошибку, restart работает.
   - Один и тот же плагин вызывается строго последовательно, если `GetBackgroundFlags`/`FsGetBackgroundFlags` = 0.
6. Результат этапа: таблица экспортов и ABI-проверок, подтверждённые статусы native для собственных C-плагинов; все чужие Windows-плагины остаются unverified до этапа с Windows runner.

## 6. Кандидаты сторонних плагинов (только список, ничего не скачивалось)

Источники: `https://www.ghisler.com/plugins.htm` (страница открыта и прочитана, подтверждено: таблицы Packer/File system/Lister/Content; никаких записей о сборках для Linux или macOS нет) и `https://totalcmd.net` (не открывался, ссылки на него есть на странице ghisler; содержимое не проверено).

Маршрут B (Windows runner, статус пока unverified, по умолчанию unchanged-via-runner):
- WFX: WebDAV 3.2 (с исходниками), SFTP 3.10 (с исходниками), Ext2+Reiser 1.6 (с исходниками), Registry 5.2 (без исходников; Windows-only семантика).
- WCX: 7zip 0.7.6.5a (с исходниками), BZIP2 1.6, AmigaDX 3.6, Catalog 4.1.3, Checksum 0.2b (все с исходниками).
- WLX: CudaLister 1.6.16, EBCDICview 1.1, eReader, TreeView (с исходниками); Anytag, ArcView (без исходников). Требуют HWND (см. п. 7).
- WDX: Exif 2.8, ExeFormat 0.6b, xPDFSearch 1.11, File descriptions 1.3.2 (с исходниками), AudioInfo 1.4.3 и DirSizeCalc 2.21 (без исходников).
- Приоритет для первого прогона на Windows: WDX (нет UI), затем WCX (7zip, BZIP2, Checksum), затем WFX (WebDAV, SFTP).

Маршрут A (нативные сборки сторонних плагинов): подтверждённо только то, что лежит в `doublecmd/plugins` (п. 3): zip, base64, cpio, deb, rpm, unrar (внешний libunrar), sevenzip (внешняя `7z`), ftp (с libssh2), MacCloud, audioinfo, MacPreview. Нативных mac/Linux сборок других TC-плагинов из этой выборки не видно; для остальных плагинов с исходниками (список выше) нужен порт с Windows API, оценка трудоёмкости не проводилась (unverified).

## 7. WLX и HWND

- Контракт WLX целиком построен на `HWND`: `ListLoad(ParentWin, File, ShowFlags)` возвращает окно плагина, созданное как дочернее окно `ParentWin`; `ListCloseWindow`, `ListSendCommand`, `ListSearchText`, `ListNotificationReceived` (оконные сообщения) работают поверх этого окна (`WLX-SDK/src/listplug.h:42-61`; `docs/listload.htm`, `wm_command.htm`). Только `ListGetPreviewBitmap` (`:58-61`) возвращает `HBITMAP`, то есть не требует родительского окна.
- Под DC на Unix `HWND` — это указатель нативного виджета, а не Win32-окно: `WlxPrepareContainer` подставляет `GtkWidget*`/`QWidget*` текущего тулкита (`doublecmd/src/uwlxmodule.pas:236-252`), вызов `ListLoad` идёт на `:369-403`; на macOS `MacPreview` принимает `NSView` (`doublecmd/plugins/wlx/MacPreview/src/MacPreview.lpr:401-411`: `NSView(ParentWin).addSubview(view)`). Следовательно, Unix-WLX привязан к тулкиту DC и не переносим в BB (Electron/Tauri webview).
- Варианты:
  1. unsupported: WLX не поддерживаем (самое дешёвое, стоит зафиксировать как исходное решение).
  2. unchanged-via-runner на Windows: runner создаёт дочернее Win32-окно, плагин рисует в него, окно захватывается и передаётся в BB как поток кадров (offscreen render/`PrintWindow`) с проксированием мыши и клавиатуры; сложно и хрупко, интерактивность ограничена.
  3. reimplemented: свои вьюеры на веб-стеке для частых форматов (текст, hex, изображения, markdown, PDF, медиа), как делает DC для `richview`/`simplewlx`-подобных. Это не совместимость, а замена; статус reimplemented.
  4. Частичная поддержка `ListGetPreviewBitmap` (миниатюры) через runner без окон: не требует HWND, приемлем для изображений и документов; на Windows возвращает `HBITMAP`, который нужно сериализовать в PNG через GDI (unverified).
  5. Нативный mac-аналог: QuickLook (как `MacPreview`), статус native/reimplemented на уровне нашей реализации, а не загрузка чужих плагинов.
- Рекомендация: этап 0-1 помечает WLX unsupported, этап с Windows runner оценивает только вариант 4 (миниатюры), полноценные окна через вариант 3.

## Неподтверждённое
- Все статусы unverified, пока нет сборки spike.
- `tHeaderDataEx` layout после `CmtBuf` на 64-бит (п. 1).
- Лицензии у `wcx/zip`, `unrar`, `wdx/audioinfo`, `wdx/rpm_wdx`, `wdx/deb_wdx` по заголовкам только частично прочитаны (отмечено в таблице).
- `totalcmd.net` не открывался.
