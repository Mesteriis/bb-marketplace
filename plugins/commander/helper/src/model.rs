//! Archive index shared by the TAR and ZIP scanners: entries, tree and listing pages.
use crate::names;
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_total_bytes: u64,
    pub max_entries: u64,
    pub max_ratio: u64,
}

pub const DEFAULT_LIMITS: Limits = Limits { max_total_bytes: 10 * (1 << 30), max_entries: 100_000, max_ratio: 100 };
/// A single entry may exceed the ratio freely while smaller than this (tiny compressible files).
pub const RATIO_ENTRY_GRACE: u64 = 65_536;
/// The archive-wide ratio is only checked from this many output bytes.
pub const RATIO_TOTAL_GRACE: u64 = 1 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Zip,
    Tar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Symlink,
    Hardlink,
    Special,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::File => "file",
            Kind::Dir => "dir",
            Kind::Symlink => "symlink",
            Kind::Hardlink => "hardlink",
            Kind::Special => "special",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub id: u32,
    pub name_raw: Vec<u8>,
    pub name: String,
    pub name_lossy: bool,
    pub kind: Kind,
    pub size: u64,
    pub csize: u64,
    pub mtime: Option<i64>,
    pub mode: Option<u32>,
    pub encrypted: bool,
    /// AES (WinZip) rather than ZipCrypto.
    pub aes: bool,
    pub crc32: Option<u32>,
    pub link: Option<Vec<u8>>,
    pub refused: Option<&'static str>,
    /// TAR: offset of the data; ZIP: unused.
    pub data_offset: u64,
}

#[derive(Debug)]
pub struct Index {
    pub format: Format,
    pub entries: Vec<Entry>,
    pub total_size: u64,
    pub total_compressed: u64,
    pub meta_bytes: u64,
    pub encrypted: bool,
    by_name: HashMap<Vec<u8>, u32>,
    /// parent key (segments joined by '/') -> children (entry ids or synthetic directory names)
    children: HashMap<Vec<u8>, Vec<Child>>,
}

#[derive(Debug, Clone)]
enum Child {
    Entry(u32),
    Synthetic(Vec<u8>),
}

fn join(segments: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for (i, s) in segments.iter().enumerate() {
        if i > 0 {
            out.push(b'/');
        }
        out.extend_from_slice(s);
    }
    out
}

impl Index {
    pub fn new(format: Format, entries: Vec<Entry>, total_size: u64, total_compressed: u64, meta_bytes: u64) -> Self {
        let mut by_name = HashMap::new();
        let mut children: HashMap<Vec<u8>, Vec<Child>> = HashMap::new();
        let mut has_dir_entry: HashMap<Vec<u8>, ()> = HashMap::new();
        let mut synthetic_seen: HashMap<Vec<u8>, ()> = HashMap::new();
        let encrypted = entries.iter().any(|e| e.encrypted);
        for e in &entries {
            by_name.insert(e.name_raw.clone(), e.id);
            if e.kind == Kind::Dir {
                if let Some(seg) = names::tree_key(&e.name_raw) {
                    has_dir_entry.insert(join(&seg), ());
                }
            }
        }
        for e in &entries {
            match names::tree_key(&e.name_raw) {
                Some(seg) => {
                    for depth in 1..seg.len() {
                        let key = join(&seg[..depth]);
                        if !has_dir_entry.contains_key(&key) && synthetic_seen.insert(key.clone(), ()).is_none() {
                            children.entry(join(&seg[..depth - 1])).or_default().push(Child::Synthetic(seg[depth - 1].clone()));
                        }
                    }
                    children.entry(join(&seg[..seg.len() - 1])).or_default().push(Child::Entry(e.id));
                }
                // Refused names are listed at the root so the owner can see them.
                None => children.entry(Vec::new()).or_default().push(Child::Entry(e.id)),
            }
        }
        Index { format, entries, total_size, total_compressed, meta_bytes, encrypted, by_name, children }
    }

    pub fn find(&self, raw: &[u8]) -> Option<&Entry> {
        self.by_name.get(raw).map(|i| &self.entries[*i as usize])
    }

    pub fn entry_json(e: &Entry) -> Value {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut v = json!({
            "id": e.id,
            "nameB64": b64.encode(&e.name_raw),
            "name": e.name,
            "nameLossy": e.name_lossy,
            "kind": e.kind.as_str(),
            "size": e.size.to_string(),
            "csize": e.csize.to_string(),
            "mtime": e.mtime,
            "mode": e.mode,
            "encrypted": e.encrypted,
        });
        if let Some(l) = &e.link {
            v["linkB64"] = Value::String(b64.encode(l));
        }
        if let Some(r) = e.refused {
            v["refused"] = Value::String(r.to_string());
        }
        v
    }

    fn synthetic_json(prefix: &[u8], name: &[u8]) -> Value {
        use base64::Engine;
        let mut full = prefix.to_vec();
        if !full.is_empty() {
            full.push(b'/');
        }
        full.extend_from_slice(name);
        let (display, lossy) = names::display(name);
        json!({
            "id": Value::Null,
            "nameB64": base64::engine::general_purpose::STANDARD.encode(&full),
            "name": display,
            "nameLossy": lossy,
            "kind": "dir",
            "size": "0",
            "csize": "0",
            "mtime": Value::Null,
            "mode": Value::Null,
            "encrypted": false,
            "synthetic": true,
        })
    }

    /// Direct children of `prefix` ("" = root); page bounded by `limit` and by serialised size.
    pub fn list(&self, prefix: &[u8], cursor: usize, limit: usize, max_bytes: usize) -> (Vec<Value>, Option<usize>) {
        let key: Vec<u8> = prefix.strip_suffix(b"/").unwrap_or(prefix).to_vec();
        let kids = match self.children.get(&key) {
            Some(k) => k,
            None => return (Vec::new(), None),
        };
        let mut out = Vec::new();
        let mut bytes = 0usize;
        let mut i = cursor;
        while i < kids.len() && out.len() < limit {
            let v = match &kids[i] {
                Child::Entry(id) => Self::entry_json(&self.entries[*id as usize]),
                Child::Synthetic(name) => Self::synthetic_json(&key, name),
            };
            let size = v.to_string().len() + 1;
            if bytes + size > max_bytes && !out.is_empty() {
                break;
            }
            bytes += size;
            out.push(v);
            i += 1;
        }
        (out, if i < kids.len() { Some(i) } else { None })
    }

    /// Entry, or a synthetic directory when `raw` is an implicit parent.
    pub fn stat(&self, raw: &[u8]) -> Option<Value> {
        if let Some(e) = self.find(raw) {
            return Some(Self::entry_json(e));
        }
        let trimmed = raw.strip_suffix(b"/").unwrap_or(raw);
        if let Some(e) = self.find(trimmed).or_else(|| {
            let mut with = trimmed.to_vec();
            with.push(b'/');
            self.find(&with)
        }) {
            return Some(Self::entry_json(e));
        }
        if self.children.contains_key(trimmed) && !trimmed.is_empty() {
            let (parent, name) = match trimmed.iter().rposition(|b| *b == b'/') {
                Some(p) => (&trimmed[..p], &trimmed[p + 1..]),
                None => (&trimmed[..0], trimmed),
            };
            return Some(Self::synthetic_json(parent, name));
        }
        None
    }
}

impl Index {
    /// Record a symlink target read after the library opened the archive.
    pub fn set_link(&mut self, id: u32, link: Vec<u8>, refused: &'static str) {
        let e = &mut self.entries[id as usize];
        e.link = Some(link);
        e.refused = Some(refused);
    }
}
