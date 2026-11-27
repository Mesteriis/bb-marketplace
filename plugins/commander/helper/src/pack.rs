//! Archive creation into a private staging file (S14 spec §6). The helper never touches the job target.
use crate::errors::{self, HErr};
use crate::model::Limits;
use crate::names;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use zeroize::Zeroizing;

pub enum Kind {
    Zip,
    Tar,
}

enum Writer {
    Zip(Box<zip::ZipWriter<File>>),
    Tar(File),
}

pub struct Pack {
    kind: Kind,
    writer: Option<Writer>,
    path: Vec<u8>,
    limits: Limits,
    names: HashSet<Vec<u8>>,
    entries: u64,
    total: u64,
    aes: Option<Zeroizing<String>>,
    current: Option<Current>,
    finished: bool,
}

struct Current {
    declared: u64,
    written: u64,
    is_zip: bool,
}

fn create_staging(path: &[u8]) -> Result<File, HErr> {
    if path.is_empty() || path[0] != b'/' || path.contains(&0) {
        return Err(errors::invalid_path("The staging path must be absolute"));
    }
    let c = crate::fsio::path_cstr(path)?;
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600 as libc::c_uint) };
    if fd < 0 {
        let e = std::io::Error::last_os_error();
        return Err(match e.raw_os_error() {
            Some(libc::EEXIST) => HErr::new("already_exists", None, "The staging file already exists"),
            _ => errors::from_io(&e),
        });
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

impl Pack {
    pub fn open(kind: &str, staging: &[u8], aes_password: Option<Zeroizing<Vec<u8>>>, limits: Limits) -> Result<Self, HErr> {
        let file = create_staging(staging)?;
        let (kind, writer) = match kind {
            "zip" => (Kind::Zip, Writer::Zip(Box::new(zip::ZipWriter::new(file)))),
            "tar" => (Kind::Tar, Writer::Tar(file)),
            _ => return Err(errors::unsupported("unsupported_format")),
        };
        let aes = match aes_password {
            Some(p) => Some(Zeroizing::new(String::from_utf8(p.to_vec()).map_err(|_| errors::auth("bad_password"))?)),
            None => None,
        };
        if aes.is_some() && matches!(kind, Kind::Tar) {
            return Err(errors::unsupported("encryption_unsupported"));
        }
        Ok(Pack { kind, writer: Some(writer), path: staging.to_vec(), limits, names: HashSet::new(), entries: 0, total: 0, aes, current: None, finished: false })
    }

    pub fn wants_password(kind: &str, aes: bool) -> bool {
        kind == "zip" && aes
    }

    pub fn add(&mut self, name: &[u8], is_dir: bool, size: u64, mtime: Option<i64>, mode: Option<u32>) -> Result<(), HErr> {
        if self.current.is_some() {
            return Err(errors::invalid("bad_zip"));
        }
        names::check_entry_name(name).map_err(|_| errors::invalid_path("The entry name is refused"))?;
        let mut key = name.to_vec();
        if key.ends_with(b"/") {
            key.pop();
        }
        if !self.names.insert(key) {
            return Err(errors::invalid("duplicate_name"));
        }
        self.entries += 1;
        if self.entries > self.limits.max_entries {
            return Err(errors::limit("too_many_entries"));
        }
        if !is_dir {
            self.total = self.total.checked_add(size).ok_or_else(|| errors::limit("total_bytes"))?;
            if self.total > self.limits.max_total_bytes {
                return Err(errors::limit("total_bytes"));
            }
        }
        let mode = mode.unwrap_or(if is_dir { 0o755 } else { 0o644 }) & 0o7777;
        match self.writer.as_mut().unwrap() {
            Writer::Zip(z) => {
                let mut opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).unix_permissions(mode);
                if size >= 0xFFFF_FFFF {
                    opts = opts.large_file(true);
                }
                if let Some(t) = mtime.and_then(zip_time) {
                    opts = opts.last_modified_time(t);
                }
                let text = std::str::from_utf8(name).map_err(|_| errors::invalid_path("The entry name is not UTF-8"))?;
                if is_dir {
                    z.add_directory(text.trim_end_matches('/'), opts).map_err(|e| zip_write_error(&e))?;
                } else if let Some(pw) = &self.aes {
                    z.start_file(text, opts.with_aes_encryption(zip::AesMode::Aes256, pw.as_str())).map_err(|e| zip_write_error(&e))?;
                } else {
                    z.start_file(text, opts).map_err(|e| zip_write_error(&e))?;
                }
                self.current = if is_dir { None } else { Some(Current { declared: size, written: 0, is_zip: true }) };
            }
            Writer::Tar(f) => {
                tar_header(f, name, is_dir, if is_dir { 0 } else { size }, mtime, mode)?;
                self.current = if is_dir { None } else { Some(Current { declared: size, written: 0, is_zip: false }) };
            }
        }
        Ok(())
    }

    pub fn data(&mut self, bytes: &[u8]) -> Result<u64, HErr> {
        let cur = self.current.as_mut().ok_or_else(|| errors::invalid("bad_zip"))?;
        if cur.written + bytes.len() as u64 > cur.declared {
            return Err(errors::invalid("size_mismatch"));
        }
        match self.writer.as_mut().unwrap() {
            Writer::Zip(z) => z.write_all(bytes).map_err(|e| errors::from_io(&e))?,
            Writer::Tar(f) => f.write_all(bytes).map_err(|e| errors::from_io(&e))?,
        }
        cur.written += bytes.len() as u64;
        Ok(bytes.len() as u64)
    }

    pub fn end_entry(&mut self) -> Result<(), HErr> {
        if let Some(cur) = &self.current {
            if cur.written != cur.declared {
                return Err(errors::invalid("size_mismatch"));
            }
        }
        if let Some(cur) = self.current.take() {
            if !cur.is_zip {
                if let Writer::Tar(f) = self.writer.as_mut().unwrap() {
                    let pad = (512 - cur.declared % 512) % 512;
                    f.write_all(&vec![0u8; pad as usize]).map_err(|e| errors::from_io(&e))?;
                }
            }
        }
        Ok(())
    }

    /// Finish the archive; returns (size, sha256 hex) of the staging file.
    pub fn finish(&mut self) -> Result<(u64, String), HErr> {
        if self.current.is_some() {
            return Err(errors::invalid("size_mismatch"));
        }
        match self.writer.take().ok_or_else(|| errors::invalid("bad_zip"))? {
            Writer::Zip(z) => {
                let f = z.finish().map_err(|e| zip_write_error(&e))?;
                f.sync_all().ok();
            }
            Writer::Tar(mut f) => {
                f.write_all(&[0u8; 1024]).map_err(|e| errors::from_io(&e))?;
                f.sync_all().ok();
            }
        }
        let _ = &self.kind;
        let c = crate::fsio::path_cstr(&self.path)?;
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(errors::from_io(&std::io::Error::last_os_error()));
        }
        let mut f = unsafe { File::from_raw_fd(fd) };
        let mut hasher = Sha256::new();
        let mut size = 0u64;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = f.read(&mut buf).map_err(|e| errors::from_io(&e))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            size += n as u64;
        }
        self.finished = true;
        let digest = hasher.finalize();
        Ok((size, digest.iter().map(|b| format!("{b:02x}")).collect()))
    }

    /// Drop the writer and remove the staging file (a finished one is left to its owner).
    pub fn abort(&mut self) {
        if self.finished {
            return; // the caller owns a finished staging file
        }
        self.writer = None;
        self.current = None;
        if let Ok(c) = crate::fsio::path_cstr(&self.path) {
            unsafe { libc::unlink(c.as_ptr()) };
        }
    }
}

fn zip_write_error(e: &zip::result::ZipError) -> HErr {
    match e {
        zip::result::ZipError::Io(io) => errors::from_io(io),
        zip::result::ZipError::InvalidArchive(_) => errors::invalid("bad_zip"),
        _ => errors::unsupported("unsupported_format"),
    }
}

fn zip_time(t: i64) -> Option<zip::DateTime> {
    if t < 315_532_800 {
        return None;
    }
    let days = t.div_euclid(86_400);
    let rem = t.rem_euclid(86_400);
    // civil from days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    zip::DateTime::from_date_and_time(y as u16, m as u8, d as u8, (rem / 3600) as u8, ((rem / 60) % 60) as u8, (rem % 60) as u8).ok()
}

fn tar_block(name_field: &[u8], typeflag: u8, size: u64, mtime: u64, mode: u32) -> [u8; 512] {
    let mut h = [0u8; 512];
    let n = name_field.len().min(100);
    h[..n].copy_from_slice(&name_field[..n]);
    h[100..107].copy_from_slice(format!("{:07o}", mode & 0o7777).as_bytes());
    h[108..115].copy_from_slice(b"0000000");
    h[116..123].copy_from_slice(b"0000000");
    if size < (1u64 << 33) {
        h[124..135].copy_from_slice(format!("{:011o}", size).as_bytes());
    } else {
        h[124] = 0x80;
        h[128..136].copy_from_slice(&size.to_be_bytes());
    }
    h[136..147].copy_from_slice(format!("{:011o}", mtime).as_bytes());
    h[156] = typeflag;
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    h[148..156].copy_from_slice(b"        ");
    let sum: u32 = h.iter().map(|b| *b as u32).sum();
    h[148..155].copy_from_slice(format!("{:06o}\0", sum).as_bytes());
    h[155] = b' ';
    h
}

fn tar_header(f: &mut File, name: &[u8], is_dir: bool, size: u64, mtime: Option<i64>, mode: u32) -> Result<(), HErr> {
    let mut full = name.to_vec();
    if is_dir && !full.ends_with(b"/") {
        full.push(b'/');
    }
    let mtime = mtime.unwrap_or(0).max(0) as u64;
    if full.len() > 100 {
        // GNU long name record: "././@LongLink", type L, body = name + NUL.
        let mut body = full.clone();
        body.push(0);
        let head = tar_block(b"././@LongLink", b'L', body.len() as u64, 0, 0o644);
        f.write_all(&head).map_err(|e| errors::from_io(&e))?;
        f.write_all(&body).map_err(|e| errors::from_io(&e))?;
        let pad = (512 - body.len() % 512) % 512;
        f.write_all(&vec![0u8; pad]).map_err(|e| errors::from_io(&e))?;
    }
    let head = tar_block(&full, if is_dir { b'5' } else { b'0' }, size, mtime, mode);
    f.write_all(&head).map_err(|e| errors::from_io(&e))
}
