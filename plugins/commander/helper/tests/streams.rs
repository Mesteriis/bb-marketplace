#![cfg_attr(not(feature = "test-hooks"), allow(unused_variables, unused_mut))]
//! S14a review round 3: up to four independent read streams per archive, each with its own cursor.
mod common;
use common::*;
use serde_json::json;

const SIZE: usize = 200_000;

fn pattern(seed: u8) -> Vec<u8> {
    // Pseudo-random bytes: they barely compress, so the ratio limits never get in the way.
    let mut x = 0x9E37_79B9u32 ^ seed as u32;
    (0..SIZE).map(|_| { x ^= x << 13; x ^= x >> 17; x ^= x << 5; (x >> 8) as u8 }).collect()
}

fn zip_two() -> Vec<u8> {
    zip(&[ZEntry::stored(b"a.bin", &pattern(1)), ZEntry::deflated(b"b.bin", &pattern(2))]).bytes
}

fn tar_two() -> Vec<u8> {
    let mut v = tar_file(b"a.bin", &pattern(1));
    v.extend(tar_file(b"b.bin", &pattern(2)));
    tar_finish(v)
}

fn open_stream(h: &mut Helper, id: u64) -> u64 {
    h.request("read_open", json!({"id": id})).ok()["stream"].as_u64().unwrap()
}

fn pull(h: &mut Helper, stream: u64, n: usize) -> Vec<u8> {
    h.request("read", json!({"stream": stream, "length": n})).data()
}

/// Two streams, read in turns in 7 000-byte portions, must each return their own bytes.
fn interleave(bytes: &[u8], name: &str) {
    let dir = tmpdir();
    let mut h = Helper::spawn();
    h.open(&write(&dir, name, bytes)).ok();
    #[cfg(feature = "test-hooks")]
    let before = h.counters()["bytesRead"].as_u64().unwrap();
    let (a, b) = (open_stream(&mut h, 0), open_stream(&mut h, 1));
    assert_ne!(a, b);
    let (mut got_a, mut got_b) = (Vec::new(), Vec::new());
    while got_a.len() < SIZE || got_b.len() < SIZE {
        got_a.extend(pull(&mut h, a, 7_000));
        got_b.extend(pull(&mut h, b, 7_000));
    }
    assert_eq!(got_a, pattern(1));
    assert_eq!(got_b, pattern(2));
    h.request("read_finish", json!({"stream": a})).ok();
    h.request("read_finish", json!({"stream": b})).ok();
    // Nothing was read twice: input is at most the two entries plus headers.
    #[cfg(feature = "test-hooks")]
    {
        let used = h.counters()["bytesRead"].as_u64().unwrap() - before;
        assert!(used <= 2 * SIZE as u64 + 4096, "read {used} bytes for two entries of {SIZE}");
    }
}

#[test]
fn two_zip_streams_interleave_without_reading_anything_twice() {
    interleave(&zip_two(), "a.zip");
}

#[test]
fn two_tar_streams_interleave_without_reading_anything_twice() {
    interleave(&tar_two(), "a.tar");
}

#[test]
fn closing_one_stream_leaves_the_other_working() {
    for (bytes, name) in [(zip_two(), "a.zip"), (tar_two(), "a.tar")] {
        let dir = tmpdir();
        let mut h = Helper::spawn();
        h.open(&write(&dir, name, &bytes)).ok();
        let (a, b) = (open_stream(&mut h, 0), open_stream(&mut h, 1));
        let first = pull(&mut h, b, 50_000);
        h.request("read_close", json!({"stream": a})).ok();
        assert_eq!(h.request("read", json!({"stream": a, "length": 10})).err().0, "invalid_path");
        let mut rest = first;
        while rest.len() < SIZE {
            rest.extend(pull(&mut h, b, 60_000));
        }
        assert_eq!(rest, pattern(2));
        h.request("read_finish", json!({"stream": b})).ok();
    }
}

#[test]
fn the_same_entry_can_be_read_by_two_streams_at_once() {
    for (bytes, name) in [(zip_two(), "a.zip"), (tar_two(), "a.tar")] {
        let dir = tmpdir();
        let mut h = Helper::spawn();
        h.open(&write(&dir, name, &bytes)).ok();
        let (x, y) = (open_stream(&mut h, 0), open_stream(&mut h, 0));
        assert_ne!(x, y);
        let first = pull(&mut h, x, 100_000);
        let second_head = pull(&mut h, y, 1_000);
        let rest = pull(&mut h, x, SIZE);
        assert_eq!([first, rest].concat(), pattern(1));
        assert_eq!(second_head, pattern(1)[..1_000].to_vec());
        h.request("read_finish", json!({"stream": x})).ok();
        // y is still at 1 000: finishing it reads the remainder and succeeds.
        h.request("read_finish", json!({"stream": y})).ok();
    }
}

#[test]
fn the_fifth_stream_is_refused_until_one_is_closed() {
    let entries: Vec<ZEntry> = (0..5).map(|i| ZEntry::stored(format!("f{i}").as_bytes(), &pattern(i as u8)[..1000])).collect();
    let dir = tmpdir();
    let mut h = Helper::spawn();
    h.open(&write(&dir, "a.zip", &zip(&entries).bytes)).ok();
    let streams: Vec<u64> = (0..4).map(|i| open_stream(&mut h, i)).collect();
    assert_eq!(h.request("read_open", json!({"id": 4})).err().0, "invalid_path");
    h.request("read_close", json!({"stream": streams[0]})).ok();
    let fifth = open_stream(&mut h, 4);
    assert_eq!(pull(&mut h, fifth, 2000), pattern(4)[..1000].to_vec());
    // The other streams are untouched.
    assert_eq!(pull(&mut h, streams[3], 2000), pattern(3)[..1000].to_vec());
}

#[test]
fn an_unknown_stream_is_refused_for_every_request() {
    let dir = tmpdir();
    let mut h = Helper::spawn();
    h.open(&write(&dir, "a.zip", &zip_two())).ok();
    for t in ["read", "read_finish", "read_close"] {
        assert_eq!(h.request(t, json!({"stream": 77, "length": 10})).err().0, "invalid_path", "{t}");
    }
}

#[test]
fn output_of_all_streams_counts_once_against_the_total_limit() {
    let dir = tmpdir();
    let mut h = Helper::spawn();
    // The entries declare 400 000 bytes (allowed); three streams over them would deliver 600 000.
    h.open_with(&write(&dir, "a.zip", &zip_two()), json!({"maxTotalBytes": 450_000})).ok();
    let streams = [open_stream(&mut h, 0), open_stream(&mut h, 1), open_stream(&mut h, 0)];
    let mut total = 0usize;
    let mut turn = 0usize;
    let refusal = loop {
        let r = h.request("read", json!({"stream": streams[turn % 3], "length": 7_000}));
        turn += 1;
        match r {
            Out::Ok(_, d) => total += d.concat().len(),
            e => break e.err(),
        }
        assert!(turn < 200, "no refusal");
    };
    assert_eq!(refusal, ("limit_exceeded".to_string(), Some("total_bytes".to_string())));
    // Every delivered byte is counted exactly once: the refusal comes within one portion of the limit.
    assert!(total <= 450_000 && total > 450_000 - 7_000, "{total}");
}

#[test]
fn a_changed_archive_stops_every_stream() {
    let dir = tmpdir();
    let path = write(&dir, "a.zip", &zip_two());
    let mut h = Helper::spawn();
    h.open(&path).ok();
    let (a, b) = (open_stream(&mut h, 0), open_stream(&mut h, 1));
    pull(&mut h, a, 10);
    let replacement = write(&dir, "other.zip", &zip_two());
    std::fs::rename(&replacement, &path).unwrap();
    for s in [a, b] {
        assert_eq!(h.request("read", json!({"stream": s, "length": 10})).err().0, "changed_since_plan");
    }
}
