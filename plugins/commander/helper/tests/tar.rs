mod common;
use common::*;
use serde_json::json;

fn size_field(b: &[u8; 12]) -> [u8; 12] {
    *b
}

fn open_tar(bytes: &[u8]) -> (Helper, Out) {
    let dir = tmpdir();
    let p = write(&dir, "a.tar", bytes);
    let mut h = Helper::spawn();
    let r = h.open(&p);
    (h, r)
}

fn refusal(out: Out) -> (String, String) {
    let (c, r) = out.err();
    (c, r.unwrap_or_default())
}

#[test]
fn valid_tar_lists_reads_and_finishes() {
    let mut t = Vec::new();
    t.extend(tar_file(b"a.txt", b"hello"));
    t.extend(tar_file(b"empty", b""));
    let (mut h, r) = open_tar(&tar_finish(t));
    let v = r.ok();
    assert_eq!(v["format"], "tar");
    assert_eq!(v["entries"], 2);
    assert_eq!(v["totalSize"], "5");
    let list = h.list_root();
    assert_eq!(list.iter().map(|e| e["name"].as_str().unwrap()).collect::<Vec<_>>(), ["a.txt", "empty"]);
    assert_eq!(h.read_entry(0, None).unwrap(), b"hello");
    assert_eq!(h.read_entry(1, None).unwrap(), b"");
    h.expect_exit(0);
}

#[test]
fn l_k_x_g_headers_claiming_256_mib_are_refused_after_one_header() {
    for flag in [b'L', b'K', b'x', b'g'] {
        // Only the 512-byte header exists; the body it announces is never read.
        let header = tar_header(b"././@meta", flag, &octal12(256 << 20), b"");
        let dir = tmpdir();
        let p = write(&dir, "bomb.tar", &header);
        let mut h = Helper::spawn();
        assert_eq!(refusal(h.open(&p)), ("limit_exceeded".to_string(), "meta_too_large".to_string()), "flag {}", flag as char);
        #[cfg(feature = "test-hooks")]
        {
            let c = h.counters();
            // 512 header bytes plus the 9 bytes of format detection; never a byte of the announced 256 MiB body.
            assert_eq!(c["bytesRead"], 521, "flag {}: only the header may be read", flag as char);
        }
        let pid = h.child.id() as i32;
        h.send(&json!({"t": "close", "req": 99}));
        let mut status = 0;
        let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
        // wait4 gives the peak RSS of the helper process itself (bytes on macOS).
        h.stdin = None;
        let r = unsafe { libc::wait4(pid, &mut status, 0, &mut ru) };
        assert_eq!(r, pid);
        assert!((ru.ru_maxrss as u64) <= 32 << 20, "peak RSS {} bytes", ru.ru_maxrss);
        std::mem::forget(h.child);
    }
}

/// GNU long name record: the name and exactly one NUL.
fn long_name_record(name: &[u8]) -> Vec<u8> {
    let mut body = name.to_vec();
    body.push(0);
    tar_meta(b'L', &body)
}

/// A global PAX body of exactly `total` bytes (one comment record).
fn comment_of_size(total: usize) -> Vec<u8> {
    let mut filler = total.saturating_sub(30);
    loop {
        let rec = pax_record("comment", &vec![b'c'; filler]);
        if rec.len() == total {
            return rec;
        }
        assert!(rec.len() < total, "no filler fits");
        filler += 1;
    }
}

/// A PAX header body of exactly `total` bytes: a path record plus a filler comment.
fn pax_of_size(total: usize, path: &[u8]) -> Vec<u8> {
    let mut body = pax_record("path", path);
    // find a filler length so that the whole body is `total` bytes
    let rest = total - body.len();
    let mut filler = rest.saturating_sub(30);
    loop {
        let rec = pax_record("comment", &vec![b'c'; filler]);
        if rec.len() == rest {
            body.extend(rec);
            break;
        }
        assert!(rec.len() <= rest, "no filler fits");
        filler += 1;
    }
    assert_eq!(body.len(), total);
    body
}

#[test]
fn meta_record_of_exactly_1_mib_is_read_and_one_byte_more_is_refused() {
    let mut t = tar_meta(b'x', &pax_of_size(1 << 20, &[b'n'; 300]));
    t.extend(tar_file(b"short", b"x"));
    let (mut h, r) = open_tar(&tar_finish(t));
    r.ok();
    assert_eq!(h.list_root()[0]["name"].as_str().unwrap().len(), 300);
    let mut t = tar_meta(b'x', &pax_of_size((1 << 20) + 1, &[b'n'; 300]));
    t.extend(tar_file(b"short", b"x"));
    let (_, r) = open_tar(&tar_finish(t));
    assert_eq!(refusal(r), ("limit_exceeded".to_string(), "meta_too_large".to_string()));
}

#[test]
fn chain_of_meta_records_over_4_mib_is_refused() {
    let mut ok = Vec::new();
    for _ in 0..4 {
        ok.extend(tar_meta(b'g', &comment_of_size(1 << 20)));
    }
    ok.extend(tar_file(b"f", b"x"));
    open_tar(&tar_finish(ok)).1.ok();
    let mut bad = Vec::new();
    for _ in 0..4 {
        bad.extend(tar_meta(b'g', &comment_of_size(1 << 20)));
    }
    bad.extend(tar_meta(b'g', &pax_record("comment", b"z"))); // pushes the total past 4 MiB
    bad.extend(tar_file(b"f", b"x"));
    assert_eq!(refusal(open_tar(&tar_finish(bad)).1), ("limit_exceeded".to_string(), "meta_too_large".to_string()));
}

#[test]
fn bad_pax_length_and_pax_size_override_are_refused() {
    let bad = tar_meta(b'x', b"99 path=a\n");
    let mut t = bad;
    t.extend(tar_file(b"f", b"x"));
    assert_eq!(refusal(open_tar(&tar_finish(t)).1), ("invalid_archive".to_string(), "bad_pax".to_string()));
    let mut t = tar_meta(b'x', &pax_record("size", b"5"));
    t.extend(tar_file(b"f", b"x"));
    assert_eq!(refusal(open_tar(&tar_finish(t)).1), ("unsupported".to_string(), "pax_size".to_string()));
}

#[test]
fn valid_pax_path_and_gnu_long_name_open() {
    let long: Vec<u8> = std::iter::repeat_n(b'p', 150).collect();
    let mut t = tar_meta(b'x', &pax_record("path", &long));
    t.extend(tar_file(b"short", b"x"));
    t.extend(long_name_record(&[b'q'; 120]));
    t.extend(tar_file(b"short2", b"y"));
    let (mut h, r) = open_tar(&tar_finish(t));
    assert_eq!(r.ok()["entries"], 2);
    let names: Vec<String> = h.list_root().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, vec!["p".repeat(150), "q".repeat(120)]);
}

#[test]
fn meta_records_do_not_count_as_logical_entries() {
    let mut t = long_name_record(b"long-name-entry");
    t.extend(tar_file(b"x", b"1"));
    let (_, r) = open_tar_limits(&tar_finish(t), json!({"maxEntries": 1}));
    assert_eq!(r.ok()["entries"], 1);
}

fn open_tar_limits(bytes: &[u8], limits: serde_json::Value) -> (Helper, Out) {
    let dir = tmpdir();
    let p = write(&dir, "a.tar", bytes);
    let mut h = Helper::spawn();
    let r = h.open_with(&p, limits);
    (h, r)
}

#[test]
fn exact_duplicate_effective_name_refuses_the_whole_archive() {
    let mut t = long_name_record(b"dup");
    t.extend(tar_file(b"ignored", b"1"));
    t.extend(tar_file(b"dup", b"2"));
    assert_eq!(refusal(open_tar(&tar_finish(t)).1), ("invalid_archive".to_string(), "duplicate_name".to_string()));
}

#[test]
fn truncated_body_overflow_and_negative_sizes() {
    // Declares 4 KiB, holds 512 bytes.
    let mut t = tar_header(b"f", b'0', &octal12(4096), b"").to_vec();
    t.extend(vec![0u8; 512]);
    assert_eq!(refusal(open_tar(&t).1), ("invalid_archive".to_string(), "truncated".to_string()));
    // base-256 size that does not fit u64.
    let mut f = [0xffu8; 12];
    f[0] = 0x80;
    let h = tar_header(b"f", b'0', &size_field(&f), b"");
    assert_eq!(refusal(open_tar(&h).1), ("invalid_archive".to_string(), "size_overflow".to_string()));
    // negative base-256
    let mut n = [0u8; 12];
    n[0] = 0xff;
    let h = tar_header(b"f", b'0', &n, b"");
    assert_eq!(refusal(open_tar(&h).1), ("invalid_archive".to_string(), "bad_tar".to_string()));
    // size close to u64::MAX: padding arithmetic must not wrap
    let mut m = [0u8; 12];
    m[0] = 0x80;
    m[4..12].copy_from_slice(&u64::MAX.to_be_bytes());
    let h = tar_header(b"f", b'0', &size_field(&m), b"");
    assert_eq!(refusal(open_tar(&h).1), ("invalid_archive".to_string(), "size_overflow".to_string()));
}

#[test]
fn end_of_archive_rules() {
    // one zero block followed by a header
    let mut t = tar_file(b"a", b"1");
    t.extend(vec![0u8; 512]);
    t.extend(tar_file(b"b", b"2"));
    assert_eq!(refusal(open_tar(&t).1), ("invalid_archive".to_string(), "bad_tar".to_string()));
    // two zero blocks, garbage afterwards is ignored
    let mut t = tar_finish(tar_file(b"a", b"1"));
    t.extend_from_slice(b"trailing garbage that is not a header");
    assert_eq!(open_tar(&t).1.ok()["entries"], 1);
    // no end blocks at all but complete bodies: accepted
    assert_eq!(open_tar(&tar_file(b"a", b"1")).1.ok()["entries"], 1);
}

#[test]
fn v7_without_magic_and_bad_checksum_are_refused() {
    let mut h = tar_header(b"f", b'0', &octal12(0), b"");
    h[257..265].fill(0);
    seal(&mut h);
    let dir = tmpdir();
    let p = write(&dir, "v7.tar", &h);
    let mut hp = Helper::spawn();
    assert_eq!(refusal(hp.open_fmt(&p, json!({}), "tar")), ("unsupported".to_string(), "v7_tar".to_string()));
    let mut h = tar_header(b"f", b'0', &octal12(0), b"");
    h[0] = b'g'; // checksum no longer matches
    assert_eq!(refusal(open_tar(&h).1), ("invalid_archive".to_string(), "bad_tar".to_string()));
}

#[test]
fn sparse_and_unknown_types_are_unsupported() {
    let h = tar_header(b"f", b'S', &octal12(0), b"");
    assert_eq!(refusal(open_tar(&h).1), ("unsupported".to_string(), "unsupported_format".to_string()));
}

#[test]
fn hostile_names_are_listed_as_refused_and_never_hidden() {
    let mut t = Vec::new();
    for (i, n) in ["../x", "/abs", "C:\\x", "a\\b", "a/../../b", "ok.txt"].iter().enumerate() {
        t.extend(tar_file(n.as_bytes(), &[b'0' + i as u8]));
    }
    let (mut h, r) = open_tar(&tar_finish(t));
    r.ok();
    let reasons: Vec<(String, Option<String>)> =
        h.list_root().iter().map(|e| (e["name"].as_str().unwrap().to_string(), e["refused"].as_str().map(str::to_string))).collect();
    assert_eq!(
        reasons,
        vec![
            ("../x".to_string(), Some("unsafe_name".to_string())),
            ("/abs".to_string(), Some("unsafe_name".to_string())),
            ("C:\\x".to_string(), Some("unsafe_name".to_string())),
            ("a\\b".to_string(), Some("backslash".to_string())),
            ("a/../../b".to_string(), Some("unsafe_name".to_string())),
            ("ok.txt".to_string(), None),
        ]
    );
}

#[test]
fn links_are_listed_and_never_readable() {
    let mut t = Vec::new();
    t.extend(tar_header(b"out", b'2', &octal12(0), b"../../etc/passwd"));
    t.extend(tar_header(b"in", b'2', &octal12(0), b"target"));
    t.extend(tar_header(b"hard", b'1', &octal12(0), b"in"));
    t.extend(tar_header(b"abs", b'2', &octal12(0), b"/etc/passwd"));
    let (mut h, r) = open_tar(&tar_finish(t));
    r.ok();
    let l = h.list_root();
    let refused: Vec<&str> = l.iter().map(|e| e["refused"].as_str().unwrap()).collect();
    assert_eq!(refused, ["link_escapes", "link_not_supported", "link_not_supported", "link_escapes"]);
    assert_eq!(l[0]["kind"], "symlink");
    assert_eq!(l[2]["kind"], "hardlink");
    assert_eq!(h.read_entry(0, None).unwrap_err(), ("unsupported".to_string(), Some("link_escapes".to_string())));
    assert_eq!(h.read_entry(1, None).unwrap_err(), ("unsupported".to_string(), Some("link_not_supported".to_string())));
}

#[test]
fn a_hardlink_target_counts_from_the_archive_root_and_a_symlink_from_its_directory() {
    let mut t = Vec::new();
    t.extend(tar_header(b"d/hard", b'1', &octal12(0), b"../x"));
    t.extend(tar_header(b"d/sym", b'2', &octal12(0), b"../x"));
    t.extend(tar_header(b"d/hard2", b'1', &octal12(0), b"x"));
    let (mut h, r) = open_tar(&tar_finish(t));
    r.ok();
    let refused: Vec<String> = h.list("d/").iter().map(|e| e["refused"].as_str().unwrap().to_string()).collect();
    assert_eq!(refused, ["link_escapes", "link_not_supported", "link_not_supported"]);
}

#[test]
fn limits_entries_and_total_bytes() {
    let mut t = Vec::new();
    for i in 0..3 {
        t.extend(tar_file(format!("f{i}").as_bytes(), b"abcd"));
    }
    let t = tar_finish(t);
    assert_eq!(refusal(open_tar_limits(&t, json!({"maxEntries": 2})).1), ("limit_exceeded".to_string(), "too_many_entries".to_string()));
    assert_eq!(refusal(open_tar_limits(&t, json!({"maxTotalBytes": 11})).1), ("limit_exceeded".to_string(), "total_bytes".to_string()));
    open_tar_limits(&t, json!({"maxEntries": 3, "maxTotalBytes": 12})).1.ok();
}

#[test]
fn directories_nest_and_missing_parents_are_synthesised() {
    let mut t = Vec::new();
    t.extend(tar_header(b"d/", b'5', &octal12(0), b""));
    t.extend(tar_file(b"d/a.txt", b"1"));
    t.extend(tar_file(b"x/y/z.txt", b"22"));
    let (mut h, r) = open_tar(&tar_finish(t));
    r.ok();
    let root: Vec<String> = h.list_root().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(root, vec!["d/".to_string(), "x".to_string()]);
    assert_eq!(h.list("d")[0]["name"], "d/a.txt");
    let y = &h.list("x")[0];
    assert_eq!((y["kind"].as_str().unwrap(), y["synthetic"].as_bool()), ("dir", Some(true)));
    assert_eq!(h.list("x/y")[0]["name"], "x/y/z.txt");
}
