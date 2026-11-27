#![allow(dead_code)]
//! Test driver (stdio frames against the real binary) and hand-made archive fixtures.
use archive_helper::frame::{self, Frame};
use base64::Engine;
use serde_json::{json, Value};
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

pub fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

static COUNTER: AtomicU32 = AtomicU32::new(0);

pub fn tmpdir() -> PathBuf {
    let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    let dir = base.join(format!("commander-helper-test-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub struct Helper {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    pub stdout: ChildStdout,
    pub hello: Value,
    next: u32,
}

pub enum Out {
    Ok(Value, Vec<Vec<u8>>),
    Err(Value),
}

impl Out {
    pub fn ok(self) -> Value {
        match self {
            Out::Ok(v, _) => v,
            Out::Err(e) => panic!("expected ok, got {e}"),
        }
    }
    pub fn err(self) -> (String, Option<String>) {
        match self {
            Out::Err(e) => (e["code"].as_str().unwrap().to_string(), e["reason"].as_str().map(str::to_string)),
            Out::Ok(v, _) => panic!("expected err, got ok {v}"),
        }
    }
    pub fn data(&self) -> Vec<u8> {
        match self {
            Out::Ok(_, d) => d.concat(),
            _ => panic!("no data"),
        }
    }
}

impl Helper {
    pub fn spawn() -> Helper {
        let mut child = Command::new(env!("CARGO_BIN_EXE_commander-archive-helper"))
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let mut stdout = child.stdout.take().unwrap();
        let hello = match frame::read_frame(&mut stdout).unwrap() {
            Frame::Control(v) => v,
            _ => panic!("hello expected"),
        };
        Helper { child, stdin, stdout, hello, next: 1 }
    }

    pub fn raw(&mut self, bytes: &[u8]) {
        let s = self.stdin.as_mut().unwrap();
        s.write_all(bytes).unwrap();
        s.flush().unwrap();
    }

    pub fn send(&mut self, v: &Value) {
        frame::write_control(self.stdin.as_mut().unwrap(), v).unwrap();
    }

    pub fn recv(&mut self) -> Frame {
        frame::read_frame(&mut self.stdout).unwrap()
    }

    /// Send one request and collect the reply (data frames, `need_password` is handled by `password`).
    pub fn request_with(&mut self, t: &str, mut fields: Value, password: Option<&str>) -> Out {
        let req = self.next;
        self.next += 1;
        fields["t"] = json!(t);
        fields["req"] = json!(req);
        self.send(&fields);
        let mut data = Vec::new();
        loop {
            match self.recv() {
                Frame::Data { req: r, bytes } => {
                    assert_eq!(r, req);
                    data.push(bytes);
                }
                Frame::Control(v) => match v["t"].as_str().unwrap() {
                    "ok" => {
                        assert_eq!(v["req"], json!(req));
                        return Out::Ok(v, data);
                    }
                    "err" => return Out::Err(v),
                    "need_password" => {
                        let pw = password.expect("helper asked for a password");
                        let mut body = Vec::new();
                        body.push(frame::KIND_SECRET);
                        body.extend_from_slice(&req.to_le_bytes());
                        body.extend_from_slice(pw.as_bytes());
                        let mut out = (body.len() as u32).to_le_bytes().to_vec();
                        out.extend_from_slice(&body);
                        self.raw(&out);
                    }
                    other => panic!("unexpected {other}"),
                },
                Frame::Secret { .. } => panic!("helper sent a secret"),
            }
        }
    }

    pub fn request(&mut self, t: &str, fields: Value) -> Out {
        self.request_with(t, fields, None)
    }

    pub fn open(&mut self, path: &Path) -> Out {
        self.open_with(path, json!({}))
    }

    pub fn open_with(&mut self, path: &Path, limits: Value) -> Out {
        self.open_fmt(path, limits, "auto")
    }

    pub fn open_fmt(&mut self, path: &Path, limits: Value, format: &str) -> Out {
        let m = std::fs::metadata(path).unwrap();
        let root = path.parent().unwrap();
        let name = path.file_name().unwrap();
        use std::os::unix::ffi::OsStrExt;
        self.request(
            "open",
            json!({
                "rootB64": b64(root.as_os_str().as_bytes()),
                "segmentsB64": [b64(name.as_bytes())],
                "format": format,
                "limits": limits,
                "expect": {"size": m.len().to_string(), "mtimeNs": (m.mtime() as u64 * 1_000_000_000 + m.mtime_nsec() as u64).to_string(), "dev": m.dev().to_string(), "ino": m.ino().to_string()},
            }),
        )
    }

    pub fn list_root(&mut self) -> Vec<Value> {
        self.list("")
    }

    pub fn list(&mut self, prefix: &str) -> Vec<Value> {
        let v = self.request("list", json!({"prefix": b64(prefix.as_bytes()), "cursor": null, "limit": 1000})).ok();
        v["entries"].as_array().unwrap().clone()
    }

    /// `pack_data`: a control request followed by the data frame with the same req id.
    pub fn pack_data(&mut self, bytes: &[u8]) -> Out {
        let req = self.next;
        self.next += 1;
        self.send(&json!({"t": "pack_data", "req": req}));
        frame::write_data(self.stdin.as_mut().unwrap(), req, bytes).unwrap();
        match self.recv() {
            Frame::Control(v) if v["t"] == "ok" => Out::Ok(v, vec![]),
            Frame::Control(v) => Out::Err(v),
            _ => panic!("unexpected frame"),
        }
    }

    pub fn counters(&mut self) -> Value {
        self.request("test_counters", json!({})).ok()
    }

    /// Read a whole entry through read_open / read / read_finish.
    pub fn read_entry(&mut self, id: u64, password: Option<&str>) -> Result<Vec<u8>, (String, Option<String>)> {
        let r = self.request_with("read_open", json!({"id": id}), password);
        let (stream, size) = match r {
            Out::Ok(v, _) => (v["stream"].as_u64().unwrap(), v["size"].as_str().unwrap().parse::<u64>().unwrap()),
            e => return Err(e.err()),
        };
        let mut all = Vec::new();
        while (all.len() as u64) < size {
            match self.request("read", json!({"stream": stream, "length": 65536})) {
                Out::Ok(_, d) => {
                    let chunk = d.concat();
                    if chunk.is_empty() {
                        break;
                    }
                    all.extend_from_slice(&chunk);
                }
                e => return Err(e.err()),
            }
        }
        match self.request("read_finish", json!({"stream": stream})) {
            Out::Ok(..) => {}
            e => return Err(e.err()),
        }
        self.request("read_close", json!({"stream": stream})).ok();
        Ok(all)
    }

    pub fn expect_exit(mut self, code: i32) {
        drop(self.stdin.take());
        let status = self.child.wait().unwrap();
        assert_eq!(status.code(), Some(code));
    }
}

// ---------- CRC32 ----------
pub fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for i in 0..256u32 {
        let mut c = i;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        table[i as usize] = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for b in data {
        crc = table[((crc ^ *b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

// ---------- TAR ----------
pub fn tar_header(name: &[u8], typeflag: u8, size_field: &[u8; 12], linkname: &[u8]) -> [u8; 512] {
    let mut h = [0u8; 512];
    h[..name.len().min(100)].copy_from_slice(&name[..name.len().min(100)]);
    h[100..107].copy_from_slice(b"0000644");
    h[124..136].copy_from_slice(size_field);
    h[136..147].copy_from_slice(b"00000000000");
    h[156] = typeflag;
    h[157..157 + linkname.len().min(100)].copy_from_slice(&linkname[..linkname.len().min(100)]);
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    seal(&mut h);
    h
}

pub fn seal(h: &mut [u8; 512]) {
    h[148..156].copy_from_slice(b"        ");
    let sum: u32 = h.iter().map(|b| *b as u32).sum();
    h[148..155].copy_from_slice(format!("{:06o}\0", sum).as_bytes());
    h[155] = b' ';
}

pub fn octal12(v: u64) -> [u8; 12] {
    let mut f = [0u8; 12];
    f[..11].copy_from_slice(format!("{:011o}", v).as_bytes());
    f
}

pub fn pad(data: &[u8]) -> Vec<u8> {
    let mut v = data.to_vec();
    v.resize(data.len().div_ceil(512) * 512, 0);
    v
}

pub fn tar_file(name: &[u8], data: &[u8]) -> Vec<u8> {
    let mut v = tar_header(name, b'0', &octal12(data.len() as u64), b"").to_vec();
    v.extend(pad(data));
    v
}

pub fn tar_meta(typeflag: u8, body: &[u8]) -> Vec<u8> {
    let mut v = tar_header(b"././@meta", typeflag, &octal12(body.len() as u64), b"").to_vec();
    v.extend(pad(body));
    v
}

pub fn pax_record(key: &str, value: &[u8]) -> Vec<u8> {
    let base = key.len() + value.len() + 3; // ' ' '=' '\n'
    let mut len = base + base.to_string().len();
    if len.to_string().len() + base != len {
        len = base + len.to_string().len();
    }
    let mut v = format!("{len} {key}=").into_bytes();
    v.extend_from_slice(value);
    v.push(b'\n');
    assert_eq!(v.len(), len);
    v
}

pub fn tar_finish(mut blocks: Vec<u8>) -> Vec<u8> {
    blocks.extend(vec![0u8; 1024]);
    blocks
}

pub fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

// ---------- ZIP ----------
pub struct ZEntry {
    pub name: Vec<u8>,
    pub data: Vec<u8>,  // stored bytes (already compressed when method == 8)
    pub usize: u64,
    pub method: u16,
    pub flags: u16,
    pub crc: u32,
    pub ext_attr: u32,
    pub made_by: u16,
}

impl ZEntry {
    pub fn stored(name: &[u8], data: &[u8]) -> ZEntry {
        ZEntry { name: name.to_vec(), data: data.to_vec(), usize: data.len() as u64, method: 0, flags: 0, crc: crc32(data), ext_attr: 0, made_by: 20 }
    }
    pub fn deflated(name: &[u8], raw: &[u8]) -> ZEntry {
        use flate2::write::DeflateEncoder;
        use flate2::Compression;
        let mut e = DeflateEncoder::new(Vec::new(), Compression::default());
        e.write_all(raw).unwrap();
        let packed = e.finish().unwrap();
        ZEntry { name: name.to_vec(), data: packed, usize: raw.len() as u64, method: 8, flags: 0, crc: crc32(raw), ext_attr: 0, made_by: 20 }
    }
    pub fn symlink(name: &[u8], target: &[u8]) -> ZEntry {
        let mut e = ZEntry::stored(name, target);
        e.made_by = 3 << 8;
        e.ext_attr = 0o120777 << 16;
        e
    }
}

pub struct Zip {
    pub bytes: Vec<u8>,
    pub cd_off: u32,
    pub cd_size: u32,
    pub count: u16,
}

fn local(e: &ZEntry, csize_override: Option<u64>) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
    v.extend_from_slice(&20u16.to_le_bytes());
    v.extend_from_slice(&e.flags.to_le_bytes());
    v.extend_from_slice(&e.method.to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes());
    v.extend_from_slice(&0x21u16.to_le_bytes()); // 1980-01-01
    v.extend_from_slice(&e.crc.to_le_bytes());
    v.extend_from_slice(&(csize_override.unwrap_or(e.data.len() as u64) as u32).to_le_bytes());
    v.extend_from_slice(&(e.usize as u32).to_le_bytes());
    v.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes());
    v.extend_from_slice(&e.name);
    v
}

fn central(e: &ZEntry, off: u32, csize: u64) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
    v.extend_from_slice(&e.made_by.to_le_bytes());
    v.extend_from_slice(&20u16.to_le_bytes());
    v.extend_from_slice(&e.flags.to_le_bytes());
    v.extend_from_slice(&e.method.to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes());
    v.extend_from_slice(&0x21u16.to_le_bytes());
    v.extend_from_slice(&e.crc.to_le_bytes());
    v.extend_from_slice(&(csize as u32).to_le_bytes());
    v.extend_from_slice(&(e.usize as u32).to_le_bytes());
    v.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes());
    v.extend_from_slice(&e.ext_attr.to_le_bytes());
    v.extend_from_slice(&off.to_le_bytes());
    v.extend_from_slice(&e.name);
    v
}

pub fn eocd(count: u16, cd_size: u32, cd_off: u32, disk: u16, comment: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    v.extend_from_slice(&disk.to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes());
    v.extend_from_slice(&count.to_le_bytes());
    v.extend_from_slice(&count.to_le_bytes());
    v.extend_from_slice(&cd_size.to_le_bytes());
    v.extend_from_slice(&cd_off.to_le_bytes());
    v.extend_from_slice(&(comment.len() as u16).to_le_bytes());
    v.extend_from_slice(comment);
    v
}

pub fn zip(entries: &[ZEntry]) -> Zip {
    zip_with(entries, |_| None)
}

/// `csize_lie(i)` overrides the compressed size written to the directory/local header.
pub fn zip_with(entries: &[ZEntry], csize_lie: impl Fn(usize) -> Option<u64>) -> Zip {
    let mut bytes = Vec::new();
    let mut cds = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        let off = bytes.len() as u32;
        let cs = csize_lie(i);
        bytes.extend(local(e, cs));
        bytes.extend_from_slice(&e.data);
        cds.push(central(e, off, cs.unwrap_or(e.data.len() as u64)));
    }
    let cd_off = bytes.len() as u32;
    let cd: Vec<u8> = cds.concat();
    let cd_size = cd.len() as u32;
    bytes.extend(cd);
    bytes.extend(eocd(entries.len() as u16, cd_size, cd_off, 0, b""));
    Zip { bytes, cd_off, cd_size, count: entries.len() as u16 }
}
