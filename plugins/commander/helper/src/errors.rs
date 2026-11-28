//! Error model. `code` is a Commander `ErrorCode`, `reason` a member of the closed
//! `ArchiveReason` set for that code (docs/slices/S14-archives.md §10). Messages are fixed
//! strings: they never carry paths, entry names or archive bytes.

#[derive(Debug, Clone)]
pub struct HErr {
    pub code: &'static str,
    pub reason: Option<&'static str>,
    pub message: &'static str,
    pub retryable: bool,
}

impl HErr {
    pub const fn new(code: &'static str, reason: Option<&'static str>, message: &'static str) -> Self {
        HErr { code, reason, message, retryable: false }
    }
}

pub fn invalid(reason: &'static str) -> HErr {
    HErr::new("invalid_archive", Some(reason), "The archive is damaged or has an unsupported structure")
}
pub fn limit(reason: &'static str) -> HErr {
    HErr::new("limit_exceeded", Some(reason), "An archive limit was exceeded")
}
pub fn unsupported(reason: &'static str) -> HErr {
    HErr::new("unsupported", Some(reason), "This archive format or variant is not supported")
}
pub fn auth(reason: &'static str) -> HErr {
    HErr::new("auth_failed", Some(reason), "A password is required or it is wrong")
}
pub fn internal(reason: &'static str) -> HErr {
    HErr::new("internal", Some(reason), "The archive helper failed")
}
pub fn invalid_path(message: &'static str) -> HErr {
    HErr::new("invalid_path", None, message)
}
pub fn changed_since_open() -> HErr {
    HErr::new("changed_since_plan", None, "The archive changed on disk")
}
pub fn cancelled() -> HErr {
    HErr::new("cancelled", None, "Cancelled")
}
pub fn no_space() -> HErr {
    HErr::new("no_space", None, "Not enough space for the temporary file")
}

/// Map a std io error from archive reading into a helper error.
pub fn from_io(e: &std::io::Error) -> HErr {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound => HErr::new("not_found", None, "Not found"),
        PermissionDenied => HErr::new("permission_denied", None, "Permission denied"),
        UnexpectedEof => invalid("truncated"),
        InvalidData => invalid("bad_zip"),
        _ => match e.raw_os_error() {
            Some(libc::ENOSPC) => no_space(),
            _ => internal("helper_crashed"),
        },
    }
}
