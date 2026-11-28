//! File access: root-relative `openat` walk (S14 spec §3) and a positional reader.
use crate::errors::{self, HErr};
use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Bytes read through `PreadFile` (test counter only).
pub static BYTES_READ: AtomicU64 = AtomicU64::new(0);

/// macOS rejects O_NOFOLLOW together with O_NOFOLLOW_ANY (EINVAL); O_NOFOLLOW_ANY alone refuses a
/// symlink in *any* path component, including the last, which is the stronger of the two.
#[cfg(target_os = "macos")]
const NO_LINKS: libc::c_int = 0x2000_0000;
#[cfg(not(target_os = "macos"))]
const NO_LINKS: libc::c_int = libc::O_NOFOLLOW;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint {
    pub size: u64,
    pub mtime_ns: u64,
    pub dev: u64,
    pub ino: u64,
}

impl Fingerprint {
    pub fn of(file: &File) -> io::Result<Self> {
        let m = file.metadata()?;
        Ok(Fingerprint { size: m.len(), mtime_ns: (m.mtime() as u64).wrapping_mul(1_000_000_000).wrapping_add(m.mtime_nsec() as u64), dev: m.dev() as u64, ino: m.ino() })
    }
}

fn map_errno(err: io::Error) -> HErr {
    match err.raw_os_error() {
        Some(libc::ENOENT) => HErr::new("not_found", None, "Not found"),
        Some(libc::EACCES) | Some(libc::EPERM) => HErr::new("permission_denied", None, "Permission denied"),
        Some(libc::ELOOP) | Some(libc::ENOTDIR) | Some(libc::EISDIR) => errors::invalid_path("The path is not a regular file reached without links"),
        _ => errors::internal("helper_crashed"),
    }
}

fn open_at(dir: RawFd, name: &[u8], flags: libc::c_int) -> io::Result<OwnedFd> {
    let c = CString::new(name).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    let fd = unsafe { libc::openat(dir, c.as_ptr(), flags | libc::O_CLOEXEC | NO_LINKS, 0) };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

/// Walk `segments` below the absolute directory `root`, refusing links at every step.
/// Returns the opened regular file.
pub fn open_walk(root: &[u8], segments: &[Vec<u8>]) -> Result<File, HErr> {
    if root.is_empty() || root[0] != b'/' || root.contains(&0) {
        return Err(errors::invalid_path("The root must be an absolute path"));
    }
    if segments.is_empty() {
        return Err(errors::invalid_path("The path has no segments"));
    }
    for s in segments {
        if s.is_empty() || s == b"." || s == b".." || s.contains(&b'/') || s.contains(&0) {
            return Err(errors::invalid_path("The path contains an invalid segment"));
        }
    }
    let croot = CString::new(root).map_err(|_| errors::invalid_path("The root must be an absolute path"))?;
    let rfd = unsafe { libc::open(croot.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | NO_LINKS) };
    if rfd < 0 {
        return Err(map_errno(io::Error::last_os_error()));
    }
    let mut dir = unsafe { OwnedFd::from_raw_fd(rfd) };
    let last = segments.len() - 1;
    for (i, seg) in segments.iter().enumerate() {
        if i < last {
            dir = open_at(dir.as_raw_fd(), seg, libc::O_RDONLY | libc::O_DIRECTORY).map_err(map_errno)?;
        } else {
            let fd = open_at(dir.as_raw_fd(), seg, libc::O_RDONLY).map_err(map_errno)?;
            let file = File::from(fd);
            let meta = file.metadata().map_err(|e| map_errno(e))?;
            if !meta.is_file() {
                return Err(errors::invalid_path("The path is not a regular file"));
            }
            return Ok(file);
        }
    }
    unreachable!()
}

thread_local! {
    /// The counter of the clone made last on this thread (see `PreadFile::clone`).
    static LAST_FORK: std::cell::RefCell<Option<Arc<AtomicU64>>> = const { std::cell::RefCell::new(None) };
}

/// The compressed-input counter of the `PreadFile` clone made last on this thread, if any.
pub fn take_last_fork() -> Option<Arc<AtomicU64>> {
    LAST_FORK.with(|l| l.borrow_mut().take())
}

/// Positional reader over a shared file: every reader keeps its own offset, none moves the file cursor.
/// A clone counts its own compressed input (a stream's ZipArchive is a clone), so streams do not mix.
pub struct PreadFile {
    file: Arc<File>,
    pos: u64,
    len: u64,
    /// Bytes pulled through `Read` by any clone (the ZIP library's compressed input).
    consumed: Arc<AtomicU64>,
}

impl Clone for PreadFile {
    fn clone(&self) -> Self {
        let consumed = Arc::new(AtomicU64::new(0));
        LAST_FORK.with(|l| *l.borrow_mut() = Some(consumed.clone()));
        PreadFile { file: self.file.clone(), pos: self.pos, len: self.len, consumed }
    }
}

impl PreadFile {
    pub fn new(file: Arc<File>) -> io::Result<Self> {
        let len = file.metadata()?.len();
        Ok(PreadFile { file, pos: 0, len, consumed: Arc::new(AtomicU64::new(0)) })
    }
    pub fn consumed(&self) -> u64 {
        self.consumed.load(Ordering::Relaxed)
    }
    pub fn len(&self) -> u64 {
        self.len
    }
    pub fn read_at_exact(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        let mut done = 0;
        while done < buf.len() {
            let n = self.file.read_at(&mut buf[done..], offset + done as u64)?;
            if n == 0 {
                return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
            }
            BYTES_READ.fetch_add(n as u64, Ordering::Relaxed);
            done += n;
        }
        Ok(())
    }
    pub fn fingerprint(&self) -> io::Result<Fingerprint> {
        Fingerprint::of(&self.file)
    }
    pub fn read_vec(&self, offset: u64, len: usize) -> io::Result<Vec<u8>> {
        let mut v = vec![0u8; len];
        self.read_at_exact(offset, &mut v)?;
        Ok(v)
    }
}

impl Read for PreadFile {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len {
            return Ok(0);
        }
        let n = self.file.read_at(buf, self.pos)?;
        BYTES_READ.fetch_add(n as u64, Ordering::Relaxed);
        self.consumed.fetch_add(n as u64, Ordering::Relaxed);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for PreadFile {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let target = match from {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::End(d) => self.len.checked_add_signed(d),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
        };
        match target {
            Some(t) => {
                self.pos = t;
                Ok(t)
            }
            None => Err(io::Error::from(io::ErrorKind::InvalidInput)),
        }
    }
}

pub fn path_cstr(p: &[u8]) -> Result<CString, HErr> {
    CString::new(p).map_err(|_| errors::invalid_path("The path contains NUL"))
}

#[allow(dead_code)]
pub fn os_bytes(p: &std::path::Path) -> &[u8] {
    p.as_os_str().as_bytes()
}
