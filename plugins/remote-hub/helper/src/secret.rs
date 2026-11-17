//! A string that never prints. Passwords travel in this wrapper so a stray
//! `{:?}` (a derived `Debug` on a request or command) cannot leak them.
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Secret(value.into())
    }

    /// The raw value. Call only where the secret is consumed (the connector
    /// credentials, the socketpair frame).
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_prints_the_value() {
        let s = Secret::new("S3cr3t-MARK-91");
        assert_eq!(format!("{s:?}"), "Secret(<redacted>)");
        assert_eq!(format!("{s:#?}"), "Secret(<redacted>)");
    }

    #[test]
    fn serializes_as_a_plain_json_string() {
        let s = Secret::new("abc");
        assert_eq!(serde_json::to_string(&s).unwrap(), "\"abc\"");
        let back: Secret = serde_json::from_str("\"abc\"").unwrap();
        assert_eq!(back.expose(), "abc");
    }
}
