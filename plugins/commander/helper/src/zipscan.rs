//! ZIP/ZIP64 preflight (S14 spec §5.2): our own EOCD / central-directory / local-header parse
//! runs before `ZipArchive::new`, so a hostile directory is refused before the library builds its index.
use crate::cancel::Ctx;
use crate::errors::{self, HErr};
use crate::fsio::PreadFile;
use crate::model::{Entry, Format, Index, Kind, Limits, RATIO_ENTRY_GRACE, RATIO_TOTAL_GRACE};
use crate::names;
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Number of `ZipArchive::new` calls (test counter: refused archives must never reach it).
pub static ARCHIVE_NEW_CALLS: AtomicUsize = AtomicUsize::new(0);

pub const CD_MAX: u64 = 64 << 20;
const NAMES_MAX: u64 = 32 << 20;
const EOCD_SIG: u32 = 0x0605_4b50;
const LOC64_SIG: u32 = 0x0706_4b50;
const EOCD64_SIG: u32 = 0x0606_4b50;
const CEN_SIG: u32 = 0x0201_4b50;
const LOC_SIG: u32 = 0x0403_4b50;

fn u16le(b: &[u8], o: usize) -> u64 {
    u16::from_le_bytes([b[o], b[o + 1]]) as u64
}
fn u32le(b: &[u8], o: usize) -> u64 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as u64
}
fn u64le(b: &[u8], o: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[o..o + 8]);
    u64::from_le_bytes(a)
}

fn io(e: std::io::Error) -> HErr {
    errors::from_io(&e)
}

struct Eocd {
    entries: u64,
    cd_size: u64,
    cd_off: u64,
    /// Upper bound for the directory end (start of the ZIP64 EOCD, or of the EOCD).
    cd_limit: u64,
}

fn find_eocd(file: &PreadFile) -> Result<Eocd, HErr> {
    let len = file.len();
    if len < 22 {
        return Err(errors::invalid("bad_eocd"));
    }
    let tail_len = len.min(22 + 65_535);
    let tail_start = len - tail_len;
    let tail = file.read_vec(tail_start, tail_len as usize).map_err(io)?;
    let mut pos = None;
    let mut p = tail.len() - 22;
    loop {
        if u32le(&tail, p) == EOCD_SIG as u64 {
            let comment = u16le(&tail, p + 20) as usize;
            if p + 22 + comment == tail.len() {
                pos = Some(p);
                break;
            }
        }
        if p == 0 {
            break;
        }
        p -= 1;
    }
    let p = pos.ok_or_else(|| errors::invalid("bad_eocd"))?;
    let eocd_pos = tail_start + p as u64;
    let disk = u16le(&tail, p + 4);
    let cd_disk = u16le(&tail, p + 6);
    let ent_disk = u16le(&tail, p + 8);
    let ent_total = u16le(&tail, p + 10);
    let cd_size = u32le(&tail, p + 12);
    let cd_off = u32le(&tail, p + 16);
    let needs64 = disk == 0xFFFF || cd_disk == 0xFFFF || ent_disk == 0xFFFF || ent_total == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_off == 0xFFFF_FFFF;
    if !needs64 {
        if disk != 0 || cd_disk != 0 || ent_disk != ent_total {
            return Err(errors::invalid("multi_volume"));
        }
        return Ok(Eocd { entries: ent_total, cd_size, cd_off, cd_limit: eocd_pos });
    }
    // ZIP64: locator (20 bytes) directly before the EOCD.
    if eocd_pos < 20 {
        return Err(errors::invalid("bad_zip64"));
    }
    let loc = file.read_vec(eocd_pos - 20, 20).map_err(|_| errors::invalid("bad_zip64"))?;
    if u32le(&loc, 0) != LOC64_SIG as u64 {
        return Err(errors::invalid("bad_zip64"));
    }
    let loc_disk = u32le(&loc, 4);
    let eocd64_off = u64le(&loc, 8);
    let total_disks = u32le(&loc, 16);
    if loc_disk != 0 || total_disks != 1 {
        return Err(errors::invalid("multi_volume"));
    }
    let end = eocd64_off.checked_add(56).ok_or_else(|| errors::invalid("bad_range"))?;
    if end > eocd_pos - 20 {
        return Err(errors::invalid("bad_range"));
    }
    let z = file.read_vec(eocd64_off, 56).map_err(|_| errors::invalid("bad_zip64"))?;
    if u32le(&z, 0) != EOCD64_SIG as u64 {
        return Err(errors::invalid("bad_zip64"));
    }
    let z_disk = u32le(&z, 16);
    let z_cd_disk = u32le(&z, 20);
    let z_ent_disk = u64le(&z, 24);
    let z_ent_total = u64le(&z, 32);
    if z_disk != 0 || z_cd_disk != 0 || z_ent_disk != z_ent_total {
        return Err(errors::invalid("multi_volume"));
    }
    Ok(Eocd { entries: z_ent_total, cd_size: u64le(&z, 40), cd_off: u64le(&z, 48), cd_limit: eocd64_off })
}

struct Cen {
    flags: u64,
    method: u64,
    made_by: u64,
    crc: u32,
    csize: u64,
    usize: u64,
    local_off: u64,
    ext_attr: u64,
    int_attr: u64,
    dos_time: u64,
    dos_date: u64,
    name: Vec<u8>,
    aes_strength: Option<u8>,
    real_method: u64,
}

struct Reader<'a> {
    file: &'a PreadFile,
    pos: u64,
    end: u64,
    buf: Vec<u8>,
    at: usize,
    base: u64,
}

impl<'a> Reader<'a> {
    fn new(file: &'a PreadFile, start: u64, end: u64) -> Self {
        Reader { file, pos: start, end, buf: Vec::new(), at: 0, base: start }
    }
    /// Take exactly `n` bytes of the directory, refilling in <= 64 KiB bounded reads.
    fn take(&mut self, n: usize) -> Result<Vec<u8>, HErr> {
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            if self.at == self.buf.len() {
                if self.pos >= self.end {
                    return Err(errors::invalid("bad_zip"));
                }
                let want = ((self.end - self.pos).min(65_536)) as usize;
                self.buf = self.file.read_vec(self.pos, want).map_err(io)?;
                self.pos += want as u64;
                self.at = 0;
            }
            let k = (n - out.len()).min(self.buf.len() - self.at);
            out.extend_from_slice(&self.buf[self.at..self.at + k]);
            self.at += k;
        }
        Ok(out)
    }
    fn consumed(&self) -> u64 {
        self.pos - self.base - (self.buf.len() - self.at) as u64
    }
}

fn parse_extra(extra: &[u8], c: &mut Cen, need: (bool, bool, bool)) -> Result<(), HErr> {
    // need = (usize, csize, local_off) are 0xFFFFFFFF in the fixed part.
    let mut i = 0;
    while i + 4 <= extra.len() {
        let id = u16le(extra, i);
        let sz = u16le(extra, i + 2) as usize;
        let body_start = i + 4;
        let body_end = body_start.checked_add(sz).ok_or_else(|| errors::invalid("bad_zip"))?;
        if body_end > extra.len() {
            return Err(errors::invalid(if need.0 || need.1 || need.2 { "bad_zip64" } else { "bad_zip" }));
        }
        let body = &extra[body_start..body_end];
        if id == 0x0001 {
            let mut o = 0;
            let mut take = |dst: &mut u64| -> Result<(), HErr> {
                if o + 8 > body.len() {
                    return Err(errors::invalid("bad_zip64"));
                }
                *dst = u64le(body, o);
                o += 8;
                Ok(())
            };
            if need.0 {
                take(&mut c.usize)?;
            }
            if need.1 {
                take(&mut c.csize)?;
            }
            if need.2 {
                take(&mut c.local_off)?;
            }
        } else if id == 0x9901 {
            if body.len() < 7 {
                return Err(errors::invalid("bad_zip"));
            }
            let strength = body[4];
            if !(1..=3).contains(&strength) {
                return Err(errors::unsupported("encryption_unsupported"));
            }
            c.aes_strength = Some(strength);
            c.real_method = u16le(body, 5);
        }
        i = body_end;
    }
    Ok(())
}

pub fn dos_to_unix(date: u64, time: u64) -> Option<i64> {
    if date == 0 {
        return None;
    }
    let (y, m, d) = (1980 + (date >> 9) as i64, ((date >> 5) & 0xF) as i64, (date & 0x1F) as i64);
    let (hh, mm, ss) = ((time >> 11) as i64, ((time >> 5) & 0x3F) as i64, ((time & 0x1F) * 2) as i64);
    if !(1..=12).contains(&m) || d == 0 {
        return None;
    }
    // days from civil
    let yy = if m <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

pub fn scan(file: &PreadFile, limits: &Limits, ctx: &Ctx) -> Result<(Index, Vec<CenInfo>), HErr> {
    let eocd = find_eocd(file)?;
    if eocd.entries > limits.max_entries {
        return Err(errors::limit("too_many_entries"));
    }
    if eocd.cd_size > CD_MAX {
        return Err(errors::limit("directory_too_large"));
    }
    let cd_end = eocd.cd_off.checked_add(eocd.cd_size).ok_or_else(|| errors::invalid("bad_range"))?;
    if cd_end > eocd.cd_limit {
        return Err(errors::invalid("bad_range"));
    }
    let mut rd = Reader::new(file, eocd.cd_off, cd_end);
    let mut cens: Vec<Cen> = Vec::new();
    let mut seen: HashSet<Vec<u8>> = HashSet::new();
    let mut names_bytes: u64 = 0;
    let mut count: u64 = 0;
    while rd.consumed() < eocd.cd_size {
        if count % 4096 == 0 {
            ctx.check()?;
        }
        if count >= eocd.entries {
            return Err(errors::invalid("count_mismatch"));
        }
        if eocd.cd_size - rd.consumed() < 46 {
            return Err(errors::invalid("bad_zip"));
        }
        let h = rd.take(46)?;
        if u32le(&h, 0) != CEN_SIG as u64 {
            return Err(errors::invalid("bad_zip"));
        }
        let (n, m, k) = (u16le(&h, 28) as usize, u16le(&h, 30) as usize, u16le(&h, 32) as usize);
        if n > names::MAX_NAME {
            return Err(errors::limit("name_too_long"));
        }
        if (n + m + k) as u64 > eocd.cd_size - rd.consumed() {
            return Err(errors::invalid("bad_zip"));
        }
        let name = rd.take(n)?;
        let extra = rd.take(m)?;
        rd.take(k)?;
        let disk_start = u16le(&h, 34);
        let mut c = Cen {
            flags: u16le(&h, 8),
            method: u16le(&h, 10),
            made_by: u16le(&h, 4),
            dos_time: u16le(&h, 12),
            dos_date: u16le(&h, 14),
            crc: u32le(&h, 16) as u32,
            csize: u32le(&h, 20),
            usize: u32le(&h, 24),
            local_off: u32le(&h, 42),
            ext_attr: u32le(&h, 38),
            int_attr: u16le(&h, 36),
            name,
            aes_strength: None,
            real_method: 0,
        };
        let need = (c.usize == 0xFFFF_FFFF, c.csize == 0xFFFF_FFFF, c.local_off == 0xFFFF_FFFF);
        parse_extra(&extra, &mut c, need)?;
        if disk_start != 0 && disk_start != 0xFFFF {
            return Err(errors::invalid("multi_volume"));
        }
        if c.flags & 0x40 != 0 {
            return Err(errors::unsupported("encryption_unsupported"));
        }
        let effective = if c.method == 99 { c.real_method } else { c.method };
        if effective != 0 && effective != 8 {
            return Err(errors::unsupported("unsupported_compression"));
        }
        names_bytes += n as u64;
        if names_bytes > NAMES_MAX {
            return Err(errors::limit("meta_too_large"));
        }
        if !seen.insert(c.name.clone()) {
            return Err(errors::invalid("duplicate_name"));
        }
        cens.push(c);
        count += 1;
    }
    if count != eocd.entries || rd.consumed() != eocd.cd_size {
        return Err(errors::invalid("count_mismatch"));
    }

    // Declared sizes against the limits (fast refusal; actual bytes are counted again on read).
    let mut total: u64 = 0;
    let mut total_c: u64 = 0;
    for c in &cens {
        total = total.checked_add(c.usize).ok_or_else(|| errors::invalid("size_overflow"))?;
        total_c = total_c.checked_add(c.csize).ok_or_else(|| errors::invalid("size_overflow"))?;
        if c.usize >= RATIO_ENTRY_GRACE && c.usize > limits.max_ratio.saturating_mul(c.csize) {
            return Err(errors::limit("ratio"));
        }
    }
    if total > limits.max_total_bytes {
        return Err(errors::limit("total_bytes"));
    }
    if total >= RATIO_TOTAL_GRACE && total > limits.max_ratio.saturating_mul(total_c) {
        return Err(errors::limit("ratio"));
    }

    // Local headers: names agree, ranges stay below the directory and do not overlap.
    let mut ranges: Vec<(u64, u64)> = Vec::with_capacity(cens.len());
    for (i, c) in cens.iter().enumerate() {
        if i % 4096 == 0 {
            ctx.check()?;
        }
        let h = file.read_vec(c.local_off, 30).map_err(|_| errors::invalid("bad_range"))?;
        if u32le(&h, 0) != LOC_SIG as u64 {
            return Err(errors::invalid("bad_zip"));
        }
        let (n, m) = (u16le(&h, 26), u16le(&h, 28));
        let start = c.local_off;
        let data_start = start.checked_add(30 + n + m).ok_or_else(|| errors::invalid("bad_range"))?;
        let end = data_start.checked_add(c.csize).ok_or_else(|| errors::invalid("bad_range"))?;
        if end > eocd.cd_off {
            return Err(errors::invalid("bad_range"));
        }
        if n as usize != c.name.len() {
            return Err(errors::invalid("local_name_mismatch"));
        }
        let local_name = file.read_vec(start + 30, n as usize).map_err(io)?;
        if local_name != c.name {
            return Err(errors::invalid("local_name_mismatch"));
        }
        ranges.push((start, end));
    }
    ranges.sort_unstable();
    for w in ranges.windows(2) {
        if w[0].1 > w[1].0 {
            return Err(errors::invalid("overlapping_entries"));
        }
    }

    // Only now does the library see the file.
    ARCHIVE_NEW_CALLS.fetch_add(1, Ordering::SeqCst);
    let infos: Vec<CenInfo> = cens
        .iter()
        .map(|c| CenInfo { name: c.name.clone(), usize: c.usize, csize: c.csize, aes: c.aes_strength.is_some(), encrypted: c.flags & 1 != 0 })
        .collect();
    let mut entries = Vec::with_capacity(cens.len());
    for (i, c) in cens.iter().enumerate() {
        let unix_mode = if c.made_by >> 8 == 3 { Some((c.ext_attr >> 16) as u32) } else { None };
        let fmt = unix_mode.map(|m| m & 0o170000);
        let is_dir_name = c.name.ends_with(b"/");
        let kind = match fmt {
            Some(0o120000) => Kind::Symlink,
            Some(0o040000) => Kind::Dir,
            Some(0o010000) | Some(0o020000) | Some(0o060000) | Some(0o140000) => Kind::Special,
            _ if is_dir_name || c.ext_attr & 0x10 != 0 => Kind::Dir,
            _ => Kind::File,
        };
        let (name_display, lossy) = if c.flags & 0x800 != 0 || std::str::from_utf8(&c.name).is_ok() { names::display(&c.name) } else { (names::cp437(&c.name), false) };
        let refused = match kind {
            Kind::Symlink => Some("link_not_supported"), // refined once the target is read
            Kind::Special => Some("special_file"),
            _ => names::check_entry_name(&c.name).err(),
        };
        let _ = c.int_attr;
        entries.push(Entry {
            id: i as u32,
            name_raw: c.name.clone(),
            name: name_display,
            name_lossy: lossy,
            kind,
            size: if kind == Kind::Dir { 0 } else { c.usize },
            csize: c.csize,
            mtime: dos_to_unix(c.dos_date, c.dos_time),
            mode: unix_mode.map(|m| m & 0o7777),
            encrypted: c.flags & 1 != 0,
            aes: c.aes_strength.is_some(),
            crc32: Some(c.crc),
            link: None,
            refused,
            data_offset: 0,
        });
    }
    Ok((Index::new(Format::Zip, entries, total, total_c, names_bytes), infos))
}

/// What the reader needs from the directory (kept to cross-check the library's index).
#[derive(Clone, Debug)]
pub struct CenInfo {
    pub name: Vec<u8>,
    pub usize: u64,
    pub csize: u64,
    pub aes: bool,
    pub encrypted: bool,
}
