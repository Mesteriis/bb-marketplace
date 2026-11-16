//! Strict validation of the ssh spawn shape a production helper accepts for
//! session.open_ssh. This mirrors src/core/ssh-args.ts so the helper cannot be
//! driven to run an arbitrary program or emit an option the TS builder would
//! never produce. Order of the allowed options is intentionally not enforced,
//! because the integration drivers build the same argv in a different (still
//! allowed) order; every option is validated on its own.
use std::collections::HashMap;

pub fn ssh_option_rejected() -> String {
    "ssh_option_rejected".to_string()
}

fn has_shell_metachar(s: &str) -> bool {
    s.chars().any(|c| {
        c.is_whitespace()
            || c.is_control()
            || matches!(
                c,
                '=' | ';' | '&' | '|' | '\u{60}' | '$' | '<' | '>' | '*' | '?' | '!' | '\\'
                    | '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | '~'
            )
    })
}

fn token_ok(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !has_shell_metachar(s)
}

fn absolute_path_ok(s: &str) -> bool {
    s.starts_with('/') && !s.chars().any(|c| c.is_control())
}

fn env_key_ok(key: &str) -> bool {
    key == "TERM"
        || key == "LANG"
        || key.starts_with("LC_")
        || key == "HOME"
        || key == "USER"
        || key == "PATH"
        || key == "SSH_AUTH_SOCK"
}

fn opt_value<'a>(argv: &'a [String], i: usize, last: usize) -> Result<&'a str, String> {
    if i + 1 >= last {
        return Err(ssh_option_rejected());
    }
    Ok(argv[i + 1].as_str())
}

pub fn validate_ssh_spawn(
    program: &str,
    argv: &[String],
    env: &HashMap<String, String>,
) -> Result<(), String> {
    if program != "/usr/bin/ssh" {
        return Err(ssh_option_rejected());
    }
    if argv.len() < 4 || argv[0] != "ssh" || argv[1] != "-tt" {
        return Err(ssh_option_rejected());
    }
    let last = argv.len() - 2; // index of the "--" that precedes the destination
    if argv[last] != "--" {
        return Err(ssh_option_rejected());
    }
    let host = argv[last + 1].as_str();
    if !token_ok(host) {
        return Err(ssh_option_rejected());
    }

    let mut i = 2;
    while i < last {
        match argv[i].as_str() {
            "-l" => {
                let v = opt_value(argv, i, last)?;
                if !token_ok(v) {
                    return Err(ssh_option_rejected());
                }
                i += 2;
            }
            "-p" => {
                let v = opt_value(argv, i, last)?;
                let ok = v
                    .parse::<u32>()
                    .map(|n| (1..=65535).contains(&n))
                    .unwrap_or(false);
                if !ok {
                    return Err(ssh_option_rejected());
                }
                i += 2;
            }
            "-F" => {
                let v = opt_value(argv, i, last)?;
                if !absolute_path_ok(v) {
                    return Err(ssh_option_rejected());
                }
                i += 2;
            }
            "-i" => {
                let v = opt_value(argv, i, last)?;
                if !absolute_path_ok(v) {
                    return Err(ssh_option_rejected());
                }
                i += 2;
            }
            "-o" => {
                let v = opt_value(argv, i, last)?;
                if let Some(path) = v.strip_prefix("UserKnownHostsFile=") {
                    if path == "/dev/null" || !absolute_path_ok(path) {
                        return Err(ssh_option_rejected());
                    }
                } else if v == "IdentitiesOnly=yes" {
                    // accepted
                } else {
                    return Err(ssh_option_rejected());
                }
                i += 2;
            }
            _ => return Err(ssh_option_rejected()),
        }
    }

    for key in env.keys() {
        if !env_key_ok(key) {
            return Err(ssh_option_rejected());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(map: &[(&str, &str)]) -> HashMap<String, String> {
        map.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn accepts_builder_and_driver_order() {
        let builder = vec![
            "ssh", "-tt", "-l", "alice", "-p", "22", "-F", "/tmp/cfg", "-o",
            "UserKnownHostsFile=/tmp/kh", "-i", "/tmp/id", "-o", "IdentitiesOnly=yes", "--",
            "example.com",
        ];
        let driver = vec![
            "ssh", "-tt", "-F", "/tmp/cfg", "-o", "UserKnownHostsFile=/tmp/kh", "-i", "/tmp/id",
            "-o", "IdentitiesOnly=yes", "-p", "2222", "--", "root@127.0.0.1",
        ];
        for argv in [builder, driver] {
            let a: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
            assert!(validate_ssh_spawn("/usr/bin/ssh", &a, &env(&[("TERM", "xterm")])).is_ok());
        }
    }

    #[test]
    fn rejects_forbidden_programs_and_options() {
        assert!(validate_ssh_spawn("/bin/sh", &vec![], &HashMap::new()).is_err());

        for bad in [
            vec!["ssh", "-tt", "-A", "--", "example.com"],
            vec!["ssh", "-tt", "-L", "8080:localhost:80", "--", "example.com"],
            vec!["ssh", "-tt", "-oProxyCommand=evil", "--", "example.com"],
            vec!["ssh", "-tt", "-o", "StrictHostKeyChecking=no", "--", "example.com"],
            vec!["ssh", "-tt", "-o", "UserKnownHostsFile=/dev/null", "--", "example.com"],
            vec!["ssh", "-tt", "--"],
        ] {
            let a: Vec<String> = bad.iter().map(|s| s.to_string()).collect();
            assert_eq!(
                validate_ssh_spawn("/usr/bin/ssh", &a, &HashMap::new()),
                Err(ssh_option_rejected()),
                "should reject {a:?}"
            );
        }
        let base = vec!["ssh", "-tt", "--", "example.com"];
        let a: Vec<String> = base.iter().map(|s| s.to_string()).collect();
        assert!(validate_ssh_spawn("/usr/bin/ssh", &a, &HashMap::new()).is_ok());
    }

    // The same fixture as src/core/ssh-args.test.ts, so the TS builder and the
    // Rust validator cannot drift.
    #[test]
    fn matches_shared_fixture() {
        #[derive(serde::Deserialize)]
        struct Case {
            argv: Vec<String>,
            error: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }
        let fixture: Fixture =
            serde_json::from_str(include_str!("../../tests/fixtures/ssh-args.json")).unwrap();
        for case in fixture.cases {
            let result = validate_ssh_spawn("/usr/bin/ssh", &case.argv, &HashMap::new());
            match case.error {
                None => assert!(result.is_ok(), "expected accept for {:?}", case.argv),
                Some(code) => {
                    assert_eq!(result, Err(code.clone()), "expected {code} for {:?}", case.argv)
                }
            }
        }
    }
}
