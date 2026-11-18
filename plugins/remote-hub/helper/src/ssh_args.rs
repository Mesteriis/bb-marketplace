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
                // "none": OpenSSH reads no configuration file at all (a saved secret's session).
                if v != "none" && !absolute_path_ok(v) {
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
                } else if v == "IdentityAgent=none" {
                    // A key passphrase session must not offer agent identities; at most once.
                    if !seen.insert("IdentityAgent".to_string()) {
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

/// How a session that uses a saved secret authenticates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    PublicKey,
}

/// What a session that uses a saved secret is going to do, read from its own argv (never from a
/// field the client could set separately from it).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SshFacts {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub identity: Option<String>,
    pub method: AuthMethod,
}

impl SshFacts {
    /// The exact one-line prompt OpenSSH writes for this session's secret.
    pub fn expected_prompt(&self) -> String {
        match self.method {
            AuthMethod::Password => format!("{}@{}'s password: ", self.user.as_deref().unwrap_or(""), self.host),
            AuthMethod::PublicKey => format!("Enter passphrase for key '{}': ", self.identity.as_deref().unwrap_or("")),
        }
    }
}

/// The rules for a session that may use a saved secret, on top of `validate_ssh_spawn`: no
/// configuration files, one fixed method, two password prompts (the second one is how a refusal
/// is noticed), and everything that decides where the secret may go present in the argv:
///   password: -l user, PreferredAuthentications=password
///   key:      -i key + IdentitiesOnly=yes, IdentityAgent=none, PreferredAuthentications=publickey
pub fn askpass_facts(argv: &[String]) -> Result<SshFacts, String> {
    let bad = ssh_option_rejected;
    let last = argv.len().checked_sub(2).ok_or_else(bad)?;
    let host = argv.get(last + 1).ok_or_else(bad)?.clone();
    if host.contains('@') {
        return Err(bad());
    }
    let (mut user, mut port, mut identity, mut no_config) = (None, 22u16, None, false);
    let (mut method, mut prompts, mut agent_none, mut identities_only) = (None, false, false, false);
    // Strict on its own, not only on top of validate_ssh_spawn: every option once, only these values.
    let mut seen: HashSet<String> = HashSet::new();
    let mut i = 2;
    while i < last {
        let (key, value) = (argv[i].as_str(), argv.get(i + 1).ok_or_else(bad)?.as_str());
        let unique = if key == "-o" { value.split('=').next().unwrap_or("").to_string() } else { key.to_string() };
        if !seen.insert(unique) {
            return Err(bad());
        }
        match key {
            "-l" => user = Some(value.to_string()),
            "-p" => port = value.parse().map_err(|_| bad())?,
            "-F" if value == "none" => no_config = true,
            "-i" => identity = Some(value.to_string()),
            "-o" => match value {
                "PreferredAuthentications=password" => method = Some(AuthMethod::Password),
                "PreferredAuthentications=publickey" => method = Some(AuthMethod::PublicKey),
                "NumberOfPasswordPrompts=2" => prompts = true,
                "IdentityAgent=none" => agent_none = true,
                "IdentitiesOnly=yes" => identities_only = true,
                v if v.starts_with("UserKnownHostsFile=") => {}
                _ => return Err(bad()),
            },
            _ => return Err(bad()),
        }
        i += 2;
    }
    let method = method.ok_or_else(bad)?;
    if !no_config || !prompts {
        return Err(bad());
    }
    match method {
        AuthMethod::Password if user.is_none() => return Err(bad()),
        AuthMethod::PublicKey if identity.is_none() || !agent_none || !identities_only => return Err(bad()),
        _ => {}
    }
    Ok(SshFacts { host, port, user, identity, method })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_saved_secret_session_must_carry_everything_that_decides_where_the_secret_goes() {
        let password = ["ssh", "-tt", "-l", "root", "-p", "2222", "-F", "none", "-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=2", "--", "box.test"];
        let facts = askpass_facts(&argv(&password)).unwrap();
        assert_eq!(facts, SshFacts { host: "box.test".into(), port: 2222, user: Some("root".into()), identity: None, method: AuthMethod::Password });
        assert_eq!(facts.expected_prompt(), "root@box.test's password: ");
        let key = ["ssh", "-tt", "-F", "none", "-i", "/k/id", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "PreferredAuthentications=publickey", "-o", "NumberOfPasswordPrompts=2", "--", "box.test"];
        let facts = askpass_facts(&argv(&key)).unwrap();
        assert_eq!(facts.port, 22);
        assert_eq!(facts.expected_prompt(), "Enter passphrase for key '/k/id': ");
        // Each piece is required: removing any one is refused.
        for missing in ["-l root", "-F none", "-o PreferredAuthentications=password", "-o NumberOfPasswordPrompts=2"] {
            let pair: Vec<&str> = missing.split(' ').collect();
            let mut v = password.to_vec();
            let pos = v.windows(2).position(|w| w == pair.as_slice()).unwrap();
            v.drain(pos..pos + 2);
            assert!(askpass_facts(&argv(&v)).is_err(), "{missing} must be required");
        }
        for missing in ["-i /k/id", "-F none", "-o IdentitiesOnly=yes", "-o IdentityAgent=none", "-o PreferredAuthentications=publickey", "-o NumberOfPasswordPrompts=2"] {
            let pair: Vec<&str> = missing.split(' ').collect();
            let mut v = key.to_vec();
            let pos = v.windows(2).position(|w| w == pair.as_slice()).unwrap();
            v.drain(pos..pos + 2);
            assert!(askpass_facts(&argv(&v)).is_err(), "{missing} must be required");
        }
        // A destination carrying a user is refused (the user must come from -l).
        let mut v = password.to_vec();
        *v.last_mut().unwrap() = "root@box.test";
        assert!(askpass_facts(&argv(&v)).is_err());
    }

    #[test]
    fn dash_f_none_and_identity_agent_none_are_allowed_once_and_nothing_else_like_them() {
        let ok = |opts: &[&str]| {
            let mut a: Vec<String> = vec!["ssh".into(), "-tt".into()];
            for o in opts {
                a.push((*o).into());
            }
            a.push("--".into());
            a.push("h".into());
            validate_ssh_spawn("/usr/bin/ssh", &a, &HashMap::new()).is_ok()
        };
        assert!(ok(&["-F", "none"]));
        assert!(!ok(&["-F", "None"]));
        assert!(!ok(&["-F", "relative.conf"]));
        assert!(ok(&["-o", "IdentityAgent=none"]));
        assert!(!ok(&["-o", "IdentityAgent=/tmp/agent.sock"]));
        assert!(!ok(&["-o", "IdentityAgent=none", "-o", "IdentityAgent=none"]));
    }

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
