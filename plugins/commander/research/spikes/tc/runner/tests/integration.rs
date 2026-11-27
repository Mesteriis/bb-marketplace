//! Integration tests: spawn tc-runner as a child process, talk NDJSON JSON-RPC 2.0,
//! compare against LITERAL expected values (never recomputed by the code under test).
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Once;
use tc_runner::json::{self, obj, s, Value};

const TMP: &str = env!("CARGO_TARGET_TMPDIR");
const MANIFEST: &str = env!("CARGO_MANIFEST_DIR");

fn plugin_dir() -> PathBuf {
    static ONCE: Once = Once::new();
    let dir = Path::new(TMP).join("plugins");
    ONCE.call_once(|| {
        std::fs::create_dir_all(&dir).unwrap();
        let src = Path::new(MANIFEST).join("../plugins");
        for (file, out, arch) in [("spike_wfx.c", "spike.wfx", "arm64"), ("spike_wcx.c", "spike.wcx", "arm64"), ("spike_wfx.c", "spike_x86_64.wfx", "x86_64")] {
            let st = Command::new("/usr/bin/clang")
                .args(["-shared", "-arch", arch, "-fvisibility=hidden", "-Wall", "-Wextra", "-Werror", "-o"])
                .arg(dir.join(out)).arg(src.join(file)).status().expect("clang");
            assert!(st.success(), "clang failed for {file} ({arch})");
        }
    });
    dir
}
fn scratch(name: &str) -> PathBuf {
    let d = Path::new(TMP).join("scratch").join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[derive(Debug)]
enum CallErr {
    Rpc(Value),
    /// Runner process vanished: EOF on stdout. `signal` from the wait status.
    Died { signal: Option<i32>, code: Option<i32> },
}
impl CallErr {
    fn kind(&self) -> String {
        match self { CallErr::Rpc(e) => e.get("data").and_then(|d| d.get("kind")).and_then(Value::as_str).unwrap_or("").to_string(), CallErr::Died { .. } => "Died".into() }
    }
}

struct Rpc { child: Child, stdin: ChildStdin, out: BufReader<ChildStdout>, notes: Vec<Value>, id: i64 }
impl Rpc {
    fn spawn() -> Rpc {
        let mut child = Command::new(env!("CARGO_BIN_EXE_tc-runner")).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let out = BufReader::new(child.stdout.take().unwrap());
        Rpc { child, stdin, out, notes: vec![], id: 0 }
    }
    fn raw(&mut self, line: &str, id: i64) -> Result<Value, CallErr> {
        let died = |this: &mut Rpc| { let st = this.child.wait().unwrap(); CallErr::Died { signal: st.signal(), code: st.code() } };
        if writeln!(self.stdin, "{line}").and_then(|_| self.stdin.flush()).is_err() { return Err(died(self)); }
        loop {
            let mut buf = String::new();
            if self.out.read_line(&mut buf).unwrap() == 0 { return Err(died(self)); }
            let v = json::parse(buf.trim()).unwrap();
            if v.get("id").is_none() { self.notes.push(v); continue; }
            assert_eq!(v.get("id").and_then(Value::as_i64), Some(id));
            return match v.get("error") { Some(e) => Err(CallErr::Rpc(e.clone())), None => Ok(v.get("result").unwrap().clone()) };
        }
    }
    fn call(&mut self, method: &str, params: Vec<(&str, Value)>) -> Result<Value, CallErr> {
        self.id += 1;
        let line = obj(vec![("jsonrpc", s("2.0")), ("id", Value::Int(self.id)), ("method", s(method)), ("params", obj(params))]).encode();
        let id = self.id;
        self.raw(&line, id)
    }
    fn ok(&mut self, method: &str, params: Vec<(&str, Value)>) -> Value { self.call(method, params).unwrap_or_else(|e| panic!("{method} failed: {e:?}")) }
    fn err(&mut self, method: &str, params: Vec<(&str, Value)>) -> CallErr { self.call(method, params).expect_err("expected an error") }
    fn load(&mut self, file: &str, kind: &str) -> Result<Value, CallErr> {
        let p = plugin_dir().join(file);
        self.call("plugin.load", vec![("path", s(p.to_str().unwrap())), ("kind", s(kind))])
    }
    fn notes_of(&self, method: &str) -> Vec<&Value> { self.notes.iter().filter(|n| n.get("method").and_then(Value::as_str) == Some(method)).collect() }
}
impl Drop for Rpc { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }

fn int(v: i64) -> Value { Value::Int(v) }
fn names(v: &Value) -> Vec<String> { v.get("entries").unwrap().as_arr().unwrap().iter().map(|e| e.get("name").unwrap().as_str().unwrap().to_string()).collect() }
fn wfx_ready() -> Rpc {
    let mut r = Rpc::spawn();
    r.load("spike.wfx", "wfx").unwrap();
    r.ok("wfx.init", vec![]);
    r
}
fn path_str(p: &Path) -> Value { s(p.to_str().unwrap()) }

// ---------------------------------------------------------------- ABI layout
#[test]
fn layout_matches_literals() {
    // (key, expected). WIN32_FIND_DATAW: 44 bytes of header + 260*2 + 14*2 = 592, pack(1).
    let find: &[(&str, i64)] = &[
        ("WIN32_FIND_DATAW.size", 592), ("WIN32_FIND_DATAW.dwFileAttributes", 0), ("WIN32_FIND_DATAW.ftCreationTime", 4),
        ("WIN32_FIND_DATAW.ftLastAccessTime", 12), ("WIN32_FIND_DATAW.ftLastWriteTime", 20), ("WIN32_FIND_DATAW.nFileSizeHigh", 28),
        ("WIN32_FIND_DATAW.nFileSizeLow", 32), ("WIN32_FIND_DATAW.dwReserved0", 36), ("WIN32_FIND_DATAW.dwReserved1", 40),
        ("WIN32_FIND_DATAW.cFileName", 44), ("WIN32_FIND_DATAW.cAlternateFileName", 564), ("WIN32_FIND_DATAA.size", 318),
        ("RemoteInfoStruct.size", 20), ("RemoteInfoStruct.Attr", 16), ("FsDefaultParamStruct.size", 272), ("FsDefaultParamStruct.DefaultIniName", 12),
    ];
    // tHeaderDataExW (UTF-16 names, 2*2048 bytes), natural alignment vs packed: CmtBuf 4144 vs 4140
    let wcx: &[(&str, i64)] = &[
        ("tHeaderDataExW.Flags", 4096), ("tHeaderDataExW.PackSize", 4100), ("tHeaderDataExW.PackSizeHigh", 4104), ("tHeaderDataExW.UnpSize", 4108),
        ("tHeaderDataExW.UnpSizeHigh", 4112), ("tHeaderDataExW.HostOS", 4116), ("tHeaderDataExW.FileCRC", 4120), ("tHeaderDataExW.FileTime", 4124),
        ("tHeaderDataExW.UnpVer", 4128), ("tHeaderDataExW.Method", 4132), ("tHeaderDataExW.FileAttr", 4136), ("tHeaderDataExW.CmtBuf", 4144),
        ("tHeaderDataExW.CmtBufSize", 4152), ("tHeaderDataExW.CmtSize", 4156), ("tHeaderDataExW.CmtState", 4160), ("tHeaderDataExW.Reserved", 4164),
        ("tHeaderDataExW.size", 5192),
        ("tHeaderDataExW.packed.Flags", 4096), ("tHeaderDataExW.packed.PackSize", 4100), ("tHeaderDataExW.packed.UnpSizeHigh", 4112),
        ("tHeaderDataExW.packed.FileAttr", 4136), ("tHeaderDataExW.packed.CmtBuf", 4140), ("tHeaderDataExW.packed.CmtBufSize", 4148),
        ("tHeaderDataExW.packed.CmtSize", 4152), ("tHeaderDataExW.packed.CmtState", 4156), ("tHeaderDataExW.packed.Reserved", 4160),
        ("tHeaderDataExW.packed.size", 5184),
        // ANSI tHeaderDataEx (char names): 11 ints end at 2092; natural CmtBuf 2096, packed 2092
        ("tHeaderDataEx.Flags", 2048), ("tHeaderDataEx.FileAttr", 2088), ("tHeaderDataEx.CmtBuf", 2096), ("tHeaderDataEx.Reserved", 2116), ("tHeaderDataEx.size", 3144),
        ("tHeaderDataEx.packed.FileAttr", 2088), ("tHeaderDataEx.packed.CmtBuf", 2092), ("tHeaderDataEx.packed.Reserved", 2112), ("tHeaderDataEx.packed.size", 3136),
        ("tOpenArchiveDataW.size", 40), ("tOpenArchiveDataW.OpenMode", 8), ("tOpenArchiveDataW.OpenResult", 12), ("tOpenArchiveDataW.CmtBuf", 16),
        ("tOpenArchiveDataW.packed.size", 36),
    ];
    let mut r = Rpc::spawn();
    r.load("spike.wfx", "wfx").unwrap();
    for (k, want) in find { assert_eq!(r.ok("plugin.layout", vec![("key", s(k))]), int(*want), "plugin(wfx) {k}"); }
    let runner_view = r.ok("abi.layout", vec![]);
    // (the runner has no ANSI find-data struct; the W-only path is all it supports)
    for (k, want) in find.iter().filter(|(k, _)| !k.contains("DATAA")) { assert_eq!(runner_view.get(k), Some(&int(*want)), "runner {k}"); }
    let mut r = Rpc::spawn();
    r.load("spike.wcx", "wcx").unwrap();
    for (k, want) in wcx { assert_eq!(r.ok("plugin.layout", vec![("key", s(k))]), int(*want), "plugin(wcx) {k}"); }
    // the runner's own (packed) view of the same structs; its OpenArchiveData is natural
    for (k, want) in wcx.iter().filter(|(k, _)| k.starts_with("tHeaderDataExW.packed.") || (k.starts_with("tOpenArchiveDataW.") && !k.contains("packed"))) {
        assert_eq!(runner_view.get(k), Some(&int(*want)), "runner {k}");
    }
}

// ---------------------------------------------------------------- WFX
#[test]
fn wfx_exports_w_path_listing_and_big_size() {
    let mut r = Rpc::spawn();
    assert_eq!(r.load("spike.wfx", "wfx").unwrap().get("kind").unwrap().as_str(), Some("wfx"));
    let ex = r.ok("plugin.exports", vec![]);
    let found: Vec<&str> = ex.get("found").unwrap().as_arr().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(found, ["FsInit", "FsInitW", "FsFindFirst", "FsFindFirstW", "FsFindNext", "FsFindNextW", "FsFindClose", "FsGetFile", "FsGetFileW", "FsGetDefRootName", "FsSetDefaultParams", "FsGetBackgroundFlags"]);
    assert_eq!(ex.get("missing").unwrap().as_arr().unwrap().iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>(), ["FsSetCryptCallbackW"]);
    assert_eq!(ex.get("selectedVariant").unwrap().as_str(), Some("W"));

    let init = r.ok("wfx.init", vec![]);
    assert_eq!(init.get("variant").unwrap().as_str(), Some("W"));
    assert_eq!(init.get("rootName").unwrap().as_str(), Some("Spike VFS"));
    assert_eq!(init.get("pluginNr"), Some(&int(1)));
    assert_eq!(init.get("backgroundFlags"), Some(&int(0)));
    let logs: Vec<String> = r.notes_of("log").iter().map(|n| n.get("params").unwrap().get("message").unwrap().as_str().unwrap().to_string()).collect();
    assert!(logs.contains(&"spike.wfx initialised, plugin 1".to_string()), "{logs:?}");
    assert!(logs.contains(&"defaults size=272 ver=2.22 ini=/tmp/spike-wfx.ini".to_string()), "{logs:?}");

    let root = r.ok("wfx.list", vec![("path", s("\\"))]);
    assert_eq!(names(&root), ["readme.txt", "Привет.txt", "😀 emoji.bin", "subdir", "huge.bin"]);
    let e = root.get("entries").unwrap().as_arr().unwrap();
    let big = &e[4];
    assert_eq!(big.get("size"), Some(&int(5368709120)));
    assert_eq!(big.get("sizeHigh"), Some(&int(1)));
    assert_eq!(big.get("sizeLow"), Some(&int(1073741824)));
    assert_eq!(big.get("mtime"), Some(&Value::Null)); // 0xFFFFFFFF:0xFFFFFFFE = "no time"
    assert_eq!(e[0].get("size"), Some(&int(11)));
    assert_eq!(e[0].get("mtime"), Some(&int(133541154100000000)));
    assert_eq!(e[0].get("unixMode"), Some(&int(0o100644)));
    assert_eq!(e[0].get("attr"), Some(&int(0x80)));
    assert_eq!(e[1].get("size"), Some(&int(22)));
    assert_eq!(e[2].get("size"), Some(&int(4)));
    assert_eq!(e[3].get("isDir"), Some(&Value::Bool(true)));
    assert_eq!(e[3].get("attr"), Some(&int(0x10)));
    assert_eq!(e[3].get("unixMode"), None);

    assert_eq!(names(&r.ok("wfx.list", vec![("path", s("\\subdir"))])), ["inner.txt", "nested"]);
    assert_eq!(names(&r.ok("wfx.list", vec![("path", s("\\subdir\\nested"))])), ["deep.txt"]);
    assert_eq!(names(&r.ok("wfx.list", vec![("path", s("\\empty"))])), Vec::<String>::new()); // INVALID_HANDLE_VALUE + errno 18
    let nf = r.err("wfx.list", vec![("path", s("\\nope"))]);
    assert_eq!(nf.kind(), "FsFindFirstFailed");
    if let CallErr::Rpc(e) = &nf { assert_eq!(e.get("data").unwrap().get("errno"), Some(&int(2))); }
    // an unpaired surrogate coming from the plugin is an error, never U+FFFD
    assert_eq!(r.err("wfx.list", vec![("path", s("\\badnames"))]).kind(), "BadUtf16");

    // several FindFirst handles open at once (parent handle stays open while children are listed)
    let tree = r.ok("wfx.tree", vec![("path", s("\\"))]);
    let paths: Vec<&str> = tree.get("paths").unwrap().as_arr().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(paths, ["\\readme.txt", "\\Привет.txt", "\\😀 emoji.bin", "\\subdir", "\\subdir\\inner.txt", "\\subdir\\nested", "\\subdir\\nested\\deep.txt", "\\huge.bin"]);

    // no leaked handles on any branch (ok, empty, error, bad name), and the ANSI entry points were never used
    let st = r.ok("plugin.stat", vec![]);
    assert_eq!(st.get("openHandles"), Some(&int(0)));
    assert_eq!(st.get("ansiCalls"), Some(&int(0)));
    assert_eq!(r.ok("plugin.unload", vec![]).get("dlclose"), Some(&int(0)));
    assert_eq!(r.err("wfx.list", vec![("path", s("\\"))]).kind(), "NotLoaded");
}

#[test]
fn wfx_get_file_two_stage_exists_then_overwrite() {
    let dir = scratch("getfile");
    let mut r = wfx_ready();
    let local = dir.join("out.txt");
    std::fs::write(&local, "old").unwrap();
    let first = r.ok("wfx.getFile", vec![("remote", s("\\readme.txt")), ("local", path_str(&local))]);
    assert_eq!((first.get("code"), first.get("codeName").and_then(Value::as_str)), (Some(&int(1)), Some("FS_FILE_EXISTS")));
    assert_eq!(std::fs::read_to_string(&local).unwrap(), "old");
    let second = r.ok("wfx.getFile", vec![("remote", s("\\readme.txt")), ("local", path_str(&local)), ("overwrite", Value::Bool(true))]);
    assert_eq!((second.get("code"), second.get("codeName").and_then(Value::as_str)), (Some(&int(0)), Some("FS_FILE_OK")));
    assert_eq!(std::fs::read(&local).unwrap(), b"Hello, TC!\n");
    // ProgressProc: at least start and end, here 0/50/100
    let pct: Vec<i64> = r.notes_of("progress").iter().map(|n| n.get("params").unwrap().get("percent").unwrap().as_i64().unwrap()).collect();
    assert_eq!(pct, [0, 50, 100]);
    let p = r.notes_of("progress")[0].get("params").unwrap().clone();
    assert_eq!(p.get("src").unwrap().as_str(), Some("\\readme.txt"));
    assert_eq!(p.get("dst").unwrap().as_str(), local.to_str());

    // Cyrillic / emoji names, local path with surrogate pair
    let cyr = dir.join("файл 😀.txt");
    assert_eq!(r.ok("wfx.getFile", vec![("remote", s("\\Привет.txt")), ("local", path_str(&cyr))]).get("code"), Some(&int(0)));
    assert_eq!(std::fs::read(&cyr).unwrap(), "Привет, мир!\n".as_bytes());
    assert_eq!(std::fs::read(&cyr).unwrap().len(), 22);
    let em = dir.join("emoji.bin");
    assert_eq!(r.ok("wfx.getFile", vec![("remote", s("\\😀 emoji.bin")), ("local", path_str(&em))]).get("code"), Some(&int(0)));
    assert_eq!(std::fs::read(&em).unwrap(), [0xDE, 0xAD, 0xBE, 0xEF]);
    // the same remote name sent as a JSON \u surrogate-pair escape
    let em2 = dir.join("emoji2.bin");
    let line = format!(r#"{{"jsonrpc":"2.0","id":900,"method":"wfx.getFile","params":{{"remote":"\\😀 emoji.bin","local":{}}}}}"#, path_str(&em2).encode());
    assert_eq!(r.raw(&line, 900).unwrap().get("code"), Some(&int(0)));
    assert_eq!(std::fs::read(&em2).unwrap(), [0xDE, 0xAD, 0xBE, 0xEF]);
    // nested path, metadata-only huge file, missing file
    let inner = dir.join("inner.txt");
    assert_eq!(r.ok("wfx.getFile", vec![("remote", s("\\subdir\\inner.txt")), ("local", path_str(&inner))]).get("code"), Some(&int(0)));
    assert_eq!(std::fs::read(&inner).unwrap(), b"inner\n");
    assert_eq!(r.ok("wfx.getFile", vec![("remote", s("\\huge.bin")), ("local", path_str(&dir.join("huge")))]).get("code"), Some(&int(6)));
    assert_eq!(r.ok("wfx.getFile", vec![("remote", s("\\missing")), ("local", path_str(&dir.join("m")))]).get("code"), Some(&int(2)));
    assert!(!dir.join("huge").exists() && !dir.join("m").exists());
}

#[test]
fn wfx_cancel_via_progress_gives_userabort_and_no_partial_file() {
    let dir = scratch("cancel");
    let mut r = wfx_ready();
    let fresh = dir.join("fresh.txt");
    let c = r.ok("wfx.getFile", vec![("remote", s("\\readme.txt")), ("local", path_str(&fresh)), ("cancelAtPercent", int(50))]);
    assert_eq!((c.get("code"), c.get("codeName").and_then(Value::as_str)), (Some(&int(5)), Some("FS_FILE_USERABORT")));
    assert!(!fresh.exists(), "partial file left behind");
    assert!(!dir.join("fresh.txt.part").exists(), "temp file left behind");
    let last = r.notes_of("progress").last().unwrap().get("params").unwrap().clone();
    assert_eq!((last.get("percent"), last.get("cancel")), (Some(&int(50)), Some(&Value::Bool(true))));
    // cancel already at 0%: nothing is created
    let c0 = r.ok("wfx.getFile", vec![("remote", s("\\readme.txt")), ("local", path_str(&fresh)), ("cancelAtPercent", int(0))]);
    assert_eq!(c0.get("code"), Some(&int(5)));
    assert!(!fresh.exists());
    // overwrite + cancel keeps the previous content intact
    let old = dir.join("old.txt");
    std::fs::write(&old, "old").unwrap();
    let c2 = r.ok("wfx.getFile", vec![("remote", s("\\readme.txt")), ("local", path_str(&old)), ("overwrite", Value::Bool(true)), ("cancelAtPercent", int(50))]);
    assert_eq!(c2.get("code"), Some(&int(5)));
    assert_eq!(std::fs::read_to_string(&old).unwrap(), "old");
    assert!(!dir.join("old.txt.part").exists());
    let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    left.sort();
    assert_eq!(left, ["old.txt"]);
}

#[test]
fn protocol_errors_are_structured() {
    // Request/Crypt callbacks are never invoked by the spike plugins, so refusal policy is NOT exercised here.
    let mut r = wfx_ready();
    match r.err("nope.method", vec![]) { CallErr::Rpc(e) => assert_eq!(e.get("code"), Some(&int(-32601))), d => panic!("{d:?}") }
    for bad in ["{not json", r#"{"jsonrpc":"2.0","id":1,"method":"x","params":{"a":"\ud83d"}}"#] {
        writeln!(r.stdin, "{bad}").unwrap();
        r.stdin.flush().unwrap();
        let mut line = String::new();
        r.out.read_line(&mut line).unwrap();
        let v = json::parse(line.trim()).unwrap();
        assert_eq!(v.get("error").unwrap().get("code"), Some(&int(-32700)), "{bad}");
        assert_eq!(v.get("id"), Some(&Value::Null));
    }
    // still alive afterwards
    assert_eq!(names(&r.ok("wfx.list", vec![("path", s("\\subdir"))])), ["inner.txt", "nested"]);
}

// ---------------------------------------------------------------- WCX
#[test]
fn wcx_list_extract_test_abort() {
    let dir = scratch("wcx");
    let arc = dir.join("any.bin");
    std::fs::write(&arc, "not really an archive").unwrap();
    let mut r = Rpc::spawn();
    r.load("spike.wcx", "wcx").unwrap();
    let ex = r.ok("plugin.exports", vec![]);
    let found: Vec<&str> = ex.get("found").unwrap().as_arr().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(found, ["OpenArchive", "OpenArchiveW", "ReadHeader", "ReadHeaderEx", "ReadHeaderExW", "ProcessFile", "ProcessFileW", "CloseArchive", "SetProcessDataProcW", "SetChangeVolProcW", "GetPackerCaps", "GetBackgroundFlags"]);
    assert_eq!(ex.get("selectedVariant").unwrap().as_str(), Some("W"));

    let l = r.ok("wcx.list", vec![("archive", path_str(&arc))]);
    let es = l.get("entries").unwrap().as_arr().unwrap();
    let col = |k: &str| es.iter().map(|e| e.get(k).unwrap().clone()).collect::<Vec<_>>();
    assert_eq!(col("name"), [s("hello.txt"), s("каталог\\Привет 😀.txt"), s("big.bin")]);
    assert_eq!(col("unpSize"), [int(15), int(13), int(6442450944)]);
    assert_eq!(col("packSize"), [int(15), int(13), int(4294967296)]);
    assert_eq!(col("crc"), [int(4369), int(8738), int(13107)]);
    assert_eq!(col("attr"), [int(32), int(32), int(32)]);
    assert_eq!(col("fileTime"), [int(1483039685), int(1483039685), int(1483039685)]); // 2024-03-05 12:30:10 as DOS time
    assert_eq!(l.get("packerCaps"), Some(&int(68))); // MULTIPLE|BY_CONTENT, no NEW/MODIFY => read-only
    assert_eq!(l.get("backgroundFlags"), Some(&int(0)));

    // extract with DestName = full path (DestPath NULL)
    let out1 = dir.join("hello.out");
    let x = r.ok("wcx.extract", vec![("archive", path_str(&arc)), ("name", s("hello.txt")), ("dest", path_str(&out1))]);
    assert_eq!((x.get("code"), x.get("codeName").and_then(Value::as_str)), (Some(&int(0)), Some("OK")));
    assert_eq!(std::fs::read(&out1).unwrap(), b"Hello from WCX\n");
    let sizes: Vec<i64> = r.notes_of("progress").iter().map(|n| n.get("params").unwrap().get("size").unwrap().as_i64().unwrap()).collect();
    assert_eq!(sizes, [7, 8]);
    // extract with DestPath + DestName split
    let out2 = dir.join("файл 😀.out");
    r.ok("wcx.extract", vec![("archive", path_str(&arc)), ("name", s("каталог\\Привет 😀.txt")), ("dest", path_str(&out2)), ("split", Value::Bool(true))]);
    assert_eq!(std::fs::read(&out2).unwrap(), "Привет\n".as_bytes());
    // PK_TEST writes nothing
    let out3 = dir.join("test.out");
    assert_eq!(r.ok("wcx.extract", vec![("archive", path_str(&arc)), ("name", s("hello.txt")), ("dest", path_str(&out3)), ("test", Value::Bool(true))]).get("code"), Some(&int(0)));
    assert!(!out3.exists());
    // abort through ProcessDataProc -> E_EABORTED, no partial file
    let out4 = dir.join("abort.out");
    let a = r.ok("wcx.extract", vec![("archive", path_str(&arc)), ("name", s("hello.txt")), ("dest", path_str(&out4)), ("abortAfterBytes", int(1))]);
    assert_eq!((a.get("code"), a.get("codeName").and_then(Value::as_str)), (Some(&int(21)), Some("E_EABORTED")));
    assert!(!out4.exists() && !dir.join("abort.out.part").exists());
    let last = r.notes_of("progress").last().unwrap().get("params").unwrap().clone();
    assert_eq!((last.get("size"), last.get("abort")), (Some(&int(7)), Some(&Value::Bool(true))));
    // abort on the second callback: the already renamed file is removed again
    let out5 = dir.join("abort2.out");
    assert_eq!(r.ok("wcx.extract", vec![("archive", path_str(&arc)), ("name", s("hello.txt")), ("dest", path_str(&out5)), ("abortAfterBytes", int(15))]).get("code"), Some(&int(21)));
    assert!(!out5.exists());
    // metadata-only >4 GiB entry, unknown entry, missing archive
    assert_eq!(r.ok("wcx.extract", vec![("archive", path_str(&arc)), ("name", s("big.bin")), ("dest", path_str(&dir.join("big")))]).get("code"), Some(&int(24)));
    assert_eq!(r.err("wcx.extract", vec![("archive", path_str(&arc)), ("name", s("zzz")), ("dest", path_str(&dir.join("z")))]).kind(), "NotInArchive");
    match r.err("wcx.list", vec![("archive", path_str(&dir.join("missing.bin")))]) {
        CallErr::Rpc(e) => { let d = e.get("data").unwrap(); assert_eq!((d.get("kind").and_then(Value::as_str), d.get("code")), (Some("OpenArchiveFailed"), Some(&int(15)))); }
        d => panic!("{d:?}"),
    }
    // CloseArchive ran on every branch; ANSI stubs never used
    let st = r.ok("plugin.stat", vec![]);
    assert_eq!((st.get("openArchives"), st.get("ansiCalls")), (Some(&int(0)), Some(&int(0))));
}

// ---------------------------------------------------------------- loading policy
#[test]
fn load_rejects_foreign_and_wrong_binaries() {
    let dir = scratch("reject");
    let mz = dir.join("fake.wfx");
    let mut bytes = b"MZ\x90\x00\x03\x00\x00\x00".to_vec();
    bytes.resize(512, 0);
    std::fs::write(&mz, &bytes).unwrap();
    let txt = dir.join("text.wfx");
    std::fs::write(&txt, "just text, definitely not a library").unwrap();
    let elf = dir.join("elf.wfx");
    std::fs::write(&elf, b"\x7fELF\x02\x01\x01\x00rest").unwrap();
    let mut r = Rpc::spawn();
    let e = r.call("plugin.load", vec![("path", path_str(&mz)), ("kind", s("wfx"))]).unwrap_err();
    assert_eq!(e.kind(), "PeRejected");
    if let CallErr::Rpc(e) = &e { assert!(e.get("message").unwrap().as_str().unwrap().contains("Windows PE")); }
    assert_eq!(r.call("plugin.load", vec![("path", path_str(&txt)), ("kind", s("wfx"))]).unwrap_err().kind(), "UnknownFormat");
    assert_eq!(r.call("plugin.load", vec![("path", path_str(&elf)), ("kind", s("wfx"))]).unwrap_err().kind(), "ElfRejected");
    assert_eq!(r.load("spike_x86_64.wfx", "wfx").unwrap_err().kind(), "WrongArch");
    assert_eq!(r.call("plugin.load", vec![("path", path_str(&dir.join("absent.wfx"))), ("kind", s("wfx"))]).unwrap_err().kind(), "OpenFailed");
    // a valid Mach-O of the wrong kind: dlopen succeeds, minimal exports missing -> rejected and unloaded
    assert_eq!(r.load("spike.wcx", "wfx").unwrap_err().kind(), "MissingExports");
    // none of the failures poisoned the runner
    assert!(r.load("spike.wfx", "wfx").is_ok());
    assert_eq!(r.load("spike.wfx", "wfx").unwrap_err().kind(), "AlreadyLoaded");
}

// ---------------------------------------------------------------- isolation
#[test]
fn plugin_crash_kills_only_the_runner_and_restart_works() {
    for (path, signal) in [("\\crash", 6), ("\\segv", 11)] {
        let mut r = wfx_ready();
        assert_eq!(names(&r.ok("wfx.list", vec![("path", s("\\subdir"))])), ["inner.txt", "nested"]);
        match r.err("wfx.list", vec![("path", s(path))]) {
            CallErr::Died { signal: sig, code } => assert_eq!((sig, code), (Some(signal), None), "{path}"),
            other => panic!("{other:?}"),
        }
        // the runner is gone for good: later calls also report Died, not a hang
        assert_eq!(r.err("wfx.list", vec![("path", s("\\"))]).kind(), "Died");
        // a fresh runner (new process) works
        let mut fresh = wfx_ready();
        assert_eq!(names(&fresh.ok("wfx.list", vec![("path", s("\\"))])), ["readme.txt", "Привет.txt", "😀 emoji.bin", "subdir", "huge.bin"]);
    }
}
