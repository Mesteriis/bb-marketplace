//! What a saved secret is for (stage 3b repair S2).
//!
//! The binding is stored INSIDE the Keychain item, next to the secret (see keychain.rs), and
//! the helper itself compares it with where the secret is about to go: the TypeScript side
//! checks too, but a request that skips it must still not be able to send a saved secret to a
//! host it was not saved for. The shape is the same as `credentialBindSchema` in the page code.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Bind {
    /// A password for one host, port and user (and, for RDP, domain).
    #[serde(rename = "endpoint")]
    Endpoint { protocol: String, host: String, port: u16, user: Option<String>, domain: Option<String> },
    /// The passphrase of one key file.
    #[serde(rename = "key")]
    Key { path: String },
}

const MAX_FIELD: usize = 512;

impl Bind {
    /// Sanity limits for a bind that arrives from the wire.
    pub fn is_valid(&self) -> bool {
        let ok = |s: &str| !s.is_empty() && s.len() <= MAX_FIELD && !s.chars().any(|c| c.is_control());
        match self {
            Bind::Endpoint { protocol, host, user, domain, port } => {
                (protocol == "ssh" || protocol == "rdp")
                    && ok(host)
                    && *port > 0
                    && user.as_deref().map_or(true, ok)
                    && domain.as_deref().map_or(true, ok)
            }
            Bind::Key { path } => ok(path),
        }
    }

    /// The form in which a binding is stored and compared: the host in lower case, which is how
    /// OpenSSH writes it in its prompts (it lowercases DNS names; so does every resolver).
    pub fn canonical(self) -> Bind {
        match self {
            Bind::Endpoint { protocol, host, port, user, domain } => Bind::Endpoint { protocol, host: host.to_ascii_lowercase(), port, user, domain },
            key => key,
        }
    }

    /// A password saved for exactly this RDP endpoint.
    pub fn is_rdp_endpoint(&self, host: &str, port: u16, user: &str, domain: Option<&str>) -> bool {
        *self == Bind::Endpoint { protocol: "rdp".into(), host: host.to_ascii_lowercase(), port, user: Some(user.into()), domain: domain.map(str::to_string) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_shape_matches_the_page_code() {
        let bind: Bind = serde_json::from_str(r#"{"type":"endpoint","protocol":"ssh","host":"h","port":22,"user":"u","domain":null}"#).unwrap();
        assert_eq!(bind, Bind::Endpoint { protocol: "ssh".into(), host: "h".into(), port: 22, user: Some("u".into()), domain: None });
        let key: Bind = serde_json::from_str(r#"{"type":"key","path":"/k"}"#).unwrap();
        assert_eq!(key, Bind::Key { path: "/k".into() });
        assert!(serde_json::from_str::<Bind>(r#"{"type":"other"}"#).is_err());
    }

    #[test]
    fn rdp_matching_is_exact_on_every_field() {
        let b = Bind::Endpoint { protocol: "rdp".into(), host: "w".into(), port: 3389, user: Some("a".into()), domain: Some("CORP".into()) };
        assert!(b.is_rdp_endpoint("w", 3389, "a", Some("CORP")));
        assert!(!b.is_rdp_endpoint("x", 3389, "a", Some("CORP")));
        assert!(!b.is_rdp_endpoint("w", 3390, "a", Some("CORP")));
        assert!(!b.is_rdp_endpoint("w", 3389, "b", Some("CORP")));
        assert!(!b.is_rdp_endpoint("w", 3389, "a", None));
        assert!(!b.is_rdp_endpoint("w", 3389, "a", Some("corp")));
        let ssh = Bind::Endpoint { protocol: "ssh".into(), host: "w".into(), port: 3389, user: Some("a".into()), domain: Some("CORP".into()) };
        assert!(!ssh.is_rdp_endpoint("w", 3389, "a", Some("CORP")), "an ssh password must not open an rdp session");
        assert!(!Bind::Key { path: "/k".into() }.is_rdp_endpoint("w", 3389, "a", None));
    }

    #[test]
    fn a_host_is_stored_and_compared_in_lower_case() {
        let stored = Bind::Endpoint { protocol: "rdp".into(), host: "Win.Example.TEST".into(), port: 3389, user: Some("a".into()), domain: None }.canonical();
        assert_eq!(stored, Bind::Endpoint { protocol: "rdp".into(), host: "win.example.test".into(), port: 3389, user: Some("a".into()), domain: None });
        assert!(stored.is_rdp_endpoint("WIN.example.test", 3389, "a", None));
        // The user is case-sensitive; only the host is folded.
        assert!(!stored.is_rdp_endpoint("win.example.test", 3389, "A", None));
        let v6 = Bind::Endpoint { protocol: "ssh".into(), host: "FE80::ABCD".into(), port: 22, user: Some("u".into()), domain: None }.canonical();
        assert_eq!(v6, Bind::Endpoint { protocol: "ssh".into(), host: "fe80::abcd".into(), port: 22, user: Some("u".into()), domain: None });
    }

    #[test]
    fn limits() {
        assert!(!Bind::Key { path: String::new() }.is_valid());
        assert!(!Bind::Key { path: "a\nb".into() }.is_valid());
        assert!(!Bind::Endpoint { protocol: "ftp".into(), host: "h".into(), port: 1, user: None, domain: None }.is_valid());
        assert!(Bind::Endpoint { protocol: "rdp".into(), host: "h".into(), port: 3389, user: Some("u".into()), domain: None }.is_valid());
    }
}
