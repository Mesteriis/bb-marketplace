//! Strict validation of the ssh spawn shape a production helper accepts for
//! session.open_ssh. This mirrors src/core/ssh-args.ts so the helper cannot be
//! driven to run an arbitrary program or emit an option the TS builder would
//! never produce. Order of the allowed options is intentionally not enforced,
//! because the integration drivers build the same argv in a different (still
//! allowed) order; every option is validated on its own.
use std::collections::{HashMap, HashSet};

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

fn has_dot_segment(s: &str) -> bool {
    s.split('/').any(|seg| seg == "." || seg == "..")
}

fn absolute_path_ok(s: &str) -> bool {
    s.starts_with('/') && !s.chars().any(|c| c.is_control()) && !has_dot_segment(s)
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

/// /dev/null with any run of slashes or a trailing slash still names the null
/// device; ssh would silently accept any host there.
fn is_dev_null(path: &str) -> bool {
    let normalized: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    normalized == ["dev", "null"]
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

    let mut seen = HashSet::new();
    let mut seen_user_known_hosts = false;
    let mut i = 2;
    while i < last {
        let key = argv[i].as_str();
        if !seen.insert(key.to_string()) && key != "-o" {
            return Err(ssh_option_rejected());
        }
        match key {
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
                // The builder always pairs -i with IdentitiesOnly=yes.
                if i + 3 >= last || argv[i + 2] != "-o" || argv[i + 3] != "IdentitiesOnly=yes" {
                    return Err(ssh_option_rejected());
                }
                seen.insert("-o".to_string());
                seen.insert("IdentitiesOnly=yes".to_string());
                i += 4;
            }
            "-o" => {
                let v = opt_value(argv, i, last)?;
                if let Some(path) = v.strip_prefix("UserKnownHostsFile=") {
                    if is_dev_null(path)
                        || !absolute_path_ok(path)
                        || path.chars().any(|c| c.is_whitespace())
                    {
                        return Err(ssh_option_rejected());
                    }
                    if seen_user_known_hosts {
                        return Err(ssh_option_rejected());
                    }
                    seen_user_known_hosts = true;
                } else if v == "IdentitiesOnly=yes" {
                    if !seen.insert("IdentitiesOnly=yes".to_string()) {
                        return Err(ssh_option_rejected());
                    }
                } else if v == "PreferredAuthentications=password" || v == "PreferredAuthentications=publickey" {
                    // Fixes the session's one secret prompt (stage 3b-2); at most once.
                    if !seen.insert("PreferredAuthentications".to_string()) {
                        return Err(ssh_option_rejected());
                    }
                } else if v == "NumberOfPasswordPrompts=2" {
                    // Two prompts for a saved secret: the second one is how a refusal is noticed, and it is never answered (stage 3b-2); at most once.
                    if !seen.insert("NumberOfPasswordPrompts".to_string()) {
                        return Err(ssh_option_rejected());
                    }
                } else {
                    return Err(ssh_option_rejected());
                }
                i += 2;
            }
            _ => return Err(ssh_option_rejected()),
        }
    }

    for (key, value) in env {
        if !env_key_ok(key) {
            return Err(ssh_option_rejected());
        }
        if key == "TERM" && value != "xterm-256color" {
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
            assert!(validate_ssh_spawn("/usr/bin/ssh", &a, &env(&[("TERM", "xterm-256color")])).is_ok());
        }
    }

    #[test]
    fn preferred_authentications_is_allowed_for_password_and_publickey_once_and_nothing_else() {
        let ok = |auth: &str| {
            let a: Vec<String> = ["ssh", "-tt", "-l", "u", "-o", auth, "--", "example.com"].iter().map(|s| s.to_string()).collect();
            validate_ssh_spawn("/usr/bin/ssh", &a, &env(&[("TERM", "xterm-256color")])).is_ok()
        };
        assert!(ok("PreferredAuthentications=password"));
        assert!(ok("PreferredAuthentications=publickey"));
        assert!(!ok("PreferredAuthentications=keyboard-interactive"));
        assert!(!ok("PreferredAuthentications=password,publickey"));
        assert!(!ok("PubkeyAuthentication=no"));
        let twice: Vec<String> = ["ssh", "-tt", "-o", "PreferredAuthentications=password", "-o", "PreferredAuthentications=publickey", "--", "h"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(validate_ssh_spawn("/usr/bin/ssh", &twice, &HashMap::new()).is_err());
    }

    #[test]
    fn number_of_password_prompts_is_allowed_only_as_two_and_only_once() {
        let check = |opts: &[&str]| {
            let mut a: Vec<String> = vec!["ssh".into(), "-tt".into()];
            for o in opts {
                a.push("-o".into());
                a.push((*o).into());
            }
            a.push("--".into());
            a.push("h".into());
            validate_ssh_spawn("/usr/bin/ssh", &a, &HashMap::new()).is_ok()
        };
        assert!(check(&["NumberOfPasswordPrompts=2"]));
        assert!(!check(&["NumberOfPasswordPrompts=3"]));
        assert!(!check(&["NumberOfPasswordPrompts=1"]));
        assert!(!check(&["NumberOfPasswordPrompts=2", "NumberOfPasswordPrompts=2"]));
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
                Some(_) => assert!(result.is_err(), "expected reject for {:?}", case.argv),
            }
        }
    }
}
