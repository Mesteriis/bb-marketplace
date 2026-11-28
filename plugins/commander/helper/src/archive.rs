//! An opened archive: index, positional file, stream state and the byte counters of S14 spec §5.3.
use crate::cancel::Ctx;
use crate::errors::{self, HErr};
use crate::fsio::{self, Fingerprint, PreadFile};
use crate::links;
use crate::names;
use crate::model::{Format, Index, Kind, Limits, RATIO_ENTRY_GRACE, RATIO_TOTAL_GRACE};
use crate::tarscan;
use crate::zipscan::{self, CenInfo};
use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use zeroize::Zeroizing;

/// Decode buffer: every counter check happens at most this many output bytes apart.
pub const STEP: usize = 8 * 1024;

pub struct OpenArchive {
    pub index: Index,
    pub limits: Limits,
    pub root: Vec<u8>,
    pub segments: Vec<Vec<u8>>,
    pub fingerprint: Fingerprint,
    file: PreadFile,
    zip: Option<*mut zip::ZipArchive<PreadFile>>,
    infos: Vec<CenInfo>,
    streams: Vec<Stream>,
    next_stream: u32,
    out_total: u64,
    in_total: u64,
    pub password: Option<Zeroizing<Vec<u8>>>,
    pub bad_passwords: u8,
}

enum Reading {
    Zip(zip::read::ZipFile<'static, PreadFile>),
    Tar { pos: u64 },
}

/// At most this many read streams are open at once; each has its own decoder and file cursor.
pub const MAX_STREAMS: usize = 4;

struct Stream {
    id: u32,
    entry: u32,
    /// Declared before `_owner`: the ZipFile must be dropped while its archive still exists.
    reading: Reading,
    _owner: Option<Box<zip::ZipArchive<PreadFile>>>,
    /// Compressed input of this stream alone.
    counter: Arc<AtomicU64>,
    out: u64,
    size: u64,
    /// Compressed bytes charged to this entry so far (declared size once the entry ends).
    csize: u64,
    in_counted: u64,
    in_base: u64,
    finished: bool,
}

/// The library's own name check as a verdict: `true` = it refuses the name. A record the library cannot
/// even locate is a refusal of the archive (`bad_zip`); the check is never skipped.
pub fn enclosed_verdict(found: zip::result::ZipResult<bool>) -> Result<bool, HErr> {
    found.map_err(|_| errors::invalid("bad_zip"))
}

pub fn zip_error(e: &zip::result::ZipError, entry: &crate::model::Entry) -> HErr {
    use zip::result::ZipError::*;
    match e {
        InvalidPassword => errors::auth("bad_password"),
        UnsupportedArchive(_) => errors::unsupported("unsupported_format"),
        Io(io) => io_in_entry(io, entry),
        _ => errors::invalid("bad_zip"),
    }
}

fn io_in_entry(e: &std::io::Error, entry: &crate::model::Entry) -> HErr {
    use std::io::ErrorKind::*;
    match e.kind() {
        UnexpectedEof => errors::invalid("truncated"),
        InvalidData => {
            if entry.aes {
                errors::invalid("aes_auth_failed")
            } else if entry.encrypted {
                errors::auth("bad_password")
            } else {
                errors::invalid("crc_mismatch")
            }
        }
        _ => errors::from_io(e),
    }
}

impl OpenArchive {
    pub fn open(root: &[u8], segments: &[Vec<u8>], format: &str, limits: Limits, expect: Fingerprint, ctx: &Ctx) -> Result<Self, HErr> {
        let file = fsio::open_walk(root, segments)?;
        let fp = Fingerprint::of(&file).map_err(|e| errors::from_io(&e))?;
        // First comparison: the opened descriptor against the caller's own stat, before any parsing.
        if fp != expect {
            return Err(errors::changed_since_open());
        }
        Self::open_file(file, root, segments, format, limits, fp, ctx)
    }

    fn open_file(file: File, root: &[u8], segments: &[Vec<u8>], format: &str, limits: Limits, fp: Fingerprint, ctx: &Ctx) -> Result<Self, HErr> {
        let pread = PreadFile::new(Arc::new(file)).map_err(|e| errors::from_io(&e))?;
        let want = match format {
            "zip" => Format::Zip,
            "tar" => Format::Tar,
            "auto" => detect(&pread)?,
            _ => return Err(errors::unsupported("unsupported_format")),
        };
        let (index, infos, zip) = match want {
            Format::Tar => (tarscan::scan(&pread, &limits, ctx)?, Vec::new(), None),
            Format::Zip => {
                let (mut index, infos) = zipscan::scan(&pread, &limits, ctx)?;
                let archive = zip::ZipArchive::new(pread.clone()).map_err(|e| match e {
                    zip::result::ZipError::Io(io) => errors::from_io(&io),
                    _ => errors::invalid("bad_zip"),
                })?;
                if archive.len() != index.entries.len() {
                    return Err(errors::invalid("scan_mismatch"));
                }
                // One archive per process: the leaked box lives as long as the helper.
                let ptr = Box::into_raw(Box::new(archive));
                // Symlink targets decide link_escapes.
                for i in 0..index.entries.len() {
                    let e = &index.entries[i];
                    if e.kind == Kind::Symlink && !e.encrypted && e.size <= 4096 {
                        // SAFETY: single-threaded access, no ZipFile alive at this point.
                        let archive = unsafe { &mut *ptr };
                        if let Ok(mut f) = archive.by_index(i) {
                            let mut target = Vec::new();
                            if f.by_ref().take(4097).read_to_end(&mut target).is_ok() {
                                let reason = links::classify(&e.name_raw, &target);
                                index.set_link(i as u32, target, reason);
                            }
                        }
                    }
                }
                // Second line: the library's own name check, after our raw-segment check.
                for i in 0..index.entries.len() {
                    let e = &index.entries[i];
                    if e.refused.is_some() || !matches!(e.kind, Kind::File | Kind::Dir) {
                        continue;
                    }
                    // SAFETY: single-threaded access, no ZipFile alive at this point.
                    let archive = unsafe { &mut *ptr };
                    // A record the library cannot even locate is a refusal of the archive, not a skipped check.
                    let verdict = enclosed_verdict(archive.by_index_raw(i).map(|f| f.enclosed_name().is_none()));
                    let none = match verdict {
                        Ok(none) => none,
                        Err(e) => {
                            // SAFETY: no ZipFile is alive; nothing else points at the box on this path.
                            drop(unsafe { Box::from_raw(ptr) });
                            return Err(e);
                        }
                    };
                    if let Some(reason) = names::second_line(none, None) {
                        index.refuse(i as u32, reason);
                    }
                }
                (index, infos, Some(ptr))
            }
        };
        Ok(OpenArchive {
            index,
            limits,
            root: root.to_vec(),
            segments: segments.to_vec(),
            fingerprint: fp,
            file: pread,
            zip,
            infos,
            streams: Vec::new(),
            next_stream: 1,
            out_total: 0,
            in_total: 0,
            password: None,
            bad_passwords: 0,
        })
    }

    /// Re-walk from the root (no path string is trusted) and compare with the opening fingerprint.
    pub fn verify(&self) -> Result<(), HErr> {
        let file = fsio::open_walk(&self.root, &self.segments).map_err(|_| errors::changed_since_open())?;
        let now = Fingerprint::of(&file).map_err(|_| errors::changed_since_open())?;
        if now != self.fingerprint {
            return Err(errors::changed_since_open());
        }
        // The descriptor we hold must be the very same file as well.
        if let Ok(held) = Fingerprint::of_pread(&self.file) {
            if held != self.fingerprint {
                return Err(errors::changed_since_open());
            }
        }
        Ok(())
    }

    pub fn needs_password(&self, id: u32) -> bool {
        self.index.entries.get(id as usize).is_some_and(|e| e.encrypted)
    }

    /// Open a read stream for entry `id`. Up to MAX_STREAMS streams are open at once, each independent.
    pub fn read_open(&mut self, id: u32) -> Result<(u32, u64), HErr> {
        self.verify()?;
        let entry = self.index.entries.get(id as usize).ok_or_else(|| errors::invalid_path("No such entry"))?.clone();
        match entry.kind {
            Kind::File => {}
            Kind::Dir => return Err(HErr::new("is_a_directory", None, "The entry is a directory")),
            Kind::Symlink | Kind::Hardlink => return Err(errors::unsupported(if entry.refused == Some("link_escapes") { "link_escapes" } else { "link_not_supported" })),
            Kind::Special => return Err(errors::unsupported("unsupported_format")),
        }
        if entry.refused == Some(names::UNSAFE_NAME) {
            return Err(errors::invalid_path("The entry name is refused"));
        }
        if self.streams.len() >= MAX_STREAMS {
            return Err(errors::invalid_path("Too many open streams"));
        }
        let (reading, owner, counter) = match self.index.format {
            Format::Tar => (Reading::Tar { pos: 0 }, None, Arc::new(AtomicU64::new(0))),
            Format::Zip => {
                let info = &self.infos[id as usize];
                if info.name != entry.name_raw {
                    return Err(errors::invalid("scan_mismatch"));
                }
                // A stream decodes on a clone of the archive: shared metadata, its own reader and counter.
                // SAFETY: `zip` is non-null for ZIP archives and is only cloned from after the index was built.
                let mut owned = Box::new(unsafe { &*self.zip.unwrap() }.clone());
                let counter = fsio::take_last_fork().unwrap_or_else(|| Arc::new(AtomicU64::new(0)));
                let ptr: *mut zip::ZipArchive<PreadFile> = &mut *owned;
                // SAFETY: the box is stored in the same Stream, after the ZipFile, so it outlives it; its address is stable.
                let archive: &'static mut zip::ZipArchive<PreadFile> = unsafe { &mut *ptr };
                let file = if entry.encrypted {
                    let pw = self.password.as_ref().ok_or_else(|| errors::auth("password_required"))?;
                    match archive.by_index_decrypt(id as usize, pw) {
                        Ok(f) => f,
                        Err(zip::result::ZipError::InvalidPassword) => return Err(self.wrong_password()),
                        Err(e) => return Err(zip_error(&e, &entry)),
                    }
                } else {
                    archive.by_index(id as usize).map_err(|e| zip_error(&e, &entry))?
                };
                if file.name_raw() != entry.name_raw.as_slice() {
                    return Err(errors::invalid("scan_mismatch"));
                }
                (Reading::Zip(file), Some(owned), counter)
            }
        };
        let sid = self.next_stream;
        self.next_stream += 1;
        let in_base = counter.load(Ordering::Relaxed);
        self.streams.push(Stream { id: sid, entry: id, reading, _owner: owner, counter, out: 0, size: entry.size, csize: entry.csize, in_counted: 0, in_base, finished: false });
        Ok((sid, entry.size))
    }

    pub fn wrong_password(&mut self) -> HErr {
        self.bad_passwords = self.bad_passwords.saturating_add(1);
        self.password = None;
        errors::auth("bad_password")
    }

    fn stream_mut(&mut self, sid: u32) -> Result<&mut Stream, HErr> {
        self.streams.iter_mut().find(|s| s.id == sid).ok_or_else(|| errors::invalid_path("No such stream"))
    }

    /// Read up to `length` bytes; counters are checked every STEP bytes, before the data is returned.
    pub fn read(&mut self, sid: u32, length: usize, ctx: &Ctx) -> Result<Vec<u8>, HErr> {
        self.verify()?;
        let limits = self.limits;
        let (mut out_total, mut in_total) = (self.out_total, self.in_total);
        let file = self.file.clone();
        let entries = &self.index.entries;
        let stream = match self.streams.iter_mut().find(|s| s.id == sid) {
            Some(s) => s,
            None => return Err(errors::invalid_path("No such stream")),
        };
        let entry = entries[stream.entry as usize].clone();
        let mut data: Vec<u8> = Vec::new();
        let want = length.min(stream.size.saturating_sub(stream.out) as usize);
        while data.len() < want {
            ctx.check()?;
            let remaining = stream.size - stream.out;
            let step = STEP.min(want - data.len());
            let mut buf = vec![0u8; step];
            let n = match &mut stream.reading {
                Reading::Tar { pos } => {
                    let n = step.min((stream.size - *pos) as usize);
                    file.read_at_exact(entry.data_offset + *pos, &mut buf[..n]).map_err(|e| errors::from_io(&e))?;
                    *pos += n as u64;
                    n
                }
                Reading::Zip(f) => {
                    // Never ask for more than one byte past the declared size.
                    let ask = step.min(remaining as usize + 1);
                    let n = f.read(&mut buf[..ask]).map_err(|e| io_in_entry(&e, &entry))?;
                    if n as u64 > remaining {
                        return Err(errors::invalid("size_mismatch"));
                    }
                    if n == 0 {
                        return Err(errors::invalid("truncated"));
                    }
                    n
                }
            };
            if n == 0 {
                return Err(errors::invalid("truncated"));
            }
            stream.out += n as u64;
            out_total += n as u64;
            // Compressed input charged so far: declared size, scaled by progress; never more than declared.
            let in_entry = match &stream.reading {
                Reading::Tar { .. } => stream.out.max(1),
                Reading::Zip(_) => stream.csize.max(1).min((stream.counter.load(Ordering::Relaxed) - stream.in_base).max(1)),
            };
            let in_entry = in_entry.max(stream.in_counted);
            in_total += in_entry - stream.in_counted;
            stream.in_counted = in_entry;
            check_counters(&limits, out_total, in_total, stream.out, in_entry)?;
            data.extend_from_slice(&buf[..n]);
        }
        self.out_total = out_total;
        self.in_total = in_total;
        Ok(data)
    }

    /// Integrity barrier (spec §4): read to EOF, check size, CRC and authentication.
    pub fn read_finish(&mut self, sid: u32, ctx: &Ctx) -> Result<(u64, Option<u32>, Option<bool>), HErr> {
        let entry_id = self.stream_mut(sid)?.entry;
        let entry = self.index.entries[entry_id as usize].clone();
        let remaining = {
            let s = self.stream_mut(sid)?;
            s.size - s.out
        };
        let mut left = remaining;
        while left > 0 {
            ctx.check()?;
            let chunk = left.min(64 * 1024) as usize;
            let got = self.read(sid, chunk, ctx)?;
            if got.is_empty() {
                return Err(errors::invalid("truncated"));
            }
            left -= got.len() as u64;
        }
        let is_zip = self.index.format == Format::Zip;
        let s = self.stream_mut(sid)?;
        if s.out != s.size {
            return Err(errors::invalid("size_mismatch"));
        }
        if let Reading::Zip(f) = &mut s.reading {
            // A read at EOF makes the library compare CRC32 / the AES authentication code.
            let mut probe = [0u8; 1];
            match f.read(&mut probe) {
                Ok(0) => {}
                Ok(_) => return Err(errors::invalid("size_mismatch")),
                Err(e) => return Err(io_in_entry(&e, &entry)),
            }
        }
        s.finished = true;
        let crc = if is_zip { entry.crc32 } else { None };
        let aes = if entry.encrypted && entry.aes { Some(true) } else { None };
        Ok((s.size, crc, aes))
    }

    pub fn read_close(&mut self, sid: u32) -> Result<(), HErr> {
        self.stream_mut(sid)?;
        self.streams.retain(|s| s.id != sid);
        Ok(())
    }

    pub fn stream_pos(&self, sid: u32) -> u64 {
        self.streams.iter().find(|s| s.id == sid).map(|s| s.out).unwrap_or(0)
    }

    pub fn close_streams(&mut self) {
        self.streams.clear();
    }
}

fn check_counters(l: &Limits, out_total: u64, in_total: u64, out_entry: u64, in_entry: u64) -> Result<(), HErr> {
    if out_total > l.max_total_bytes {
        return Err(errors::limit("total_bytes"));
    }
    if out_entry >= RATIO_ENTRY_GRACE && out_entry > l.max_ratio.saturating_mul(in_entry) {
        return Err(errors::limit("ratio"));
    }
    if out_total >= RATIO_TOTAL_GRACE && out_total > l.max_ratio.saturating_mul(in_total) {
        return Err(errors::limit("ratio"));
    }
    Ok(())
}

fn detect(f: &PreadFile) -> Result<Format, HErr> {
    let mut head = [0u8; 4];
    if f.len() >= 4 && f.read_at_exact(0, &mut head).is_ok() && (&head == b"PK\x03\x04" || &head == b"PK\x05\x06") {
        return Ok(Format::Zip);
    }
    if f.len() >= 512 {
        let mut magic = [0u8; 5];
        if f.read_at_exact(257, &mut magic).is_ok() && &magic == b"ustar" {
            return Ok(Format::Tar);
        }
    }
    // An empty or non-ustar start: ZIP archives whose first record is not a local header
    // (e.g. empty ZIP) end with an EOCD; otherwise unsupported.
    if f.len() >= 22 {
        return Ok(Format::Zip);
    }
    Err(errors::unsupported("unsupported_format"))
}

impl Fingerprint {
    pub fn of_pread(f: &PreadFile) -> std::io::Result<Fingerprint> {
        f.fingerprint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_the_library_cannot_read_refuses_the_archive_instead_of_skipping_the_check() {
        let e = enclosed_verdict(Err(zip::result::ZipError::FileNotFound)).unwrap_err();
        assert_eq!((e.code, e.reason), ("invalid_archive", Some("bad_zip")));
        let e = enclosed_verdict(Err(zip::result::ZipError::InvalidArchive("Invalid local file header".into()))).unwrap_err();
        assert_eq!(e.reason, Some("bad_zip"));
    }

    #[test]
    fn a_readable_record_gives_the_librarys_verdict() {
        assert!(enclosed_verdict(Ok(true)).unwrap());
        assert!(!enclosed_verdict(Ok(false)).unwrap());
    }
}
