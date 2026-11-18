//! Who is on the other end: process ids, owners and executables (macOS).
use std::os::fd::RawFd;
use std::path::PathBuf;

/// The pid of the process on the other end of a connected Unix socket.
pub fn peer_pid(fd: RawFd) -> Option<i32> {
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let r = unsafe { libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERPID, &mut pid as *mut _ as *mut libc::c_void, &mut len) };
    (r == 0 && pid > 0).then_some(pid)
}

pub fn peer_uid(fd: RawFd) -> Option<u32> {
    let (mut uid, mut gid): (libc::uid_t, libc::gid_t) = (0, 0);
    (unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } == 0).then_some(uid)
}

/// The parent pid of a process.
pub fn parent_pid(pid: i32) -> Option<i32> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let r = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    (r == size).then_some(info.pbi_ppid as i32)
}

/// The executable of a process, as the kernel reports it.
pub fn exe_of(pid: i32) -> Option<PathBuf> {
    let mut buf = vec![0u8; 4096];
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    Some(PathBuf::from(String::from_utf8(buf).ok()?))
}

/// Whether the process `pid` runs this very binary (compared by canonical path).
pub fn exe_is_this_binary(pid: i32) -> bool {
    let (Some(theirs), Ok(ours)) = (exe_of(pid), std::env::current_exe()) else { return false };
    match (std::fs::canonicalize(theirs), std::fs::canonicalize(ours)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Whether the process that started this one runs this very binary.
pub fn parent_is_this_binary() -> bool {
    exe_is_this_binary(unsafe { libc::getppid() })
}
