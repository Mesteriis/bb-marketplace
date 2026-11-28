//! Request loop (S14 spec §4). One request in flight; frames come from a reader thread so that
//! `cancel` can interrupt a running request. Any wire violation is fatal: exit code 2.
use crate::archive::OpenArchive;
use crate::cancel::Ctx;
use crate::errors::{self, HErr};
use crate::frame::{self, Frame, FrameError};
use crate::fsio::Fingerprint;
use crate::model::{Limits, DEFAULT_LIMITS};
use crate::pack::Pack;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{Stdout, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroizing;

pub const PROTOCOL: u32 = 1;
pub const HELPER_VERSION: &str = "0.1.0";
const IDLE_EXIT: Duration = Duration::from_secs(600);
const CPU_BUDGET_SECS: u64 = 120;
const LIST_MAX_BYTES: usize = (1 << 20) - 16 * 1024;

enum Msg {
    Frame(Frame),
    Eof,
    Fatal(&'static str),
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn num(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn bytes_field(v: &Value, key: &str) -> Result<Vec<u8>, HErr> {
    let s = v.get(key).and_then(Value::as_str).ok_or_else(|| errors::invalid_path("A required field is missing"))?;
    b64().decode(s).map_err(|_| errors::invalid_path("A field is not base64"))
}

fn limits_from(v: Option<&Value>) -> Limits {
    let mut l = DEFAULT_LIMITS;
    if let Some(o) = v {
        if let Some(x) = o.get("maxTotalBytes").and_then(num) {
            l.max_total_bytes = x;
        }
        if let Some(x) = o.get("maxEntries").and_then(num) {
            l.max_entries = x;
        }
        if let Some(x) = o.get("maxRatio").and_then(num) {
            l.max_ratio = x.max(1);
        }
    }
    l
}

fn fingerprint_json(f: &Fingerprint) -> Value {
    json!({"size": f.size.to_string(), "mtimeNs": f.mtime_ns.to_string(), "dev": f.dev.to_string(), "ino": f.ino.to_string()})
}

#[cfg(unix)]
fn cpu_used_secs() -> u64 {
    let mut ru = std::mem::MaybeUninit::<libc::rusage>::uninit();
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, ru.as_mut_ptr()) } != 0 {
        return 0;
    }
    let ru = unsafe { ru.assume_init() };
    (ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) as u64
}

/// One soft CPU limit per request: CPU used so far + the budget; the hard limit is left alone.
pub fn arm_cpu_limit() {
    let mut cur = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    if unsafe { libc::getrlimit(libc::RLIMIT_CPU, &mut cur) } != 0 {
        return;
    }
    let want = cpu_used_secs() + CPU_BUDGET_SECS;
    let soft = if cur.rlim_max == libc::RLIM_INFINITY { want } else { want.min(cur.rlim_max) };
    let lim = libc::rlimit { rlim_cur: soft as libc::rlim_t, rlim_max: cur.rlim_max };
    unsafe { libc::setrlimit(libc::RLIMIT_CPU, &lim) };
}

/// Startup limits. RLIMIT_AS is attempted and probed, never relied upon (spec §3).
pub fn startup_limits() -> &'static str {
    let zero = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    let mut core = zero;
    if unsafe { libc::getrlimit(libc::RLIMIT_CORE, &mut core) } == 0 {
        core.rlim_cur = 0;
        unsafe { libc::setrlimit(libc::RLIMIT_CORE, &core) };
    }
    let mut cur = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    if unsafe { libc::getrlimit(libc::RLIMIT_AS, &mut cur) } != 0 {
        return "failed";
    }
    let want: libc::rlim_t = 1 << 30;
    let soft = if cur.rlim_max == libc::RLIM_INFINITY { want } else { want.min(cur.rlim_max) };
    let lim = libc::rlimit { rlim_cur: soft, rlim_max: cur.rlim_max };
    if unsafe { libc::setrlimit(libc::RLIMIT_AS, &lim) } != 0 {
        return "failed";
    }
    // Probe: reserve more address space than the limit allows.
    let probe = 2usize << 30;
    let p = unsafe { libc::mmap(std::ptr::null_mut(), probe, libc::PROT_NONE, libc::MAP_ANON | libc::MAP_PRIVATE, -1, 0) };
    if p == libc::MAP_FAILED {
        "enforced"
    } else {
        unsafe { libc::munmap(p, probe) };
        "not_enforced"
    }
}

pub struct Server {
    out: Stdout,
    rx: Receiver<Msg>,
    pending: VecDeque<Frame>,
    cancel: Arc<AtomicU32>,
    archive: Option<OpenArchive>,
    pack: Option<Pack>,
    #[cfg(feature = "test-hooks")]
    balloon: Vec<Vec<u8>>,
}

enum Reply {
    Ok(Value),
    OkData(Vec<u8>, Value),
    /// Reply, then terminate (close, third wrong password).
    OkExit(Value),
}

fn fatal(why: &'static str) -> ! {
    eprintln!("protocol_error: {why}");
    std::process::exit(2);
}

impl Server {
    pub fn new(rlimit_as: &'static str) -> Self {
        let (tx, rx) = channel();
        let cancel = Arc::new(AtomicU32::new(0));
        let reader_cancel = cancel.clone();
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            loop {
                match frame::read_frame(&mut stdin) {
                    Ok(f) => {
                        if let Frame::Control(v) = &f {
                            if v.get("t").and_then(Value::as_str) == Some("cancel") {
                                if let Some(t) = v.get("target").or_else(|| v.get("req")).and_then(num) {
                                    reader_cancel.store(t as u32, Ordering::Relaxed);
                                }
                            }
                        }
                        if tx.send(Msg::Frame(f)).is_err() {
                            return;
                        }
                    }
                    Err(FrameError::Eof) => {
                        let _ = tx.send(Msg::Eof);
                        return;
                    }
                    Err(FrameError::Protocol(why)) => {
                        let _ = tx.send(Msg::Fatal(why));
                        return;
                    }
                    Err(FrameError::Io(_)) => {
                        let _ = tx.send(Msg::Eof);
                        return;
                    }
                }
            }
        });
        let mut s = Server {
            out: std::io::stdout(),
            rx,
            pending: VecDeque::new(),
            cancel,
            archive: None,
            pack: None,
            #[cfg(feature = "test-hooks")]
            balloon: Vec::new(),
        };
        s.send(&json!({"t": "hello", "protocol": PROTOCOL, "helper": HELPER_VERSION, "zip": "8.6.0", "tar": "0.4.46", "rlimit_as": rlimit_as}));
        s
    }

    fn send(&mut self, v: &Value) {
        if frame::write_control(&mut self.out, v).is_err() {
            std::process::exit(0); // the reader is gone
        }
    }

    fn next(&mut self, timeout: Option<Duration>) -> Frame {
        if let Some(f) = self.pending.pop_front() {
            return f;
        }
        let msg = match timeout {
            Some(t) => match self.rx.recv_timeout(t) {
                Ok(m) => m,
                Err(RecvTimeoutError::Timeout) => std::process::exit(0), // idle_exit
                Err(RecvTimeoutError::Disconnected) => std::process::exit(0),
            },
            None => self.rx.recv().unwrap_or(Msg::Eof),
        };
        match msg {
            Msg::Frame(f) => f,
            Msg::Eof => std::process::exit(0),
            Msg::Fatal(why) => fatal(why),
        }
    }

    /// Frames present before our reply would mean the peer pipelined a request: a violation.
    fn check_no_pipelining(&mut self) {
        while let Ok(m) = self.rx.try_recv() {
            match m {
                Msg::Frame(f) => self.pending.push_back(f),
                Msg::Eof => break,
                Msg::Fatal(why) => fatal(why),
            }
        }
        for f in &self.pending {
            match f {
                Frame::Control(v) if v.get("t").and_then(Value::as_str) == Some("cancel") => {}
                _ => fatal("a frame arrived while a request was in flight"),
            }
        }
    }

    pub fn run(&mut self) -> ! {
        loop {
            let frame = self.next(Some(IDLE_EXIT));
            let obj = match frame {
                Frame::Control(v) => v,
                Frame::Data { .. } => fatal("data frame without a request"),
                Frame::Secret { .. } => fatal("secret frame without need_password"),
            };
            let req = match obj.get("req").and_then(Value::as_u64) {
                Some(r) if r > 0 && r <= u32::MAX as u64 => r as u32,
                _ => fatal("a request has no valid req id"),
            };
            let t = match obj.get("t").and_then(Value::as_str) {
                Some(t) => t.to_string(),
                None => fatal("a request has no type"),
            };
            if self.cancel.load(Ordering::Relaxed) == req {
                self.cancel.store(0, Ordering::Relaxed);
            }
            arm_cpu_limit();
            let ctx = Ctx::new(req, self.cancel.clone());
            let result = self.handle(&t, &obj, req, &ctx);
            self.check_no_pipelining();
            match result {
                Ok(Reply::Ok(mut v)) => {
                    v["t"] = json!("ok");
                    v["req"] = json!(req);
                    self.send(&v);
                }
                Ok(Reply::OkData(bytes, mut v)) => {
                    if frame::write_data(&mut self.out, req, &bytes).is_err() {
                        std::process::exit(0);
                    }
                    v["t"] = json!("ok");
                    v["req"] = json!(req);
                    self.send(&v);
                }
                Ok(Reply::OkExit(mut v)) => {
                    v["t"] = json!("ok");
                    v["req"] = json!(req);
                    self.send(&v);
                    std::process::exit(0);
                }
                Err(e) => {
                    self.send(&json!({"t": "err", "req": req, "code": e.code, "reason": e.reason, "message": e.message, "retryable": e.retryable}));
                }
            }
        }
    }

    fn ask_password(&mut self, req: u32) -> Zeroizing<Vec<u8>> {
        self.send(&json!({"t": "need_password", "req": req}));
        match self.next(Some(IDLE_EXIT)) {
            Frame::Secret { req: r, bytes } if r == req => bytes,
            _ => fatal("expected the secret frame for need_password"),
        }
    }

    fn archive(&mut self) -> Result<&mut OpenArchive, HErr> {
        self.archive.as_mut().ok_or_else(|| errors::invalid_path("No archive is open"))
    }

    fn handle(&mut self, t: &str, v: &Value, req: u32, ctx: &Ctx) -> Result<Reply, HErr> {
        match t {
            "open" => {
                if self.archive.is_some() {
                    return Err(errors::internal("protocol_error"));
                }
                let root = bytes_field(v, "rootB64")?;
                let segments: Vec<Vec<u8>> = v
                    .get("segmentsB64")
                    .and_then(Value::as_array)
                    .ok_or_else(|| errors::invalid_path("segments are missing"))?
                    .iter()
                    .map(|s| s.as_str().ok_or_else(|| errors::invalid_path("A segment is not a string")).and_then(|s| b64().decode(s).map_err(|_| errors::invalid_path("A segment is not base64"))))
                    .collect::<Result<_, _>>()?;
                let format = v.get("format").and_then(Value::as_str).unwrap_or("auto");
                let limits = limits_from(v.get("limits"));
                let e = v.get("expect").ok_or_else(|| errors::invalid_path("expect is required"))?;
                let get = |k: &str| e.get(k).and_then(num).ok_or_else(|| errors::invalid_path("expect is incomplete"));
                let expect = Fingerprint { size: get("size")?, mtime_ns: get("mtimeNs")?, dev: get("dev")?, ino: get("ino")? };
                let a = OpenArchive::open(&root, &segments, format, limits, expect, ctx)?;
                let body = json!({
                    "handle": 1,
                    "format": if a.index.format == crate::model::Format::Zip { "zip" } else { "tar" },
                    "fingerprint": fingerprint_json(&a.fingerprint),
                    "entries": a.index.entries.len(),
                    "totalSize": a.index.total_size.to_string(),
                    "totalCompressed": a.index.total_compressed.to_string(),
                    "encrypted": a.index.encrypted,
                    "metaBytes": a.index.meta_bytes.to_string(),
                });
                self.archive = Some(a);
                Ok(Reply::Ok(body))
            }
            "list" => {
                let prefix = bytes_field(v, "prefix").unwrap_or_default();
                let cursor = v.get("cursor").and_then(Value::as_str).map(|s| s.parse::<usize>().unwrap_or(usize::MAX)).unwrap_or(0);
                let limit = (v.get("limit").and_then(Value::as_u64).unwrap_or(1000) as usize).clamp(1, 1000);
                let a = self.archive()?;
                a.verify()?;
                let (entries, next) = a.index.list(&prefix, cursor, limit, LIST_MAX_BYTES);
                Ok(Reply::Ok(json!({"entries": entries, "cursor": next.map(|n| n.to_string())})))
            }
            "stat" => {
                let name = bytes_field(v, "nameB64")?;
                let a = self.archive()?;
                a.verify()?;
                Ok(Reply::Ok(json!({"entry": a.index.stat(&name)})))
            }
            "read_open" => {
                let id = v.get("id").and_then(Value::as_u64).ok_or_else(|| errors::invalid_path("id is required"))? as u32;
                let need = {
                    let a = self.archive()?;
                    a.needs_password(id) && a.password.is_none()
                };
                if need {
                    let pw = self.ask_password(req);
                    self.archive()?.password = Some(pw);
                }
                let a = self.archive()?;
                match a.read_open(id) {
                    Ok((stream, size)) => Ok(Reply::Ok(json!({"stream": stream, "size": size.to_string()}))),
                    Err(e) => {
                        if e.reason == Some("bad_password") && a.bad_passwords >= 3 {
                            a.password = None;
                            let _ = a;
                            self.send(&json!({"t": "err", "req": req, "code": e.code, "reason": e.reason, "message": e.message, "retryable": false}));
                            std::process::exit(0);
                        }
                        Err(e)
                    }
                }
            }
            "read" => {
                let stream = v.get("stream").and_then(Value::as_u64).ok_or_else(|| errors::invalid_path("stream is required"))? as u32;
                let length = v.get("length").and_then(Value::as_u64).ok_or_else(|| errors::invalid_path("length is required"))? as usize;
                if length > frame::DATA_MAX {
                    return Err(errors::invalid_path("length is too large"));
                }
                let a = self.archive()?;
                let data = a.read(stream, length, ctx)?;
                let pos = a.stream_pos(stream);
                Ok(Reply::OkData(data, json!({"pos": pos.to_string()})))
            }
            "read_finish" => {
                let stream = v.get("stream").and_then(Value::as_u64).ok_or_else(|| errors::invalid_path("stream is required"))? as u32;
                let (size, crc, aes) = self.archive()?.read_finish(stream, ctx)?;
                Ok(Reply::Ok(json!({"size": size.to_string(), "crc32": crc, "aes_auth": aes})))
            }
            "read_close" => {
                let stream = v.get("stream").and_then(Value::as_u64).ok_or_else(|| errors::invalid_path("stream is required"))? as u32;
                self.archive()?.read_close(stream)?;
                Ok(Reply::Ok(json!({})))
            }
            "verify" => match self.archive()?.verify() {
                Ok(()) => Ok(Reply::Ok(json!({"changed": false}))),
                Err(e) if e.code == "changed_since_plan" => Ok(Reply::Ok(json!({"changed": true}))),
                Err(e) => Err(e),
            },
            "cancel" => Ok(Reply::Ok(json!({}))),
            "close" => {
                if let Some(a) = self.archive.as_mut() {
                    a.close_streams();
                }
                if let Some(p) = self.pack.as_mut() {
                    p.abort();
                }
                Ok(Reply::OkExit(json!({})))
            }
            "pack_open" => {
                if self.pack.is_some() {
                    return Err(errors::internal("protocol_error"));
                }
                let format = v.get("format").and_then(Value::as_str).unwrap_or("");
                let staging = bytes_field(v, "staging")?;
                let aes = v.get("zip").and_then(|z| z.get("encryption")).and_then(Value::as_str) == Some("aes256");
                let password = if Pack::wants_password(format, aes) { Some(self.ask_password(req)) } else { None };
                let pack = Pack::open(format, &staging, password, limits_from(v.get("limits")))?;
                self.pack = Some(pack);
                Ok(Reply::Ok(json!({"packId": 1})))
            }
            "pack_add" => {
                let name = bytes_field(v, "nameB64")?;
                let is_dir = v.get("kind").and_then(Value::as_str) == Some("dir");
                let size = v.get("size").and_then(num).unwrap_or(0);
                let mtime = v.get("mtime").and_then(Value::as_i64);
                let mode = v.get("mode").and_then(Value::as_u64).map(|m| m as u32);
                self.pack_mut()?.add(&name, is_dir, size, mtime, mode)?;
                Ok(Reply::Ok(json!({})))
            }
            "pack_data" => {
                // The payload follows as a data frame with the same req id.
                let bytes = match self.next(Some(IDLE_EXIT)) {
                    Frame::Data { req: r, bytes } if r == req => bytes,
                    _ => fatal("expected the data frame for pack_data"),
                };
                let written = self.pack_mut()?.data(&bytes)?;
                Ok(Reply::Ok(json!({"written": written.to_string()})))
            }
            "pack_end_entry" => {
                self.pack_mut()?.end_entry()?;
                Ok(Reply::Ok(json!({})))
            }
            "pack_finish" => {
                let (size, sha) = self.pack_mut()?.finish()?;
                Ok(Reply::Ok(json!({"size": size.to_string(), "sha256": sha})))
            }
            "pack_abort" => {
                if let Some(p) = self.pack.as_mut() {
                    p.abort();
                }
                self.pack = None;
                Ok(Reply::Ok(json!({})))
            }
            #[cfg(feature = "test-hooks")]
            "test_counters" => Ok(Reply::Ok(json!({
                "zipNewCalls": crate::zipscan::ARCHIVE_NEW_CALLS.load(Ordering::SeqCst),
                "bytesRead": crate::fsio::BYTES_READ.load(Ordering::Relaxed),
            }))),
            #[cfg(feature = "test-hooks")]
            "test_balloon" => {
                let mib = v.get("mib").and_then(Value::as_u64).unwrap_or(0) as usize;
                let mut b = vec![0u8; mib << 20];
                for i in (0..b.len()).step_by(4096) {
                    b[i] = 1;
                }
                self.balloon.push(b);
                Ok(Reply::Ok(json!({})))
            }
            _ => fatal("unknown request type"),
        }
    }

    fn pack_mut(&mut self) -> Result<&mut Pack, HErr> {
        self.pack.as_mut().ok_or_else(|| errors::invalid_path("No pack is open"))
    }
}

pub fn flush_stdout() {
    let _ = std::io::stdout().flush();
}
