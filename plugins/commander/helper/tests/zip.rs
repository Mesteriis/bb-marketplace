mod common;
use common::*;
use serde_json::json;

fn open_zip(bytes: &[u8]) -> (Helper, Out) {
    open_zip_limits(bytes, json!({}))
}

fn open_zip_limits(bytes: &[u8], limits: serde_json::Value) -> (Helper, Out) {
    let dir = tmpdir();
    let p = write(&dir, "a.zip", bytes);
    let mut h = Helper::spawn();
    let r = h.open_with(&p, limits);
    (h, r)
}

fn refusal(out: Out) -> (String, String) {
    let (c, r) = out.err();
    (c, r.unwrap_or_default())
}

fn pair(code: &str, reason: &str) -> (String, String) {
    (code.to_string(), reason.to_string())
}

#[test]
fn valid_zip_lists_reads_and_verifies_crc() {
    let z = zip(&[ZEntry::stored(b"a.txt", b"hello"), ZEntry::deflated(b"d/b.txt", &vec![b'x'; 5000]), ZEntry::stored(b"empty", b"")]);
    let (mut h, r) = open_zip(&z.bytes);
    let v = r.ok();
    assert_eq!((v["format"].as_str().unwrap(), v["entries"].as_u64().unwrap()), ("zip", 3));
    assert_eq!(v["totalSize"], "5005");
    assert_eq!(h.read_entry(0, None).unwrap(), b"hello");
    assert_eq!(h.read_entry(1, None).unwrap(), vec![b'x'; 5000]);
    assert_eq!(h.read_entry(2, None).unwrap(), b"");
    let root: Vec<String> = h.list_root().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(root, ["a.txt", "d", "empty"]);
    assert_eq!(h.counters()["zipNewCalls"], 1);
}

#[test]
fn crc_mismatch_is_refused_at_the_barrier() {
    let mut e = ZEntry::stored(b"a.txt", b"hello");
    e.crc ^= 1;
    let (mut h, r) = open_zip(&zip(&[e]).bytes);
    r.ok();
    assert_eq!(h.read_entry(0, None).unwrap_err(), ("invalid_archive".to_string(), Some("crc_mismatch".to_string())));
}

#[test]
fn entry_count_above_the_limit_never_reaches_the_library() {
    // 100 001 empty entries.
    let entries: Vec<ZEntry> = (0..100_001u32).map(|i| ZEntry::stored(format!("e{i}").as_bytes(), b"")).collect();
    let z = zip_with_count(&entries);
    let (mut h, r) = open_zip(&z);
    assert_eq!(refusal(r), pair("limit_exceeded", "too_many_entries"));
    assert_eq!(h.counters()["zipNewCalls"], 0);
}

/// ZIP with more than 65 535 entries needs ZIP64 end-of-directory records.
fn zip_with_count(entries: &[ZEntry]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut cd = Vec::new();
    for e in entries {
        let off = bytes.len() as u32;
        let loc = {
            let mut v = Vec::new();
            v.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            v.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0]);
            v.extend_from_slice(&e.crc.to_le_bytes());
            v.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
            v.extend_from_slice(&(e.usize as u32).to_le_bytes());
            v.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            v.extend_from_slice(&0u16.to_le_bytes());
            v.extend_from_slice(&e.name);
            v
        };
        bytes.extend(loc);
        bytes.extend_from_slice(&e.data);
        let mut c = Vec::new();
        c.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        c.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0]);
        c.extend_from_slice(&e.crc.to_le_bytes());
        c.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
        c.extend_from_slice(&(e.usize as u32).to_le_bytes());
        c.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        c.extend_from_slice(&[0u8; 12]); // extra, comment, disk, internal and external attributes
        c.extend_from_slice(&off.to_le_bytes());
        c.extend_from_slice(&e.name);
        cd.extend(c);
    }
    let cd_off = bytes.len() as u64;
    let cd_size = cd.len() as u64;
    bytes.extend(cd);
    let eocd64_off = bytes.len() as u64;
    let mut z = Vec::new();
    z.extend_from_slice(&0x0606_4b50u32.to_le_bytes());
    z.extend_from_slice(&44u64.to_le_bytes());
    z.extend_from_slice(&[45, 0, 45, 0]);
    z.extend_from_slice(&0u32.to_le_bytes());
    z.extend_from_slice(&0u32.to_le_bytes());
    z.extend_from_slice(&(entries.len() as u64).to_le_bytes());
    z.extend_from_slice(&(entries.len() as u64).to_le_bytes());
    z.extend_from_slice(&cd_size.to_le_bytes());
    z.extend_from_slice(&cd_off.to_le_bytes());
    bytes.extend(z);
    bytes.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&eocd64_off.to_le_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend(eocd(0xFFFF, 0xFFFF_FFFF, 0xFFFF_FFFF, 0, b""));
    bytes
}

#[test]
fn exactly_100_000_entries_pass_the_preflight() {
    let entries: Vec<ZEntry> = (0..100_000u32).map(|i| ZEntry::stored(format!("e{i}").as_bytes(), b"")).collect();
    let z = zip_with_count(&entries);
    let (mut h, r) = open_zip(&z);
    assert_eq!(r.ok()["entries"], 100_000);
    assert_eq!(h.counters()["zipNewCalls"], 1);
}

#[test]
fn directory_larger_than_64_mib_is_refused_before_the_library() {
    let mut bytes = vec![0u8; 100];
    bytes.extend(eocd(1, (64 << 20) + 1, 0, 0, b""));
    let (mut h, r) = open_zip(&bytes);
    assert_eq!(refusal(r), pair("limit_exceeded", "directory_too_large"));
    assert_eq!(h.counters()["zipNewCalls"], 0);
}

#[test]
fn structural_lies_in_the_end_of_directory_are_refused() {
    // directory range beyond the file
    let mut b = vec![0u8; 64];
    b.extend(eocd(1, 1000, 5000, 0, b""));
    assert_eq!(refusal(open_zip(&b).1), pair("invalid_archive", "bad_range"));
    // disk number != 0
    let mut b = vec![0u8; 64];
    b.extend(eocd(1, 46, 0, 1, b""));
    assert_eq!(refusal(open_zip(&b).1), pair("invalid_archive", "multi_volume"));
    // declared 2 entries, directory holds 1
    let z = zip(&[ZEntry::stored(b"a", b"1")]);
    let mut b = z.bytes[..z.bytes.len() - 22].to_vec();
    b.extend(eocd(2, z.cd_size, z.cd_off, 0, b""));
    assert_eq!(refusal(open_zip(&b).1), pair("invalid_archive", "count_mismatch"));
    // truncated ZIP64 locator: sentinel values but no locator before the EOCD
    let mut b = vec![0u8; 64];
    b.extend(eocd(0xFFFF, 0xFFFF_FFFF, 0xFFFF_FFFF, 0, b""));
    assert_eq!(refusal(open_zip(&b).1), pair("invalid_archive", "bad_zip64"));
    // comment that does not reach the end of the file
    let z = zip(&[ZEntry::stored(b"a", b"1")]);
    let mut b = z.bytes[..z.bytes.len() - 22].to_vec();
    b.extend(eocd(1, z.cd_size, z.cd_off, 0, b"abc"));
    b.extend_from_slice(b"zz");
    assert_eq!(refusal(open_zip(&b).1), pair("invalid_archive", "bad_eocd"));
    // too short to hold an EOCD at all
    assert_eq!(refusal(open_zip(b"PK\x03\x04short").1), pair("invalid_archive", "bad_eocd"));
}

#[test]
fn honest_ratio_above_the_limit_is_refused_at_open() {
    let raw = vec![0u8; 8 << 20];
    let z = zip(&[ZEntry::deflated(b"zeros", &raw)]);
    let csize = z.bytes.len();
    assert!(raw.len() > 100 * csize, "fixture must be a bomb");
    assert_eq!(refusal(open_zip(&z.bytes).1), pair("limit_exceeded", "ratio"));
}

#[test]
fn bomb_that_lies_in_the_directory_is_stopped_by_the_actual_ratio() {
    // 64 MiB of zeros deflate to ~64 KiB (ratio ~1000). The directory claims a 50:1 ratio,
    // so the open check passes; the real byte counters must stop the stream.
    let raw = vec![0u8; 64 << 20];
    let e = ZEntry::deflated(b"zeros", &raw);
    let real_csize = e.data.len() as u64;
    let lie = (raw.len() as u64) / 50;
    let z = zip_with(&[e], |_| Some(lie));
    // keep the lie consistent with the file: pad the data so local ranges stay inside the archive
    let mut bytes = z.bytes.clone();
    let _ = &mut bytes;
    let dir = tmpdir();
    // Rebuild with padding so that the claimed compressed size fits inside the file.
    let e2 = {
        let mut e = ZEntry::deflated(b"zeros", &raw);
        e.data.resize(lie as usize, 0); // deflate ignores trailing bytes after the final block
        e
    };
    let z2 = zip(&[e2]);
    let p = write(&dir, "bomb.zip", &z2.bytes);
    let mut h = Helper::spawn();
    h.open(&p).ok();
    let (stream, _) = match h.request("read_open", json!({"id": 0})) {
        Out::Ok(v, _) => (v["stream"].as_u64().unwrap(), 0),
        e => panic!("{:?}", e.err()),
    };
    let mut out = 0u64;
    let err = loop {
        match h.request("read", json!({"stream": stream, "length": 65536})) {
            Out::Ok(_, d) => {
                let n: usize = d.iter().map(Vec::len).sum();
                assert!(n > 0, "the stream ended without a refusal");
                out += n as u64;
            }
            e => break e.err(),
        }
    };
    assert_eq!(err, ("limit_exceeded".to_string(), Some("ratio".to_string())));
    assert!(out < 101 * real_csize, "wrote {out} bytes for {real_csize} compressed bytes");
}

#[test]
fn total_bytes_limit_stops_reading() {
    let z = zip(&[ZEntry::stored(b"a", &vec![7u8; 4096]), ZEntry::stored(b"b", &vec![8u8; 4096])]);
    let (_, r) = open_zip_limits(&z.bytes, json!({"maxTotalBytes": 8000}));
    assert_eq!(refusal(r), pair("limit_exceeded", "total_bytes"));
}

#[test]
fn traversal_backslash_and_drive_names_are_refused_not_hidden() {
    let names: [&[u8]; 5] = [b"../x", b"/abs", b"C:\\x", b"a\\b", b"fine.txt"];
    let entries: Vec<ZEntry> = names.iter().map(|n| ZEntry::stored(n, b"1")).collect();
    let (mut h, r) = open_zip(&zip(&entries).bytes);
    r.ok();
    let got: Vec<(String, Option<String>)> =
        h.list_root().iter().map(|e| (e["name"].as_str().unwrap().to_string(), e["refused"].as_str().map(str::to_string))).collect();
    assert_eq!(
        got,
        vec![
            ("../x".to_string(), Some("unsafe_name".to_string())),
            ("/abs".to_string(), Some("unsafe_name".to_string())),
            ("C:\\x".to_string(), Some("unsafe_name".to_string())),
            ("a\\b".to_string(), Some("backslash".to_string())),
            ("fine.txt".to_string(), None),
        ]
    );
}

#[test]
fn duplicate_names_refuse_the_whole_archive() {
    let z = zip(&[ZEntry::stored(b"same", b"1"), ZEntry::stored(b"same", b"2")]);
    assert_eq!(refusal(open_zip(&z.bytes).1), pair("invalid_archive", "duplicate_name"));
}

#[test]
fn overlapping_local_ranges_are_refused() {
    // Entry B's local record lives inside entry A's data.
    let b = ZEntry::stored(b"b", b"B-DATA");
    let mut inner = Vec::new();
    inner.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
    inner.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0]);
    inner.extend_from_slice(&b.crc.to_le_bytes());
    inner.extend_from_slice(&6u32.to_le_bytes());
    inner.extend_from_slice(&6u32.to_le_bytes());
    inner.extend_from_slice(&1u16.to_le_bytes());
    inner.extend_from_slice(&0u16.to_le_bytes());
    inner.extend_from_slice(b"b");
    inner.extend_from_slice(b"B-DATA");
    let a_data = {
        let mut d = b"PREFIX".to_vec();
        d.extend_from_slice(&inner);
        d
    };
    let a = ZEntry::stored(b"a", &a_data);
    let z = zip(&[a, b]);
    // Patch B's central directory offset to point inside A (after "PREFIX").
    let a_local = 30 + 1;
    let b_off = (a_local + 6) as u32;
    let mut bytes = z.bytes.clone();
    // second central record starts after the first: 46 + 1 bytes
    let cd2 = z.cd_off as usize + 47;
    bytes[cd2 + 42..cd2 + 46].copy_from_slice(&b_off.to_le_bytes());
    assert_eq!(refusal(open_zip(&bytes).1), pair("invalid_archive", "overlapping_entries"));
}

#[test]
fn local_name_must_match_the_directory() {
    let z = zip(&[ZEntry::stored(b"abc", b"1")]);
    let mut bytes = z.bytes.clone();
    bytes[30] = b'x'; // local header name "xbc"
    assert_eq!(refusal(open_zip(&bytes).1), pair("invalid_archive", "local_name_mismatch"));
}

#[test]
fn local_range_must_stay_below_the_directory() {
    let z = zip(&[ZEntry::stored(b"a", b"12345")]);
    let mut bytes = z.bytes.clone();
    // inflate the compressed size in the central record far beyond the file
    let cd = z.cd_off as usize;
    bytes[cd + 20..cd + 24].copy_from_slice(&(1u32 << 20).to_le_bytes());
    assert_eq!(refusal(open_zip_limits(&bytes, json!({"maxRatio": 100000})).1), pair("invalid_archive", "bad_range"));
}

#[test]
fn cp437_names_keep_their_raw_bytes() {
    let z = zip(&[ZEntry::stored(b"caf\x82.txt", b"payload")]);
    let (mut h, r) = open_zip(&z.bytes);
    r.ok();
    let e = h.list_root();
    assert_eq!(e[0]["name"], "café.txt");
    assert_eq!(e[0]["nameB64"], b64(b"caf\x82.txt"));
    assert_eq!(e[0]["refused"], "name_encoding");
}

#[test]
fn symlinks_are_listed_and_classified() {
    let z = zip(&[ZEntry::symlink(b"out", b"../../etc/passwd"), ZEntry::symlink(b"in", b"target"), ZEntry::stored(b"target", b"t")]);
    let (mut h, r) = open_zip(&z.bytes);
    r.ok();
    let l = h.list_root();
    assert_eq!((l[0]["kind"].as_str().unwrap(), l[0]["refused"].as_str().unwrap()), ("symlink", "link_escapes"));
    assert_eq!(l[1]["refused"], "link_not_supported");
    assert_eq!(l[0]["linkB64"], b64(b"../../etc/passwd"));
}

#[test]
fn unsupported_compression_is_reported() {
    let mut e = ZEntry::stored(b"a", b"1");
    e.method = 12; // bzip2
    assert_eq!(refusal(open_zip(&zip(&[e]).bytes).1), pair("unsupported", "unsupported_compression"));
}
