//! tc-runner: hosts ONE Total Commander plugin (WFX or WCX) in this process and speaks
//! JSON-RPC 2.0 over stdio, one JSON message per line (NDJSON). See ../README.md.
//! Calls into the plugin are strictly sequential (single thread, one request at a time).
//! No external crates: dlopen/dlsym/dlclose/dlerror come from libSystem.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::io::{BufRead, Read, Write};
use std::mem::{offset_of, size_of, zeroed};
use std::sync::atomic::{AtomicI32, AtomicI64, Ordering};
use tc_runner::json::{self, obj, s, Value};

extern "C" {
    fn dlopen(path: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
    fn dlclose(handle: *mut c_void) -> c_int;
    fn dlerror() -> *mut c_char;
    fn __error() -> *mut c_int; // errno location on macOS
}
const RTLD_NOW: c_int = 2;
const RTLD_LOCAL: c_int = 4;

// ---- own ABI definitions, derived from the SDK docs (not from SDK/DC headers) ----
#[repr(C, packed)]
#[derive(Clone, Copy)]
struct FileTime { lo: u32, hi: u32 }
#[repr(C, packed)]
#[derive(Clone, Copy)]
struct FindDataW {
    attr: u32, ctime: FileTime, atime: FileTime, mtime: FileTime,
    size_high: u32, size_low: u32, res0: u32, res1: u32,
    name: [u16; 260], alt: [u16; 14],
}
#[repr(C, packed)]
struct RemoteInfo { size_low: u32, size_high: u32, mtime: FileTime, attr: i32 }
#[repr(C, packed)]
struct DefaultParams { size: i32, ver_low: u32, ver_hi: u32, ini: [u8; 260] }
#[repr(C, packed)]
struct HeaderDataExW {
    arc_name: [u16; 1024], file_name: [u16; 1024], flags: i32,
    pack_size: u32, pack_size_high: u32, unp_size: u32, unp_size_high: u32,
    host_os: i32, file_crc: i32, file_time: i32, unp_ver: i32, method: i32, file_attr: i32,
    cmt_buf: *mut u16, cmt_buf_size: i32, cmt_size: i32, cmt_state: i32, reserved: [u8; 1024],
}
#[repr(C)]
struct OpenArchiveDataW {
    arc_name: *const u16, open_mode: i32, open_result: i32,
    cmt_buf: *mut u16, cmt_buf_size: i32, cmt_size: i32, cmt_state: i32,
}

type ProgressW = extern "C" fn(i32, *const u16, *const u16, i32) -> i32;
type LogW = extern "C" fn(i32, i32, *const u16);
type RequestW = extern "C" fn(i32, i32, *const u16, *const u16, *mut u16, i32) -> i32;
type CryptW = extern "C" fn(i32, i32, i32, *const u16, *mut u16, i32) -> i32;
type ProcDataW = extern "C" fn(*const u16, i32) -> i32;
type ChangeVolW = extern "C" fn(*const u16, i32) -> i32;
type FsInitW = extern "C" fn(i32, ProgressW, LogW, RequestW) -> i32;
type FsSetCryptW = extern "C" fn(CryptW, i32, i32);
type FsFindFirstW = extern "C" fn(*const u16, *mut FindDataW) -> isize;
type FsFindNextW = extern "C" fn(isize, *mut FindDataW) -> i32;
type FsFindClose = extern "C" fn(isize) -> i32;
type FsGetFileW = extern "C" fn(*const u16, *const u16, i32, *const RemoteInfo) -> i32;
type FsDefRoot = extern "C" fn(*mut c_char, i32);
type FsSetDefaults = extern "C" fn(*const DefaultParams);
type IntFn = extern "C" fn() -> i32;
type OpenArchiveW = extern "C" fn(*mut OpenArchiveDataW) -> isize;
type ReadHeaderExW = extern "C" fn(isize, *mut u8) -> i32;
type ProcessFileW = extern "C" fn(isize, i32, *const u16, *const u16) -> i32;
type CloseArchive = extern "C" fn(isize) -> i32;
type SetProcDataW = extern "C" fn(isize, ProcDataW);
type SetChangeVolW = extern "C" fn(isize, ChangeVolW);
type LayoutFn = extern "C" fn(*const c_char) -> i64;

const PLUGIN_NR: i32 = 1;
const ERROR_NO_MORE_FILES: i32 = 18; // convention for "empty directory" without SetLastError (see README)
static CANCEL_PERCENT: AtomicI32 = AtomicI32::new(-1);
static WCX_ABORT_AFTER: AtomicI64 = AtomicI64::new(-1);
static WCX_PROCESSED: AtomicI64 = AtomicI64::new(0);

// ---- output ----
fn emit(v: &Value) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{}", v.encode());
    let _ = o.flush();
}
fn notify(method: &str, params: Value) {
    emit(&obj(vec![("jsonrpc", s("2.0")), ("method", s(method)), ("params", params)]));
}

// ---- errors ----
struct RpcErr { code: i64, message: String, data: Value }
fn rerr(kind: &str, msg: impl Into<String>) -> RpcErr {
    RpcErr { code: -32000, message: msg.into(), data: obj(vec![("kind", s(kind))]) }
}
fn rerr_with(kind: &str, msg: impl Into<String>, extra: Vec<(&str, Value)>) -> RpcErr {
    let mut items = vec![("kind", s(kind))];
    items.extend(extra);
    RpcErr { code: -32000, message: msg.into(), data: obj(items) }
}
fn invalid(msg: impl Into<String>) -> RpcErr { RpcErr { code: -32602, message: msg.into(), data: Value::Null } }

// ---- UTF-16 <-> UTF-8: strict, no silent replacement ----
fn to_w(text: &str) -> Vec<u16> { text.encode_utf16().chain(std::iter::once(0)).collect() }
fn from_w_slice(w: &[u16]) -> Result<String, RpcErr> {
    let end = w.iter().position(|&c| c == 0).ok_or_else(|| rerr("BadUtf16", "string is not NUL-terminated"))?;
    String::from_utf16(&w[..end]).map_err(|_| rerr("BadUtf16", "unpaired surrogate in UTF-16 string"))
}
unsafe fn from_w_ptr(p: *const u16) -> Result<String, RpcErr> {
    if p.is_null() { return Ok(String::new()); }
    let mut n = 0;
    while *p.add(n) != 0 { n += 1; if n > 1 << 16 { return Err(rerr("BadUtf16", "unterminated callback string")); } }
    String::from_utf16(std::slice::from_raw_parts(p, n)).map_err(|_| rerr("BadUtf16", "unpaired surrogate in callback string"))
}
fn cb_str(p: *const u16) -> Value {
    match unsafe { from_w_ptr(p) } { Ok(t) => Value::Str(t), Err(_) => Value::Null }
}

// ---- callbacks (plugin -> runner) ----
extern "C" fn progress_w(nr: i32, src: *const u16, dst: *const u16, percent: i32) -> i32 {
    let cancel_at = CANCEL_PERCENT.load(Ordering::SeqCst);
    let cancel = cancel_at >= 0 && percent >= cancel_at;
    notify("progress", obj(vec![
        ("kind", s("wfx")), ("pluginNr", Value::Int(nr as i64)), ("src", cb_str(src)), ("dst", cb_str(dst)),
        ("percent", Value::Int(percent as i64)), ("cancel", Value::Bool(cancel)),
    ]));
    cancel as i32
}
extern "C" fn log_w(nr: i32, msg_type: i32, msg: *const u16) {
    notify("log", obj(vec![("pluginNr", Value::Int(nr as i64)), ("type", Value::Int(msg_type as i64)), ("message", cb_str(msg))]));
}
extern "C" fn request_w(nr: i32, rt: i32, title: *const u16, text: *const u16, _ret: *mut u16, _max: i32) -> i32 {
    notify("request", obj(vec![
        ("pluginNr", Value::Int(nr as i64)), ("requestType", Value::Int(rt as i64)),
        ("title", cb_str(title)), ("text", cb_str(text)), ("denied", Value::Bool(true)),
    ]));
    0 // FALSE: no UI, request refused
}
extern "C" fn crypt_w(nr: i32, crypto_nr: i32, mode: i32, conn: *const u16, _pw: *mut u16, _max: i32) -> i32 {
    notify("crypt", obj(vec![
        ("pluginNr", Value::Int(nr as i64)), ("cryptoNr", Value::Int(crypto_nr as i64)),
        ("mode", Value::Int(mode as i64)), ("connection", cb_str(conn)), ("denied", Value::Bool(true)),
    ]));
    6 // FS_FILE_NOTSUPPORTED
}
extern "C" fn process_data_w(name: *const u16, size: i32) -> i32 {
    let limit = WCX_ABORT_AFTER.load(Ordering::SeqCst);
    let total = if size > 0 { WCX_PROCESSED.fetch_add(size as i64, Ordering::SeqCst) + size as i64 } else { WCX_PROCESSED.load(Ordering::SeqCst) };
    let abort = limit >= 0 && total >= limit;
    notify("progress", obj(vec![
        ("kind", s("wcx")), ("file", cb_str(name)), ("size", Value::Int(size as i64)),
        ("total", Value::Int(total)), ("abort", Value::Bool(abort)),
    ]));
    if abort { 0 } else { 1 } // 0 = user aborted
}
extern "C" fn change_vol_w(arc: *const u16, mode: i32) -> i32 {
    notify("log", obj(vec![("message", s("changeVol refused")), ("archive", cb_str(arc)), ("mode", Value::Int(mode as i64))]));
    0
}

// ---- dynamic library ----
#[derive(Clone, Copy)]
struct Lib(*mut c_void);
impl Lib {
    fn sym<T: Copy>(&self, name: &str) -> Option<T> {
        assert_eq!(size_of::<T>(), size_of::<*mut c_void>());
        let c = CString::new(name).ok()?;
        let p = unsafe { dlsym(self.0, c.as_ptr()) };
        if p.is_null() { None } else { Some(unsafe { std::mem::transmute_copy::<*mut c_void, T>(&p) }) }
    }
    fn req<T: Copy>(&self, name: &str) -> Result<T, RpcErr> {
        self.sym(name).ok_or_else(|| rerr("MissingExport", format!("plugin does not export {name}")))
    }
}
fn errno() -> i32 { unsafe { *__error() } }
fn set_errno(v: i32) { unsafe { *__error() = v } }

#[derive(Clone, Copy, PartialEq)]
enum Kind { Wfx, Wcx }
struct Loaded { lib: Lib, kind: Kind, path: String }

const WFX_NAMES: &[&str] = &["FsInit", "FsInitW", "FsFindFirst", "FsFindFirstW", "FsFindNext", "FsFindNextW", "FsFindClose",
    "FsGetFile", "FsGetFileW", "FsGetDefRootName", "FsSetDefaultParams", "FsSetCryptCallbackW", "FsGetBackgroundFlags"];
const WCX_NAMES: &[&str] = &["OpenArchive", "OpenArchiveW", "ReadHeader", "ReadHeaderEx", "ReadHeaderExW", "ProcessFile", "ProcessFileW",
    "CloseArchive", "SetProcessDataProc", "SetProcessDataProcW", "SetChangeVolProc", "SetChangeVolProcW", "GetPackerCaps", "GetBackgroundFlags"];

/// Binary check before dlopen: Mach-O arm64 dylib/bundle only.
fn check_binary(path: &str) -> Result<(), RpcErr> {
    let mut f = std::fs::File::open(path).map_err(|e| rerr("OpenFailed", format!("cannot open {path}: {e}")))?;
    let mut buf = vec![0u8; 1200];
    let n = f.read(&mut buf).map_err(|e| rerr("OpenFailed", e.to_string()))?;
    let b = &buf[..n];
    if b.len() < 4 { return Err(rerr("UnknownFormat", "file too short to be a plugin binary")); }
    if b.starts_with(b"MZ") { return Err(rerr("PeRejected", "Windows PE binary (MZ header): cannot be loaded on macOS arm64; needs a Windows runner")); }
    if b.starts_with(b"\x7fELF") { return Err(rerr("ElfRejected", "ELF binary: cannot be loaded on macOS")); }
    let le = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    let be = |o: usize| u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    const ARM64: u32 = 0x0100000C;
    match le(0) {
        0xFEEDFACF if b.len() >= 16 => {
            let (cpu, ft) = (le(4), le(12));
            if cpu != ARM64 { return Err(rerr_with("WrongArch", format!("Mach-O cputype {cpu:#x}, need arm64 ({ARM64:#x})"), vec![("cputype", Value::Int(cpu as i64))])); }
            if ft != 6 && ft != 8 { return Err(rerr("NotLibrary", format!("Mach-O filetype {ft}, need dylib(6) or bundle(8)"))); }
            return Ok(());
        }
        0xFEEDFACE | 0xFEEDFACF => return Err(rerr("WrongArch", "32-bit or truncated Mach-O")),
        _ => {}
    }
    match be(0) {
        0xCAFEBABE | 0xCAFEBABF => {
            let stride = if be(0) == 0xCAFEBABE { 20 } else { 32 };
            let count = be(4) as usize;
            if count == 0 || count > 16 || 8 + count * stride > b.len() { return Err(rerr("UnknownFormat", "bad fat Mach-O header")); }
            if (0..count).any(|i| be(8 + i * stride) == ARM64) { Ok(()) } else { Err(rerr("WrongArch", "fat Mach-O has no arm64 slice")) }
        }
        _ => Err(rerr("UnknownFormat", "not a Mach-O file")),
    }
}

// ---- WFX directory walking ----
struct Entry { name: String, attr_raw: u32, hi: u32, lo: u32, mtime: Value, mode: u32 }
impl Entry {
    fn from(fd: &FindDataW) -> Result<Entry, RpcErr> {
        let name = fd.name;
        let m = fd.mtime;
        let unset = m.hi == 0xFFFF_FFFF && m.lo == 0xFFFF_FFFE;
        Ok(Entry {
            name: from_w_slice(&name)?, attr_raw: fd.attr, hi: fd.size_high, lo: fd.size_low,
            mtime: if unset { Value::Null } else { Value::Int((((m.hi as u64) << 32) | m.lo as u64) as i64) },
            mode: fd.res0,
        })
    }
    fn is_dir(&self) -> bool { self.attr_raw & 0x10 != 0 }
    fn json(&self) -> Value {
        let mut items = vec![
            ("name", s(&self.name)), ("isDir", Value::Bool(self.is_dir())),
            ("attr", Value::Int((self.attr_raw & 0x7FFF_FFFF) as i64)),
            ("size", Value::Int((((self.hi as u64) << 32) | self.lo as u64) as i64)),
            ("sizeHigh", Value::Int(self.hi as i64)), ("sizeLow", Value::Int(self.lo as i64)), ("mtime", self.mtime.clone()),
        ];
        if self.attr_raw & 0x8000_0000 != 0 { items.push(("unixMode", Value::Int(self.mode as i64))); }
        obj(items)
    }
}

/// Iterate a plugin directory. The callback may recurse while this handle stays open.
fn each_entry(lib: Lib, path: &str, f: &mut dyn FnMut(Entry) -> Result<(), RpcErr>) -> Result<(), RpcErr> {
    if path.chars().count() > 1023 { return Err(invalid("path longer than 1023 characters")); }
    let first: FsFindFirstW = lib.req("FsFindFirstW")?;
    let next: FsFindNextW = lib.req("FsFindNextW")?;
    let close: FsFindClose = lib.req("FsFindClose")?;
    let w = to_w(path);
    let mut fd: FindDataW = unsafe { zeroed() };
    set_errno(0);
    let h = first(w.as_ptr(), &mut fd);
    if h == -1 {
        let e = errno();
        if e == ERROR_NO_MORE_FILES { return Ok(()); } // empty directory
        return Err(rerr_with("FsFindFirstFailed", format!("FsFindFirstW({path}) returned INVALID_HANDLE_VALUE"), vec![("errno", Value::Int(e as i64))]));
    }
    let mut result = Ok(());
    loop {
        match Entry::from(&fd) {
            Ok(e) => if let Err(x) = f(e) { result = Err(x); break },
            Err(x) => { result = Err(x); break }
        }
        fd = unsafe { zeroed() };
        if next(h, &mut fd) == 0 { break; }
    }
    close(h); // always, on every branch
    result
}
fn join(dir: &str, name: &str) -> String { if dir == "\\" { format!("\\{name}") } else { format!("{dir}\\{name}") } }
fn walk(lib: Lib, dir: &str, out: &mut Vec<Value>) -> Result<(), RpcErr> {
    each_entry(lib, dir, &mut |e| {
        let full = join(dir, &e.name);
        out.push(s(&full));
        if e.is_dir() { walk(lib, &full, out)?; }
        Ok(())
    })
}

fn code_name_fs(c: i32) -> &'static str {
    ["FS_FILE_OK", "FS_FILE_EXISTS", "FS_FILE_NOTFOUND", "FS_FILE_READERROR", "FS_FILE_WRITEERROR", "FS_FILE_USERABORT", "FS_FILE_NOTSUPPORTED", "FS_FILE_EXISTSRESUMEALLOWED"]
        .get(c as usize).copied().unwrap_or("UNKNOWN")
}
fn code_name_wcx(c: i32) -> &'static str {
    match c {
        0 => "OK", 10 => "E_END_ARCHIVE", 11 => "E_NO_MEMORY", 12 => "E_BAD_DATA", 13 => "E_BAD_ARCHIVE", 14 => "E_UNKNOWN_FORMAT",
        15 => "E_EOPEN", 16 => "E_ECREATE", 17 => "E_ECLOSE", 18 => "E_EREAD", 19 => "E_EWRITE", 20 => "E_SMALL_BUF",
        21 => "E_EABORTED", 22 => "E_NO_FILES", 23 => "E_TOO_MANY_FILES", 24 => "E_NOT_SUPPORTED", _ => "UNKNOWN",
    }
}

// ---- params ----
fn p_str<'a>(p: &'a Value, k: &str) -> Result<&'a str, RpcErr> {
    p.get(k).and_then(Value::as_str).ok_or_else(|| invalid(format!("missing string param '{k}'")))
}
fn p_bool(p: &Value, k: &str) -> bool { p.get(k).and_then(Value::as_bool).unwrap_or(false) }
fn p_int(p: &Value, k: &str, default: i64) -> i64 { p.get(k).and_then(Value::as_i64).unwrap_or(default) }

struct Runner { loaded: Option<Loaded> }

impl Runner {
    fn lib(&self, kind: Kind) -> Result<Lib, RpcErr> {
        let l = self.loaded.as_ref().ok_or_else(|| rerr("NotLoaded", "no plugin loaded; call plugin.load first"))?;
        if l.kind != kind { return Err(rerr("WrongKind", "loaded plugin is of another kind")); }
        Ok(l.lib)
    }

    fn load(&mut self, p: &Value) -> Result<Value, RpcErr> {
        if self.loaded.is_some() { return Err(rerr("AlreadyLoaded", "this runner already hosts a plugin (one process per plugin)")); }
        let path = p_str(p, "path")?;
        let kind = match p_str(p, "kind")? { "wfx" => Kind::Wfx, "wcx" => Kind::Wcx, k => return Err(invalid(format!("unknown kind '{k}'"))) };
        check_binary(path)?;
        let c = CString::new(path).map_err(|_| invalid("NUL in path"))?;
        let h = unsafe { dlopen(c.as_ptr(), RTLD_NOW | RTLD_LOCAL) };
        if h.is_null() {
            let e = unsafe { dlerror() };
            let msg = if e.is_null() { "unknown dlopen error".to_string() } else { unsafe { CStr::from_ptr(e) }.to_string_lossy().into_owned() };
            return Err(rerr("DlopenFailed", msg));
        }
        let lib = Lib(h);
        let has = |n: &str| lib.sym::<*mut c_void>(n).is_some();
        let ok = match kind {
            Kind::Wfx => (has("FsInit") && has("FsFindFirst") && has("FsFindNext")) || (has("FsInitW") && has("FsFindFirstW") && has("FsFindNextW")),
            Kind::Wcx => (has("OpenArchive") && has("ReadHeader") && has("ProcessFile") && has("CloseArchive"))
                || (has("OpenArchiveW") && has("ReadHeaderExW") && has("ProcessFileW") && has("CloseArchive")),
        };
        if !ok {
            unsafe { dlclose(h) };
            return Err(rerr("MissingExports", "plugin lacks the minimal export set"));
        }
        self.loaded = Some(Loaded { lib, kind, path: path.to_string() });
        Ok(obj(vec![("kind", s(if kind == Kind::Wfx { "wfx" } else { "wcx" })), ("path", s(path))]))
    }

    fn exports(&self) -> Result<Value, RpcErr> {
        let l = self.loaded.as_ref().ok_or_else(|| rerr("NotLoaded", "no plugin loaded"))?;
        let names = if l.kind == Kind::Wfx { WFX_NAMES } else { WCX_NAMES };
        let found: Vec<Value> = names.iter().filter(|n| l.lib.sym::<*mut c_void>(n).is_some()).map(|n| s(n)).collect();
        let missing: Vec<Value> = names.iter().filter(|n| l.lib.sym::<*mut c_void>(n).is_none()).map(|n| s(n)).collect();
        let w = match l.kind {
            Kind::Wfx => l.lib.sym::<*mut c_void>("FsInitW").is_some() && l.lib.sym::<*mut c_void>("FsFindFirstW").is_some(),
            Kind::Wcx => l.lib.sym::<*mut c_void>("OpenArchiveW").is_some() && l.lib.sym::<*mut c_void>("ReadHeaderExW").is_some(),
        };
        Ok(obj(vec![("path", s(&l.path)), ("found", Value::Arr(found)), ("missing", Value::Arr(missing)), ("selectedVariant", s(if w { "W" } else { "A" }))]))
    }

    fn stat(&self) -> Result<Value, RpcErr> {
        let l = self.loaded.as_ref().ok_or_else(|| rerr("NotLoaded", "no plugin loaded"))?;
        let mut items = Vec::new();
        for (key, sym) in [("openHandles", "SpikeOpenHandles"), ("openArchives", "SpikeOpenArchives"), ("ansiCalls", "SpikeAnsiCalls")] {
            if let Some(f) = l.lib.sym::<IntFn>(sym) { items.push((key, Value::Int(f() as i64))); }
        }
        Ok(obj(items))
    }

    fn plugin_layout(&self, p: &Value) -> Result<Value, RpcErr> {
        let l = self.loaded.as_ref().ok_or_else(|| rerr("NotLoaded", "no plugin loaded"))?;
        let f: LayoutFn = l.lib.req("SpikeLayout")?;
        let key = p_str(p, "key")?;
        let c = CString::new(key).map_err(|_| invalid("NUL"))?;
        let v = f(c.as_ptr());
        if v < 0 { return Err(invalid(format!("unknown layout key {key}"))); }
        Ok(Value::Int(v))
    }

    fn unload(&mut self) -> Result<Value, RpcErr> {
        let l = self.loaded.take().ok_or_else(|| rerr("NotLoaded", "no plugin loaded"))?;
        let rc = unsafe { dlclose(l.lib.0) };
        Ok(obj(vec![("dlclose", Value::Int(rc as i64))]))
    }

    fn wfx_init(&self) -> Result<Value, RpcErr> {
        let lib = self.lib(Kind::Wfx)?;
        let init: FsInitW = lib.sym("FsInitW").ok_or_else(|| rerr("AnsiOnlyUnsupported", "plugin has no FsInitW; the ANSI-only path is not implemented in this spike"))?;
        let mut root = Value::Null;
        if let Some(f) = lib.sym::<FsDefRoot>("FsGetDefRootName") {
            let mut buf = [0 as c_char; 260];
            f(buf.as_mut_ptr(), 260); // TC calls this at install time, before FsInit
            root = Value::Str(unsafe { CStr::from_ptr(buf.as_ptr()) }.to_str().map_err(|_| rerr("BadUtf8", "root name is not UTF-8"))?.to_string());
        }
        let rc = init(PLUGIN_NR, progress_w, log_w, request_w);
        if let Some(f) = lib.sym::<FsSetDefaults>("FsSetDefaultParams") {
            let mut dp = DefaultParams { size: size_of::<DefaultParams>() as i32, ver_low: 22, ver_hi: 2, ini: [0; 260] };
            let ini = b"/tmp/spike-wfx.ini";
            dp.ini[..ini.len()].copy_from_slice(ini);
            f(&dp);
        }
        if let Some(f) = lib.sym::<FsSetCryptW>("FsSetCryptCallbackW") { f(crypt_w, 1, 0); }
        let bg = lib.sym::<IntFn>("FsGetBackgroundFlags").map(|f| f()).unwrap_or(0);
        Ok(obj(vec![("variant", s("W")), ("initResult", Value::Int(rc as i64)), ("pluginNr", Value::Int(PLUGIN_NR as i64)),
            ("rootName", root), ("backgroundFlags", Value::Int(bg as i64))]))
    }

    fn wfx_list(&self, p: &Value) -> Result<Value, RpcErr> {
        let lib = self.lib(Kind::Wfx)?;
        let path = p_str(p, "path")?;
        let mut out = Vec::new();
        each_entry(lib, path, &mut |e| { out.push(e.json()); Ok(()) })?;
        Ok(obj(vec![("path", s(path)), ("entries", Value::Arr(out))]))
    }

    fn wfx_tree(&self, p: &Value) -> Result<Value, RpcErr> {
        let lib = self.lib(Kind::Wfx)?;
        let path = p_str(p, "path")?;
        let mut out = Vec::new();
        walk(lib, path, &mut out)?;
        Ok(obj(vec![("paths", Value::Arr(out))]))
    }

    fn wfx_get_file(&self, p: &Value) -> Result<Value, RpcErr> {
        let lib = self.lib(Kind::Wfx)?;
        let get: FsGetFileW = lib.req("FsGetFileW")?;
        let remote = p_str(p, "remote")?;
        let local = p_str(p, "local")?;
        let flags = if p_bool(p, "overwrite") { 1 } else { 0 };
        // RemoteInfoStruct from a listing of the parent directory (what the host would have remembered)
        let (dir, name) = match remote.rfind('\\') { Some(0) => ("\\", &remote[1..]), Some(i) => (&remote[..i], &remote[i + 1..]), None => return Err(invalid("remote must start with a backslash")) };
        let mut ri = RemoteInfo { size_low: 0, size_high: 0, mtime: FileTime { lo: 0, hi: 0 }, attr: 0 };
        let _ = each_entry(lib, dir, &mut |e| {
            if e.name == name { ri = RemoteInfo { size_low: e.lo, size_high: e.hi, mtime: FileTime { lo: 0, hi: 0 }, attr: e.attr_raw as i32 }; }
            Ok(())
        });
        CANCEL_PERCENT.store(p_int(p, "cancelAtPercent", -1) as i32, Ordering::SeqCst);
        let (rw, lw) = (to_w(remote), to_w(local));
        let rc = get(rw.as_ptr(), lw.as_ptr(), flags, &ri);
        CANCEL_PERCENT.store(-1, Ordering::SeqCst);
        Ok(obj(vec![("code", Value::Int(rc as i64)), ("codeName", s(code_name_fs(rc)))]))
    }

    fn wcx_open(lib: Lib, archive: &str, mode: i32) -> Result<isize, RpcErr> {
        let open: OpenArchiveW = lib.req("OpenArchiveW")?;
        let w = to_w(archive);
        let mut d = OpenArchiveDataW { arc_name: w.as_ptr(), open_mode: mode, open_result: 0, cmt_buf: std::ptr::null_mut(), cmt_buf_size: 0, cmt_size: 0, cmt_state: 0 };
        let h = open(&mut d);
        if h == 0 {
            let c = d.open_result;
            return Err(rerr_with("OpenArchiveFailed", format!("OpenArchiveW failed: {}", code_name_wcx(c)), vec![("code", Value::Int(c as i64)), ("codeName", s(code_name_wcx(c)))]));
        }
        if let Some(f) = lib.sym::<SetProcDataW>("SetProcessDataProcW") { f(h, process_data_w); }
        if let Some(f) = lib.sym::<SetChangeVolW>("SetChangeVolProcW") { f(h, change_vol_w); }
        Ok(h)
    }

    /// Walk all headers; `on_header` gets the parsed header and returns the ProcessFile call to make.
    fn wcx_walk(&self, archive: &str, mode: i32, on_header: &mut dyn FnMut(&str, &Value) -> Option<(i32, Option<Vec<u16>>, Option<Vec<u16>>)>) -> Result<(), RpcErr> {
        let lib = self.lib(Kind::Wcx)?;
        let read: ReadHeaderExW = lib.req("ReadHeaderExW")?;
        let process: ProcessFileW = lib.req("ProcessFileW")?;
        let close: CloseArchive = lib.req("CloseArchive")?;
        let h = Self::wcx_open(lib, archive, mode)?;
        let mut buf = vec![0u64; 1024]; // 8192 bytes: bigger than either alignment flavour of tHeaderDataExW
        let mut result = Ok(());
        loop {
            buf.iter_mut().for_each(|x| *x = 0);
            let rc = read(h, buf.as_mut_ptr() as *mut u8);
            if rc == 10 { break; }
            if rc != 0 { result = Err(rerr_with("ReadHeaderFailed", format!("ReadHeaderExW: {}", code_name_wcx(rc)), vec![("code", Value::Int(rc as i64))])); break; }
            let hd = unsafe { &*(buf.as_ptr() as *const HeaderDataExW) };
            let fname = hd.file_name;
            let name = match from_w_slice(&fname) { Ok(n) => n, Err(e) => { result = Err(e); break; } };
            let (pk, pkh, up, uph) = (hd.pack_size, hd.pack_size_high, hd.unp_size, hd.unp_size_high);
            let (crc, ft, attr) = (hd.file_crc, hd.file_time, hd.file_attr);
            let info = obj(vec![
                ("name", s(&name)), ("packSize", Value::Int((((pkh as u64) << 32) | pk as u64) as i64)),
                ("unpSize", Value::Int((((uph as u64) << 32) | up as u64) as i64)),
                ("attr", Value::Int(attr as i64)), ("fileTime", Value::Int(ft as i64)), ("crc", Value::Int(crc as i64)),
            ]);
            let (op, dpath, dname) = on_header(&name, &info).unwrap_or((0, None, None));
            let pp = dpath.as_ref().map_or(std::ptr::null(), |v| v.as_ptr());
            let pn = dname.as_ref().map_or(std::ptr::null(), |v| v.as_ptr());
            let rc = process(h, op, pp, pn);
            if rc != 0 { result = Err(rerr_with("ProcessFileFailed", format!("ProcessFileW: {}", code_name_wcx(rc)), vec![("code", Value::Int(rc as i64)), ("codeName", s(code_name_wcx(rc)))])); break; }
        }
        close(h); // always, on every branch
        result
    }

    fn wcx_list(&self, p: &Value) -> Result<Value, RpcErr> {
        let lib = self.lib(Kind::Wcx)?;
        let mut entries = Vec::new();
        self.wcx_walk(p_str(p, "archive")?, 0, &mut |_, info| { entries.push(info.clone()); None })?;
        let caps = lib.sym::<IntFn>("GetPackerCaps").map(|f| f()).unwrap_or(-1);
        let bg = lib.sym::<IntFn>("GetBackgroundFlags").map(|f| f()).unwrap_or(0);
        Ok(obj(vec![("entries", Value::Arr(entries)), ("packerCaps", Value::Int(caps as i64)), ("backgroundFlags", Value::Int(bg as i64))]))
    }

    fn wcx_extract(&self, p: &Value) -> Result<Value, RpcErr> {
        let archive = p_str(p, "archive")?;
        let name = p_str(p, "name")?;
        let dest = p_str(p, "dest")?;
        let op = if p_bool(p, "test") { 1 } else { 2 };
        let (dpath, dname) = if p_bool(p, "split") {
            let i = dest.rfind('/').ok_or_else(|| invalid("split needs a '/' in dest"))?;
            (Some(to_w(&dest[..i])), to_w(&dest[i + 1..]))
        } else { (None, to_w(dest)) };
        WCX_ABORT_AFTER.store(p_int(p, "abortAfterBytes", -1), Ordering::SeqCst);
        WCX_PROCESSED.store(0, Ordering::SeqCst);
        let mut found = false;
        let r = self.wcx_walk(archive, 1, &mut |n, _| {
            if n == name { found = true; Some((op, dpath.clone(), Some(dname.clone()))) } else { Some((0, None, None)) }
        });
        WCX_ABORT_AFTER.store(-1, Ordering::SeqCst);
        match r {
            Ok(()) if found => Ok(obj(vec![("code", Value::Int(0)), ("codeName", s("OK"))])),
            Ok(()) => Err(rerr("NotInArchive", format!("no entry named {name}"))),
            // a ProcessFile error is a normal operation result, not a runner failure
            Err(e) if e.data.get("kind").and_then(Value::as_str) == Some("ProcessFileFailed") => {
                let c = e.data.get("code").and_then(Value::as_i64).unwrap_or(-1);
                Ok(obj(vec![("code", Value::Int(c)), ("codeName", s(code_name_wcx(c as i32)))]))
            }
            Err(e) => Err(e),
        }
    }
}

fn abi_layout() -> Value {
    let mut items: Vec<(String, Value)> = Vec::new();
    macro_rules! o { ($k:expr, $v:expr) => { items.push(($k.to_string(), Value::Int($v as i64))) }; }
    o!("WIN32_FIND_DATAW.size", size_of::<FindDataW>());
    o!("WIN32_FIND_DATAW.dwFileAttributes", offset_of!(FindDataW, attr));
    o!("WIN32_FIND_DATAW.ftCreationTime", offset_of!(FindDataW, ctime));
    o!("WIN32_FIND_DATAW.ftLastAccessTime", offset_of!(FindDataW, atime));
    o!("WIN32_FIND_DATAW.ftLastWriteTime", offset_of!(FindDataW, mtime));
    o!("WIN32_FIND_DATAW.nFileSizeHigh", offset_of!(FindDataW, size_high));
    o!("WIN32_FIND_DATAW.nFileSizeLow", offset_of!(FindDataW, size_low));
    o!("WIN32_FIND_DATAW.dwReserved0", offset_of!(FindDataW, res0));
    o!("WIN32_FIND_DATAW.dwReserved1", offset_of!(FindDataW, res1));
    o!("WIN32_FIND_DATAW.cFileName", offset_of!(FindDataW, name));
    o!("WIN32_FIND_DATAW.cAlternateFileName", offset_of!(FindDataW, alt));
    o!("RemoteInfoStruct.size", size_of::<RemoteInfo>());
    o!("RemoteInfoStruct.Attr", offset_of!(RemoteInfo, attr));
    o!("FsDefaultParamStruct.size", size_of::<DefaultParams>());
    o!("FsDefaultParamStruct.DefaultIniName", offset_of!(DefaultParams, ini));
    o!("tHeaderDataExW.packed.size", size_of::<HeaderDataExW>());
    o!("tHeaderDataExW.packed.Flags", offset_of!(HeaderDataExW, flags));
    o!("tHeaderDataExW.packed.PackSize", offset_of!(HeaderDataExW, pack_size));
    o!("tHeaderDataExW.packed.UnpSizeHigh", offset_of!(HeaderDataExW, unp_size_high));
    o!("tHeaderDataExW.packed.FileAttr", offset_of!(HeaderDataExW, file_attr));
    o!("tHeaderDataExW.packed.CmtBuf", offset_of!(HeaderDataExW, cmt_buf));
    o!("tHeaderDataExW.packed.CmtBufSize", offset_of!(HeaderDataExW, cmt_buf_size));
    o!("tHeaderDataExW.packed.CmtSize", offset_of!(HeaderDataExW, cmt_size));
    o!("tHeaderDataExW.packed.CmtState", offset_of!(HeaderDataExW, cmt_state));
    o!("tHeaderDataExW.packed.Reserved", offset_of!(HeaderDataExW, reserved));
    o!("tOpenArchiveDataW.size", size_of::<OpenArchiveDataW>());
    o!("tOpenArchiveDataW.OpenMode", offset_of!(OpenArchiveDataW, open_mode));
    o!("tOpenArchiveDataW.OpenResult", offset_of!(OpenArchiveDataW, open_result));
    o!("tOpenArchiveDataW.CmtBuf", offset_of!(OpenArchiveDataW, cmt_buf));
    Value::Obj(items)
}

fn handle(r: &mut Runner, method: &str, p: &Value) -> Result<Value, RpcErr> {
    match method {
        "plugin.load" => r.load(p),
        "plugin.exports" => r.exports(),
        "plugin.stat" => r.stat(),
        "plugin.layout" => r.plugin_layout(p),
        "plugin.unload" => r.unload(),
        "abi.layout" => Ok(abi_layout()),
        "wfx.init" => r.wfx_init(),
        "wfx.list" => r.wfx_list(p),
        "wfx.tree" => r.wfx_tree(p),
        "wfx.getFile" => r.wfx_get_file(p),
        "wcx.list" => r.wcx_list(p),
        "wcx.extract" => r.wcx_extract(p),
        "runner.shutdown" => { emit(&obj(vec![("jsonrpc", s("2.0")), ("id", p.get("__id").cloned().unwrap_or(Value::Null)), ("result", Value::Bool(true))])); std::process::exit(0) }
        _ => Err(RpcErr { code: -32601, message: format!("method not found: {method}"), data: Value::Null }),
    }
}

fn main() {
    let mut runner = Runner { loaded: None };
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let req = match json::parse(&line) {
            Ok(v) => v,
            Err(e) => {
                emit(&obj(vec![("jsonrpc", s("2.0")), ("id", Value::Null), ("error", obj(vec![("code", Value::Int(-32700)), ("message", s(&format!("parse error: {e}")))]))]));
                continue;
            }
        };
        let id = req.get("id").cloned();
        let method = req.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let mut params = req.get("params").cloned().unwrap_or(Value::Obj(vec![]));
        if method == "runner.shutdown" { params = obj(vec![("__id", id.clone().unwrap_or(Value::Null))]); }
        let res = handle(&mut runner, &method, &params);
        let Some(id) = id else { continue }; // notification: no reply
        let msg = match res {
            Ok(v) => obj(vec![("jsonrpc", s("2.0")), ("id", id), ("result", v)]),
            Err(e) => {
                let mut err = vec![("code", Value::Int(e.code)), ("message", s(&e.message))];
                if e.data != Value::Null { err.push(("data", e.data)); }
                obj(vec![("jsonrpc", s("2.0")), ("id", id), ("error", obj(err))])
            }
        };
        emit(&msg);
    }
}
