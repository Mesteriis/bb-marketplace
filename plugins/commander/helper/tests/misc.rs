mod common;
use common::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

fn pair(c: &str, r: &str) -> (String, Option<String>) {
    (c.to_string(), Some(r.to_string()))
}

fn expect_of(path: &Path) -> serde_json::Value {
    let m = std::fs::metadata(path).unwrap();
    json!({"size": m.len().to_string(), "mtimeNs": (m.mtime() as u64 * 1_000_000_000 + m.mtime_nsec() as u64).to_string(), "dev": m.dev().to_string(), "ino": m.ino().to_string()})
}

fn open_raw(h: &mut Helper, root: &Path, segments: &[&str], expect: serde_json::Value) -> Out {
    h.request(
        "open",
        json!({"rootB64": b64(root.as_os_str().as_bytes()), "segmentsB64": segments.iter().map(|s| b64(s.as_bytes())).collect::<Vec<_>>(), "format": "auto", "limits": {}, "expect": expect}),
    )
}

fn simple_zip(dir: &Path) -> std::path::PathBuf {
    write(dir, "a.zip", &zip(&[ZEntry::stored(b"a.txt", b"hello")]).bytes)
}

#[test]
fn walk_refuses_links_bad_segments_and_relative_roots() {
    let dir = tmpdir();
    std::fs::create_dir(dir.join("real")).unwrap();
    let file = simple_zip(&dir.join("real"));
    std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).unwrap();
    std::os::unix::fs::symlink(dir.join("real/a.zip"), dir.join("flink.zip")).unwrap();
    let e = expect_of(&file);
    let mut h = Helper::spawn();
    for segs in [vec!["link", "a.zip"], vec!["real", ".."], vec!["real", "", "a.zip"], vec!["real/a.zip"], vec!["."], vec![]] {
        assert_eq!(open_raw(&mut h, &dir, &segs, e.clone()).err().0, "invalid_path", "{segs:?}");
    }
    assert_eq!(open_raw(&mut h, &dir, &["flink.zip"], e.clone()).err().0, "invalid_path", "a link in the last component");
    assert_eq!(open_raw(&mut h, Path::new("relative/dir"), &["a.zip"], e.clone()).err().0, "invalid_path");
    assert_eq!(open_raw(&mut h, &dir, &["missing.zip"], e.clone()).err().0, "not_found");
    // a directory is not a regular file
    assert_eq!(open_raw(&mut h, &dir, &["real"], e.clone()).err().0, "invalid_path");
    // and the honest path works
    assert_eq!(open_raw(&mut h, &dir.join("real"), &["a.zip"], e).ok()["entries"], 1);
}

#[test]
fn expect_is_compared_with_the_opened_descriptor_before_parsing() {
    let dir = tmpdir();
    let file = simple_zip(&dir);
    let stale = expect_of(&file);
    // The file is replaced after the caller's stat and before open.
    let other = write(&dir, "other.zip", &zip(&[ZEntry::stored(b"b", b"2")]).bytes);
    std::fs::rename(&other, &file).unwrap();
    let mut h = Helper::spawn();
    assert_eq!(open_raw(&mut h, &dir, &["a.zip"], stale).err().0, "changed_since_plan");
    #[cfg(feature = "test-hooks")]
    {
        let c = h.counters();
        assert_eq!(c["zipNewCalls"], 0, "nothing may be parsed after a failed comparison");
    }
    // a wrong inode alone is enough
    let mut e = expect_of(&file);
    e["ino"] = json!("1");
    assert_eq!(open_raw(&mut h, &dir, &["a.zip"], e).err().0, "changed_since_plan");
}

#[test]
fn replacement_after_open_is_seen_by_verify_and_by_reads() {
    let dir = tmpdir();
    let file = simple_zip(&dir);
    let mut h = Helper::spawn();
    open_raw(&mut h, &dir, &["a.zip"], expect_of(&file)).ok();
    assert_eq!(h.request("verify", json!({})).ok()["changed"], false);
    let other = write(&dir, "n.zip", &zip(&[ZEntry::stored(b"a.txt", b"HELLO")]).bytes);
    std::fs::rename(&other, &file).unwrap();
    assert_eq!(h.request("verify", json!({})).ok()["changed"], true);
    assert_eq!(h.request("read_open", json!({"id": 0})).err().0, "changed_since_plan");
    assert_eq!(h.request("list", json!({"prefix": "", "limit": 10})).err().0, "changed_since_plan");
    // a symlink put in place of the file is a change as well
    std::fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(dir.join("n2"), &file).unwrap();
    assert_eq!(h.request("verify", json!({})).ok()["changed"], true);
}

fn aes_zip(path: &Path, password: &str) {
    let f = std::fs::File::create(path).unwrap();
    let mut w = zip::ZipWriter::new(f);
    let o = zip::write::SimpleFileOptions::default().with_aes_encryption(zip::AesMode::Aes256, password);
    w.start_file("secret.txt", o).unwrap();
    w.write_all(b"payload").unwrap();
    w.start_file("second.txt", o).unwrap();
    w.write_all(b"second").unwrap();
    w.finish().unwrap();
}

fn stderr_of(mut h: Helper) -> String {
    let _ = h.request("close", json!({}));
    let mut err = h.child.stderr.take().unwrap();
    let _ = h.child.wait();
    let mut s = String::new();
    err.read_to_string(&mut s).unwrap();
    s
}

#[test]
fn encrypted_entries_need_the_password_and_it_is_asked_through_a_secret_frame() {
    let dir = tmpdir();
    let p = dir.join("enc.zip");
    aes_zip(&p, "synthetic-pass");
    let mut h = Helper::spawn();
    let v = h.open(&p).ok();
    assert_eq!(v["encrypted"], true);
    // wrong password: refused, nothing is read
    assert_eq!(h.read_entry(0, Some("not-it")).unwrap_err(), pair("auth_failed", "bad_password"));
    // right password: read, verified (AES authentication), and reused for the next entry without asking
    assert_eq!(h.read_entry(0, Some("synthetic-pass")).unwrap(), b"payload");
    assert_eq!(h.read_entry(1, None).unwrap(), b"second");
    let log = stderr_of(h);
    assert!(!log.contains("synthetic-pass") && !log.contains("not-it"), "stderr: {log}");
}

#[test]
fn third_wrong_password_ends_the_process() {
    let dir = tmpdir();
    let p = dir.join("enc.zip");
    aes_zip(&p, "synthetic-pass");
    let mut h = Helper::spawn();
    h.open(&p).ok();
    for _ in 0..2 {
        assert_eq!(h.read_entry(0, Some("wrong")).unwrap_err(), pair("auth_failed", "bad_password"));
    }
    assert_eq!(h.read_entry(0, Some("wrong")).unwrap_err(), pair("auth_failed", "bad_password"));
    let status = h.child.wait().unwrap();
    assert_eq!(status.code(), Some(0));
}

#[test]
fn ratio_grace_applies_to_one_small_entry_only() {
    // 65 535 bytes of zeros: ratio far above 100, still inside the per-entry grace.
    let small = zip(&[ZEntry::deflated(b"z", &vec![0u8; 65_535])]);
    let dir = tmpdir();
    let mut h = Helper::spawn();
    h.open(&write(&dir, "s.zip", &small.bytes)).ok();
    assert_eq!(h.read_entry(0, None).unwrap().len(), 65_535);
    // 65 536 bytes: the check applies
    let big = zip(&[ZEntry::deflated(b"z", &vec![0u8; 65_536])]);
    let mut h = Helper::spawn();
    assert_eq!(h.open(&write(&dir, "b.zip", &big.bytes)).err(), pair("limit_exceeded", "ratio"));
}

#[test]
fn many_small_entries_do_not_dodge_the_archive_wide_ratio() {
    let entries: Vec<ZEntry> = (0..2000).map(|i| ZEntry::deflated(format!("f{i}").as_bytes(), &vec![0u8; 32 * 1024])).collect();
    let z = zip(&entries);
    let dir = tmpdir();
    let mut h = Helper::spawn();
    assert_eq!(h.open(&write(&dir, "m.zip", &z.bytes)).err(), pair("limit_exceeded", "ratio"));
    // a higher owner-set ratio lets the same archive through
    let mut h = Helper::spawn();
    assert_eq!(h.open_with(&dir.join("m.zip"), json!({"maxRatio": 100000})).ok()["entries"], 2000);
}

#[test]
fn more_data_than_declared_is_a_size_mismatch() {
    let mut e = ZEntry::deflated(b"a", &vec![b'x'; 1000]);
    e.usize = 500; // directory claims half of what the stream holds
    let dir = tmpdir();
    let mut h = Helper::spawn();
    h.open(&write(&dir, "x.zip", &zip(&[e]).bytes)).ok();
    let err = h.read_entry(0, None).unwrap_err();
    assert_eq!(err.0, "invalid_archive");
}

#[test]
fn streams_are_sequential_and_closed_explicitly() {
    let dir = tmpdir();
    let mut h = Helper::spawn();
    h.open(&write(&dir, "a.zip", &zip(&[ZEntry::stored(b"a", &vec![1u8; 10_000])]).bytes)).ok();
    let s = h.request("read_open", json!({"id": 0})).ok()["stream"].as_u64().unwrap();
    let first = h.request("read", json!({"stream": s, "length": 4096}));
    assert_eq!(first.data().len(), 4096);
    // a length past the end is shortened, an exhausted stream returns zero bytes
    let rest = h.request("read", json!({"stream": s, "length": 1 << 20}));
    assert_eq!(rest.data().len(), 10_000 - 4096);
    assert_eq!(h.request("read", json!({"stream": s, "length": 10})).data().len(), 0);
    h.request("read_finish", json!({"stream": s})).ok();
    h.request("read_close", json!({"stream": s})).ok();
    assert_eq!(h.request("read", json!({"stream": s, "length": 10})).err().0, "invalid_path");
    assert_eq!(h.request("read_open", json!({"id": 99})).err().0, "invalid_path");
}

// ---------- pack ----------

fn pack_files(h: &mut Helper, files: &[(&str, &[u8])]) {
    for (name, data) in files {
        h.request("pack_add", json!({"nameB64": b64(name.as_bytes()), "kind": "file", "size": data.len().to_string(), "mtime": 1_700_000_000, "mode": 0o644})).ok();
        for chunk in data.chunks(7) {
            h.pack_data(chunk).ok();
        }
        h.request("pack_end_entry", json!({})).ok();
    }
}

#[test]
fn pack_zip_and_tar_round_trip_through_the_reader() {
    let files: [(&str, &[u8]); 3] = [("one.txt", b"first file"), ("dir/two.bin", &[0u8, 1, 2, 3, 255]), ("empty", b"")];
    for kind in ["zip", "tar"] {
        let dir = tmpdir();
        let staging = dir.join(format!("out.{kind}"));
        let mut w = Helper::spawn();
        w.request("pack_open", json!({"format": kind, "staging": b64(staging.as_os_str().as_bytes())})).ok();
        w.request("pack_add", json!({"nameB64": b64(b"dir"), "kind": "dir"})).ok();
        pack_files(&mut w, &files);
        let done = w.request("pack_finish", json!({})).ok();
        let bytes = std::fs::read(&staging).unwrap();
        assert_eq!(done["size"], bytes.len().to_string());
        let expect_sha: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(done["sha256"], expect_sha);
        assert_eq!(std::fs::metadata(&staging).unwrap().mode() & 0o777, 0o600);
        let mut r = Helper::spawn();
        r.open(&staging).ok();
        let mut seen: Vec<(String, String)> = Vec::new();
        for e in r.list_root().into_iter().chain(r.list("dir")) {
            seen.push((e["name"].as_str().unwrap().trim_end_matches('/').to_string(), e["size"].as_str().unwrap().to_string()));
        }
        seen.sort();
        assert_eq!(
            seen,
            vec![("dir".to_string(), "0".to_string()), ("dir/two.bin".to_string(), "5".to_string()), ("empty".to_string(), "0".to_string()), ("one.txt".to_string(), "10".to_string())],
            "{kind}"
        );
        let list = r.list_root();
        let one = list.iter().find(|e| e["name"] == "one.txt").unwrap()["id"].as_u64().unwrap();
        assert_eq!(r.read_entry(one, None).unwrap(), b"first file", "{kind}");
    }
}

#[test]
fn pack_tar_long_name_survives() {
    let name = format!("{}/{}", "d".repeat(80), "f".repeat(80));
    let dir = tmpdir();
    let staging = dir.join("long.tar");
    let mut w = Helper::spawn();
    w.request("pack_open", json!({"format": "tar", "staging": b64(staging.as_os_str().as_bytes())})).ok();
    pack_files(&mut w, &[(name.as_str(), b"x")]);
    w.request("pack_finish", json!({})).ok();
    let mut r = Helper::spawn();
    r.open(&staging).ok();
    assert_eq!(r.list_root()[0]["name"], "d".repeat(80));
    assert_eq!(r.list(&"d".repeat(80))[0]["name"], name);
}

#[test]
fn pack_refuses_bad_names_duplicates_and_size_mismatch() {
    let dir = tmpdir();
    let staging = dir.join("o.zip");
    let mut w = Helper::spawn();
    w.request("pack_open", json!({"format": "zip", "staging": b64(staging.as_os_str().as_bytes())})).ok();
    for bad in ["../x", "/abs", "C:\\x", "a\\b", ""] {
        assert_eq!(w.request("pack_add", json!({"nameB64": b64(bad.as_bytes()), "kind": "file", "size": "1"})).err().0, "invalid_path", "{bad:?}");
    }
    w.request("pack_add", json!({"nameB64": b64(b"a"), "kind": "file", "size": "3"})).ok();
    assert_eq!(w.pack_data(b"abcd").err(), pair("invalid_archive", "size_mismatch"));
    w.pack_data(b"ab").ok();
    assert_eq!(w.request("pack_end_entry", json!({})).err(), pair("invalid_archive", "size_mismatch"));
    w.pack_data(b"c").ok();
    w.request("pack_end_entry", json!({})).ok();
    assert_eq!(w.request("pack_add", json!({"nameB64": b64(b"a"), "kind": "file", "size": "1"})).err(), pair("invalid_archive", "duplicate_name"));
}

#[test]
fn pack_abort_removes_the_staging_file_and_existing_staging_is_refused() {
    let dir = tmpdir();
    let staging = dir.join("o.tar");
    let mut w = Helper::spawn();
    w.request("pack_open", json!({"format": "tar", "staging": b64(staging.as_os_str().as_bytes())})).ok();
    assert!(staging.exists());
    w.request("pack_abort", json!({})).ok();
    assert!(!staging.exists());
    std::fs::write(&staging, b"mine").unwrap();
    let mut w2 = Helper::spawn();
    assert_eq!(w2.request("pack_open", json!({"format": "tar", "staging": b64(staging.as_os_str().as_bytes())})).err().0, "already_exists");
    assert_eq!(std::fs::read(&staging).unwrap(), b"mine");
    let mut w3 = Helper::spawn();
    assert_eq!(w3.request("pack_open", json!({"format": "tar", "staging": b64(b"relative")})).err().0, "invalid_path");
}

#[test]
fn pack_with_aes_asks_for_a_password_and_the_result_opens_with_it() {
    let dir = tmpdir();
    let staging = dir.join("enc.zip");
    let mut w = Helper::spawn();
    w.request_with("pack_open", json!({"format": "zip", "staging": b64(staging.as_os_str().as_bytes()), "zip": {"encryption": "aes256"}}), Some("pack-secret")).ok();
    pack_files(&mut w, &[("s.txt", b"classified")]);
    w.request("pack_finish", json!({})).ok();
    let log = stderr_of(w);
    assert!(!log.contains("pack-secret"));
    let mut r = Helper::spawn();
    assert_eq!(r.open(&staging).ok()["encrypted"], true);
    assert_eq!(r.read_entry(0, Some("nope")).unwrap_err(), pair("auth_failed", "bad_password"));
    assert_eq!(r.read_entry(0, Some("pack-secret")).unwrap(), b"classified");
    let mut t = Helper::spawn();
    assert_eq!(t.request("pack_open", json!({"format": "tar", "staging": b64(dir.join("e.tar").as_os_str().as_bytes()), "zip": {"encryption": "aes256"}})).ok()["packId"], 1);
}

#[cfg(feature = "test-hooks")]
#[test]
fn memory_balloon_hook_exists_only_for_tests() {
    let mut h = Helper::spawn();
    h.request("test_balloon", json!({"mib": 8})).ok();
}

#[test]
fn cancel_interrupts_a_long_request_with_cancelled() {
    // A sparse 2 GiB stored entry: read_finish walks all of it unless it is cancelled.
    let dir = tmpdir();
    let path = dir.join("big.zip");
    let n: u64 = 2 << 30;
    let e = ZEntry::stored(b"big", b"");
    let mut local = Vec::new();
    local.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
    local.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0]);
    local.extend_from_slice(&0u32.to_le_bytes());
    local.extend_from_slice(&(n as u32).to_le_bytes());
    local.extend_from_slice(&(n as u32).to_le_bytes());
    local.extend_from_slice(&3u16.to_le_bytes());
    local.extend_from_slice(&0u16.to_le_bytes());
    local.extend_from_slice(b"big");
    let mut f = std::fs::File::create(&path).unwrap();
    f.write_all(&local).unwrap();
    f.set_len(local.len() as u64 + n).unwrap();
    use std::io::{Seek, SeekFrom};
    f.seek(SeekFrom::End(0)).unwrap();
    let mut cd = Vec::new();
    cd.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
    cd.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0]);
    cd.extend_from_slice(&0u32.to_le_bytes());
    cd.extend_from_slice(&(n as u32).to_le_bytes());
    cd.extend_from_slice(&(n as u32).to_le_bytes());
    cd.extend_from_slice(&3u16.to_le_bytes());
    cd.extend_from_slice(&[0u8; 12]);
    cd.extend_from_slice(&0u32.to_le_bytes());
    cd.extend_from_slice(b"big");
    let cd_off = local.len() as u32; // patched below: the directory starts after the data
    let _ = (cd_off, &e);
    let cd_start = local.len() as u64 + n;
    f.write_all(&cd).unwrap();
    f.write_all(&eocd(1, cd.len() as u32, cd_start as u32, 0, b"")).unwrap();
    drop(f);
    let mut h = Helper::spawn();
    h.open_with(&path, json!({"maxTotalBytes": 1u64 << 40})).ok();
    let stream = h.request("read_open", json!({"id": 0})).ok()["stream"].as_u64().unwrap();
    // read_finish is request 3 (open = 1, read_open = 2); cancel it from the side.
    h.send(&json!({"t": "read_finish", "req": 3, "stream": stream}));
    std::thread::sleep(std::time::Duration::from_millis(150));
    h.send(&json!({"t": "cancel", "req": 4, "target": 3}));
    let mut got_err = false;
    let mut got_cancel_ok = false;
    for _ in 0..2 {
        match h.recv() {
            archive_helper::frame::Frame::Control(v) => match (v["t"].as_str().unwrap(), v["req"].as_u64().unwrap()) {
                ("err", 3) => {
                    assert_eq!(v["code"], "cancelled");
                    got_err = true;
                }
                ("ok", 4) => got_cancel_ok = true,
                other => panic!("unexpected {other:?}"),
            },
            _ => panic!("unexpected frame"),
        }
    }
    assert!(got_err && got_cancel_ok);
}
