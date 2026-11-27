# TC-plugin compatibility spike (stage 0)

Research spike for the future BB plugin Commander. Not product code. Checks the plan in
`../../tc-compat.md` section 5 on macOS arm64 with **own synthetic plugins** and a dependency-free Rust runner.
Nothing from upstream was executed or copied; upstream docs were only read.

## Layout

- `plugins/tc_types.h` - own minimal ABI types. The layouts are **derived from the SDK documentation**
  (`win32_find_data.htm`, `remoteinfostruct.htm`, `fsdefaultparamstruct.htm`, `theaderdataex.htm`,
  `topenarchivedata.htm`) and **verified by a sizeof/offsetof test** (`layout_matches_literals`) against literals, both on the
  C side (`SpikeLayout` export) and on the Rust side (`abi.layout`). No TC/Double Commander header text is copied.
- `plugins/spike_wfx.c` -> `spike.wfx`; `plugins/spike_wcx.c` -> `spike.wcx` (`clang -shared -arch arm64`).
- `runner/` - Cargo package `tc-runner` (bin `tc-runner`, lib `tc_runner` with the JSON codec used by tests). No crates;
  `dlopen`/`dlsym`/`dlclose`/`dlerror` declared by hand (libSystem). `.cargo/config.toml` puts `target/` in `spikes/tc/target`.
- `runner/tests/integration.rs` - spawns `tc-runner` as a child process; expected values are literals. It compiles the
  plugins itself with `/usr/bin/clang` (also an x86_64 build for the wrong-arch check).
- `test.log` - raw output of the last run.

Run: `cd plugins/commander/research/spikes/tc/runner && cargo test --offline` (needs clang, no network).

## Runner protocol

JSON-RPC 2.0, one JSON message per line (NDJSON) on stdin/stdout; stderr is not used. One process hosts one plugin;
requests are handled strictly one at a time (single thread), so plugin calls are serialized.
Notifications from the runner (no `id`): `progress` (`kind` wfx|wcx), `log`, `request` (always refused), `crypt` (always refused).
Errors: `-32700` parse, `-32601` unknown method, `-32602` params, `-32000` runner/plugin error with `data.kind`
(`PeRejected`, `ElfRejected`, `WrongArch`, `UnknownFormat`, `NotLibrary`, `DlopenFailed`, `MissingExports`, `NotLoaded`,
`BadUtf16`, `FsFindFirstFailed{errno}`, `OpenArchiveFailed{code}`, `NotInArchive`, ...).
A plugin operation code (e.g. `FS_FILE_USERABORT`, `E_EABORTED`) is a normal result `{code, codeName}`, not an RPC error.

Methods: `plugin.load{path,kind}`, `plugin.exports`, `plugin.unload`, `plugin.stat` (spike counters), `plugin.layout{key}`,
`abi.layout`, `wfx.init`, `wfx.list{path}`, `wfx.tree{path}` (recursion with several open find handles),
`wfx.getFile{remote,local,overwrite?,cancelAtPercent?}`, `wcx.list{archive}`,
`wcx.extract{archive,name,dest,split?,test?,abortAfterBytes?}`, `runner.shutdown`.
Cancellation is a request flag (`cancelAtPercent`, `abortAfterBytes`) that the callback turns into 1 / 0; a
client-answered round trip from inside the callback is NOT implemented.
Plugin-side paths use `\`; local paths are native (`/`). Strings are UTF-8 on the wire and UTF-16 in the plugin; an
unpaired surrogate is an error (`BadUtf16`), never U+FFFD.

## Proven (own plugins, macOS arm64, 8/8 tests)

- Mach-O arm64 check before `dlopen`; PE (`MZ`), ELF, text, x86_64 Mach-O are rejected with distinct errors; a
  valid library of the wrong kind is rejected (`MissingExports`) and unloaded; the runner stays usable.
- Export discovery; W variants preferred (ANSI entry points are counting stubs, counter stays 0 after full sessions).
- WFX: `FsGetDefRootName` -> `FsInitW` -> `FsSetDefaultParams` (struct size 272, version 2.22 arrives intact); listing with
  Cyrillic and emoji (surrogate pairs) names; size above 4 GiB = `5368709120` via `nFileSizeHigh/Low`; "no time" FILETIME
  sentinel; Unix-mode extension (`0x80000000` + `dwReserved0`); nested listing with several open handles; no leaked
  find handles on ok/empty/error/bad-name branches.
- `FsGetFileW` two-stage: existing file -> `FS_FILE_EXISTS` (content untouched), then overwrite -> `FS_FILE_OK` with exact bytes;
  ProgressProc 0/50/100; cancel -> `FS_FILE_USERABORT` with no partial or `.part` file and the old file intact.
- WCX: `OpenArchiveW`/`ReadHeaderExW`/`ProcessFileW`/`CloseArchive`, per-handle `SetProcessDataProcW`/`SetChangeVolProcW`
  registration; headers with `PackSizeHigh/UnpSizeHigh` (6442450944); DOS time; `PK_SKIP`/`PK_TEST`/`PK_EXTRACT`; both
  `DestName` flavours (full path, and `DestPath`+`DestName`); abort through ProcessDataProc -> `E_EABORTED` with no file;
  `CloseArchive` on every branch (counter 0).
- Isolation: `abort()` (SIGABRT, 6) and a null write (SIGSEGV, 11) inside the plugin kill only the runner; the parent sees EOF
  plus the wait-status signal, later calls report the same, and a new runner process works.

## Findings that correct or refine the plan

- `WIN32_FIND_DATAW.cFileName` is `WCHAR[260]` (MAX_PATH), not 1024: sizeof is 592 with `pack(1)`; only the *path argument* may
  be 1023 characters long. Names longer than 259 UTF-16 units cannot be returned by a WFX.
- `tHeaderDataExW`: C header natural alignment puts `CmtBuf` at 4144 (struct 5192 bytes), the packed (Pascal/DC) flavour at 4140
  (5184). ANSI variant: 2096 vs 2092. Fields up to `FileAttr` are identical, so the runner reads only those and gives the plugin
  an 8192-byte zeroed buffer (larger than either flavour). Real plugins that write `CmtBuf` are not covered.
- Windows `SetLastError` does not exist on macOS. The spike signals an empty directory with `errno == 18`
  (numeric `ERROR_NO_MORE_FILES`); this convention is invented here and unverified for real plugins.

## NOT proven

- Status for these two plugins is **native (own spike)** only. Third-party plugin ecosystem remains **unverified**; no real
  plugin, no Pascal/FPC-built plugin, no Double Commander plugin was loaded.
- No Windows runner or Windows PE plugin was run (PE is only rejected).
- Assumed, not checked against a real host: `FsInitW` receives the W callback flavours; `FsSetCryptCallbackW` is called with
  `(proc, 1, 0)`; `PluginInterfaceVersion` 2.22; WCX `ChangeVol` is registered but never triggered; Request/Crypt callbacks
  are implemented but never invoked by the spike plugins (policy untested).
- ANSI-only plugins (no `FsInitW`) are refused (`AnsiOnlyUnsupported`); ANSI struct layout `WIN32_FIND_DATAA` is only
  measured (318), not exercised. Only `ReadHeaderExW` is used (no `ReadHeaderEx`/`ReadHeader`).
- Not covered: PackFiles/Put/Delete/Mkdir/Rename, WDX/WLX, multi-volume, encryption, resume, `FsStatusInfo` brackets,
  background flags other than 0 and thread safety of real plugins, dlclose with live threads, memory use, performance.
- Test timing: crash tests use the runner's own death only; a hang inside a plugin (no timeout/kill policy) is not tested.

## Conclusions for the runner architecture

- One OS process per plugin works and gives hard crash isolation at the cost of one pipe pair; the parent only needs
  EOF + wait status to produce a structured error, and restart is a fresh spawn (plugin state, open handles and
  `FsInit` must be replayed by the client).
- Serialize calls per runner (single request in flight). That satisfies `BackgroundFlags == 0` plugins; opt-in concurrency
  needs a second runner process, not threads in one.
- NDJSON JSON-RPC over stdio is enough; callbacks fit as notifications. Anything that needs an answer (progress cancel,
  request, crypt, ChangeVol) must either be pre-decided by a flag (as here) or the runner must read stdin inside the callback.
  The latter breaks "one request in flight" and needs a design decision.
- Keep ABI structs in a single place verified by sizeof/offsetof tests per ABI flavour; hand the plugin generously sized,
  zeroed buffers; always decode UTF-16 strictly.
- Always pair FindFirst/FindClose and OpenArchive/CloseArchive in the runner, including on error branches (tested).
- Plugin-side atomic output (`.part` + rename) is plugin behaviour, not guaranteed by TC; the host should not assume it.
- A timeout and kill policy for hung plugin calls is still needed (not in this spike).
