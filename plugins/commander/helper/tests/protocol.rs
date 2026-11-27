mod common;
use common::*;
use serde_json::json;

#[test]
fn version_flag_prints_the_exact_line() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_commander-archive-helper")).arg("--version").output().unwrap();
    assert_eq!(String::from_utf8(out.stdout).unwrap(), "commander-archive-helper 0.1.0\n");
    assert!(out.status.success());
}

#[test]
fn any_other_argument_is_refused() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_commander-archive-helper")).arg("/tmp/x").output().unwrap();
    assert_eq!(out.status.code(), Some(64));
}

#[test]
fn hello_carries_versions_and_the_rlimit_probe() {
    let h = Helper::spawn();
    assert_eq!(h.hello["t"], "hello");
    assert_eq!(h.hello["protocol"], 1);
    assert_eq!(h.hello["helper"], "0.1.0");
    assert_eq!(h.hello["zip"], "8.6.0");
    assert_eq!(h.hello["tar"], "0.4.46");
    let v = h.hello["rlimit_as"].as_str().unwrap().to_string();
    assert!(["enforced", "not_enforced", "failed"].contains(&v.as_str()));
    println!("RLIMIT_AS probe on this machine: {v}");
    h.expect_exit(0);
}

#[test]
fn clean_eof_between_frames_exits_zero() {
    Helper::spawn().expect_exit(0);
}

fn fatal(bytes: &[u8]) {
    let mut h = Helper::spawn();
    h.raw(bytes);
    h.expect_exit(2);
}

fn frame_bytes(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = ((payload.len() + 1) as u32).to_le_bytes().to_vec();
    v.push(kind);
    v.extend_from_slice(payload);
    v
}

#[test]
fn zero_length_frame_is_fatal() {
    fatal(&0u32.to_le_bytes());
}

#[test]
fn unknown_kind_is_fatal() {
    fatal(&frame_bytes(9, b"{}"));
}

#[test]
fn control_frame_that_is_not_json_is_fatal() {
    fatal(&frame_bytes(1, b"{{"));
}

#[test]
fn control_frame_too_short_is_fatal() {
    fatal(&frame_bytes(1, b"{"));
}

#[test]
fn control_frame_that_is_not_utf8_is_fatal() {
    fatal(&frame_bytes(1, b"{\"a\":\"\xff\"}"));
}

#[test]
fn oversized_control_length_is_refused_before_allocation() {
    // Declares 2 GiB; the helper must exit without trying to read it.
    let mut v = (0x8000_0000u32).to_le_bytes().to_vec();
    v.push(1);
    fatal(&v);
}

#[test]
fn data_frame_without_a_request_is_fatal() {
    let mut p = 7u32.to_le_bytes().to_vec();
    p.extend_from_slice(b"xx");
    fatal(&frame_bytes(2, &p));
}

#[test]
fn data_frame_shorter_than_its_req_id_is_fatal() {
    fatal(&frame_bytes(2, b"ab"));
}

#[test]
fn secret_frame_without_need_password_is_fatal() {
    let mut p = 1u32.to_le_bytes().to_vec();
    p.extend_from_slice(b"pw");
    fatal(&frame_bytes(3, &p));
}

#[test]
fn secret_frame_without_any_password_byte_is_fatal() {
    fatal(&frame_bytes(3, &1u32.to_le_bytes()));
}

#[test]
fn request_without_a_valid_req_is_fatal() {
    fatal(&frame_bytes(1, br#"{"t":"verify","req":0}"#));
    fatal(&frame_bytes(1, br#"{"t":"verify"}"#));
}

#[test]
fn a_second_hello_is_an_unknown_request_and_fatal() {
    fatal(&frame_bytes(1, br#"{"t":"hello","req":1}"#));
}

#[test]
fn eof_inside_a_frame_is_fatal() {
    let mut v = 10u32.to_le_bytes().to_vec();
    v.push(1);
    v.extend_from_slice(b"{}");
    fatal(&v);
}

#[test]
fn pipelined_second_request_is_fatal() {
    let mut h = Helper::spawn();
    let one = frame_bytes(1, br#"{"t":"verify","req":1}"#);
    let two = frame_bytes(1, br#"{"t":"verify","req":2}"#);
    let mut both = one;
    both.extend(two);
    h.raw(&both);
    h.expect_exit(2);
}

#[test]
fn requests_before_open_are_refused_not_fatal() {
    let mut h = Helper::spawn();
    let (code, _) = h.request("list", json!({"prefix": "", "limit": 10})).err();
    assert_eq!(code, "invalid_path");
    h.expect_exit(0);
}
