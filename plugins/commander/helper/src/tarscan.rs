//! TAR preflight (S14 spec §5.1): our own bounded header scan runs before `tar::Archive`.
//! Physical headers (L/K/x/g) count against the resource limits, not against the entry count.
use crate::cancel::Ctx;
use crate::errors::{self, HErr};
use crate::fsio::PreadFile;
use crate::model::{Entry, Format, Index, Kind, Limits};
use crate::names;
use std::collections::HashSet;

pub const META_ONE_MAX: u64 = 1 << 20;
pub const META_TOTAL_MAX: u64 = 4 << 20;
const BLOCK: u64 = 512;

fn field_octal(f: &[u8]) -> Result<u64, HErr> {
    let mut v: u64 = 0;
    let mut seen = false;
    for &b in f {
        match b {
            b' ' if !seen => continue,
            b'0'..=b'7' => {
                seen = true;
                v = v.checked_mul(8).and_then(|x| x.checked_add((b - b'0') as u64)).ok_or_else(|| errors::invalid("size_overflow"))?;
            }
            0 | b' ' => break,
            _ => return Err(errors::invalid("bad_tar")),
        }
    }
    Ok(v)
}

/// Octal, or GNU base-256 (high bit of the first byte).
fn field_number(f: &[u8]) -> Result<u64, HErr> {
    if f[0] & 0x80 != 0 {
        if f[0] == 0xff {
            return Err(errors::invalid("bad_tar")); // negative
        }
        let mut v: u128 = (f[0] & 0x7f) as u128;
        for &b in &f[1..] {
            v = (v << 8) | b as u128;
            if v > u64::MAX as u128 {
                return Err(errors::invalid("size_overflow"));
            }
        }
        Ok(v as u64)
    } else {
        field_octal(f)
    }
}

fn cstr(f: &[u8]) -> &[u8] {
    match f.iter().position(|b| *b == 0) {
        Some(p) => &f[..p],
        None => f,
    }
}

fn checksum_ok(h: &[u8; 512]) -> Result<bool, HErr> {
    let stored = field_octal(&h[148..156])?;
    let mut unsigned: u64 = 0;
    let mut signed: i64 = 0;
    for (i, &b) in h.iter().enumerate() {
        let b = if (148..156).contains(&i) { b' ' } else { b };
        unsigned += b as u64;
        signed += (b as i8) as i64;
    }
    Ok(stored == unsigned || (signed >= 0 && stored == signed as u64))
}

/// Parsed PAX records we care about.
#[derive(Default)]
struct Pax {
    path: Option<Vec<u8>>,
    linkpath: Option<Vec<u8>>,
}

/// `<len> key=value\n` records, bounded by the already-validated body.
fn parse_pax(body: &[u8], global: bool) -> Result<Pax, HErr> {
    let mut out = Pax::default();
    let mut i = 0usize;
    while i < body.len() {
        // decimal length
        let mut j = i;
        while j < body.len() && body[j].is_ascii_digit() {
            j += 1;
        }
        if j == i || j >= body.len() || body[j] != b' ' || j - i > 7 {
            return Err(errors::invalid("bad_pax"));
        }
        let len: usize = std::str::from_utf8(&body[i..j]).unwrap().parse().map_err(|_| errors::invalid("bad_pax"))?;
        let end = i.checked_add(len).ok_or_else(|| errors::invalid("bad_pax"))?;
        if len < (j - i) + 3 || end > body.len() || body[end - 1] != b'\n' {
            return Err(errors::invalid("bad_pax"));
        }
        let rec = &body[j + 1..end - 1];
        let eq = rec.iter().position(|b| *b == b'=').ok_or_else(|| errors::invalid("bad_pax"))?;
        let (key, val) = (&rec[..eq], &rec[eq + 1..]);
        match key {
            b"size" => return Err(errors::unsupported("pax_size")),
            k if k.starts_with(b"GNU.sparse") => return Err(errors::unsupported("unsupported_format")),
            b"path" => {
                if global {
                    return Err(errors::unsupported("unsupported_format"));
                }
                out.path = Some(val.to_vec());
            }
            b"linkpath" => {
                if global {
                    return Err(errors::unsupported("unsupported_format"));
                }
                out.linkpath = Some(val.to_vec());
            }
            _ => {}
        }
        i = end;
    }
    Ok(out)
}

pub fn scan(file: &PreadFile, limits: &Limits, ctx: &Ctx) -> Result<Index, HErr> {
    let file_len = file.len();
    let mut off: u64 = 0;
    let mut zero_blocks = 0u8;
    let mut physical: u64 = 0;
    let mut meta_total: u64 = 0;
    let mut entries: Vec<Entry> = Vec::new();
    let mut names_seen: HashSet<Vec<u8>> = HashSet::new();
    let mut total_size: u64 = 0;
    let mut long_name: Option<Vec<u8>> = None;
    let mut long_link: Option<Vec<u8>> = None;
    let mut pax: Option<Pax> = None;

    loop {
        if off == file_len {
            break;
        }
        if off + BLOCK > file_len {
            return Err(errors::invalid("truncated"));
        }
        if physical % 4096 == 0 {
            ctx.check()?;
        }
        let mut h = [0u8; 512];
        file.read_at_exact(off, &mut h).map_err(|e| errors::from_io(&e))?;
        if h.iter().all(|b| *b == 0) {
            zero_blocks += 1;
            off += BLOCK;
            if zero_blocks == 2 {
                break; // end of archive; the rest is ignored
            }
            continue;
        }
        if zero_blocks == 1 {
            return Err(errors::invalid("bad_tar"));
        }
        physical += 1;
        if physical > limits.max_entries.saturating_add(4096) {
            return Err(errors::limit("too_many_entries"));
        }
        if !checksum_ok(&h)? {
            return Err(errors::invalid("bad_tar"));
        }
        let magic = &h[257..263];
        let posix = magic == b"ustar\0";
        let gnu = magic == b"ustar ";
        if !posix && !gnu {
            return Err(errors::unsupported("v7_tar"));
        }
        let typeflag = h[156];
        let size = field_number(&h[124..136])?;
        let is_meta = matches!(typeflag, b'L' | b'K' | b'x' | b'g');
        if is_meta {
            // Size is checked before the body is read, and before the range check.
            if size > META_ONE_MAX {
                return Err(errors::limit("meta_too_large"));
            }
            meta_total += size;
            if meta_total > META_TOTAL_MAX {
                return Err(errors::limit("meta_too_large"));
            }
        }
        let data_start = off.checked_add(BLOCK).ok_or_else(|| errors::invalid("size_overflow"))?;
        let padded = size
            .checked_add(BLOCK - 1)
            .map(|v| v / BLOCK * BLOCK)
            .ok_or_else(|| errors::invalid("size_overflow"))?;
        let next = data_start.checked_add(padded).ok_or_else(|| errors::invalid("size_overflow"))?;
        if next > file_len {
            return Err(errors::invalid("truncated"));
        }
        if is_meta {
            let body = file.read_vec(data_start, size as usize).map_err(|e| errors::from_io(&e))?;
            match typeflag {
                b'L' => long_name = Some(cstr(&body).to_vec()),
                b'K' => long_link = Some(cstr(&body).to_vec()),
                b'x' => pax = Some(parse_pax(&body, false)?),
                _ => {
                    parse_pax(&body, true)?;
                }
            }
            off = next;
            continue;
        }
        let kind = match typeflag {
            0 | b'0' => Kind::File,
            b'5' => Kind::Dir,
            b'2' => Kind::Symlink,
            b'1' => Kind::Hardlink,
            b'3' | b'4' | b'6' => Kind::Special,
            _ => return Err(errors::unsupported("unsupported_format")),
        };
        // Effective name: PAX path > GNU long name > ustar prefix/name.
        let pax_now = pax.take().unwrap_or_default();
        let name: Vec<u8> = if let Some(p) = pax_now.path {
            long_name = None;
            p
        } else if let Some(l) = long_name.take() {
            l
        } else {
            let base = cstr(&h[0..100]);
            let prefix = if posix { cstr(&h[345..500]) } else { &[][..] };
            if prefix.is_empty() {
                base.to_vec()
            } else {
                let mut v = prefix.to_vec();
                v.push(b'/');
                v.extend_from_slice(base);
                v
            }
        };
        let link: Option<Vec<u8>> = if matches!(kind, Kind::Symlink | Kind::Hardlink) {
            Some(pax_now.linkpath.or_else(|| long_link.take()).unwrap_or_else(|| cstr(&h[157..257]).to_vec()))
        } else {
            long_link = None;
            None
        };
        if name.is_empty() {
            return Err(errors::invalid("bad_tar"));
        }
        if name.len() > names::MAX_NAME {
            return Err(errors::limit("name_too_long"));
        }
        if !names_seen.insert(name.clone()) {
            return Err(errors::invalid("duplicate_name"));
        }
        if entries.len() as u64 >= limits.max_entries {
            return Err(errors::limit("too_many_entries"));
        }
        if kind == Kind::File {
            total_size = total_size.checked_add(size).ok_or_else(|| errors::invalid("size_overflow"))?;
            if total_size > limits.max_total_bytes {
                return Err(errors::limit("total_bytes"));
            }
        }
        let refused = match kind {
            Kind::Symlink | Kind::Hardlink => Some(crate::links::classify(&name, link.as_deref().unwrap_or(b""))),
            Kind::Special => Some("special_file"),
            _ => names::check_entry_name(&name).err(),
        };
        let (display, lossy) = names::display(&name);
        let mtime = field_octal(&h[136..148]).ok().map(|v| v as i64);
        let mode = field_octal(&h[100..108]).ok().map(|v| v as u32);
        entries.push(Entry {
            id: entries.len() as u32,
            name_raw: name,
            name: display,
            name_lossy: lossy,
            kind,
            size: if kind == Kind::File { size } else { 0 },
            csize: if kind == Kind::File { size } else { 0 },
            mtime,
            mode,
            encrypted: false,
            aes: false,
            crc32: None,
            link,
            refused,
            data_offset: data_start,
        });
        off = next;
    }
    if long_name.is_some() || long_link.is_some() || pax.is_some() {
        return Err(errors::invalid("bad_tar")); // dangling extension record
    }
    // Tar-ratio is about declared sizes against the file; bodies physically exist, so it is at most 1.
    if total_size > limits.max_ratio.saturating_mul(file_len.max(1)) {
        return Err(errors::limit("ratio"));
    }
    cross_check(file, &entries)?;
    Ok(Index::new(Format::Tar, entries, total_size, total_size, meta_total))
}

/// Second line: the `tar` crate must see the same logical entries and effective names.
fn cross_check(file: &PreadFile, entries: &[Entry]) -> Result<(), HErr> {
    let mut archive = tar::Archive::new(file.clone());
    let iter = archive.entries_with_seek().map_err(|_| errors::invalid("scan_mismatch"))?;
    let mut count = 0usize;
    for item in iter {
        let entry = item.map_err(|_| errors::invalid("scan_mismatch"))?;
        let want = entries.get(count).ok_or_else(|| errors::invalid("scan_mismatch"))?;
        if entry.path_bytes().as_ref() != want.name_raw.as_slice() {
            return Err(errors::invalid("scan_mismatch"));
        }
        count += 1;
    }
    if count != entries.len() {
        return Err(errors::invalid("scan_mismatch"));
    }
    Ok(())
}
