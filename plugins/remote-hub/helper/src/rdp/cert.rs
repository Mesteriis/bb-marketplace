//! Certificate fingerprinting, decision matching and field extraction for the
//! RDP TLS certificate prompt (stage 2b contract B3). Pure; uses only sha2 and
//! x509-cert.
use sha2::{Digest, Sha256};

/// SHA-256 fingerprint of the DER certificate, 64 uppercase hex chars,
/// colon-separated (e.g. "AA:BB:…").
pub fn fingerprint_sha256(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    let mut out = String::with_capacity(64 + 31);
    for (i, byte) in digest.iter().enumerate() {
        if i > 0 {
            out.push(':');
        }
        out.push_str(&format!("{byte:02X}"));
    }
    out
}

fn normalize_fingerprint(input: &str) -> Option<[u8; 32]> {
    let hex: String = input.chars().filter(|c| *c != ':').collect();
    if hex.len() != 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    for i in 0..32 {
        let pair = hex.get(2 * i..2 * i + 2)?;
        bytes[i] = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(bytes)
}

/// Compare two fingerprints independent of case and colons. Both must be valid
/// 32-byte fingerprints.
pub fn fingerprint_matches(presented: &str, decision: &str) -> bool {
    match (normalize_fingerprint(presented), normalize_fingerprint(decision)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// Human-readable fields extracted from a DER certificate, for the prompt UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertFields {
    pub subject: String,
    pub issuer: String,
    pub not_before: String,
    pub not_after: String,
}

fn system_time_seconds(t: std::time::SystemTime) -> String {
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs().to_string(),
        Err(_) => "0".to_string(),
    }
}

/// The first dNSName of the SubjectAltName extension, else its first IP address.
fn first_san(tbs: &x509_cert::TbsCertificate) -> Option<String> {
    use x509_cert::ext::pkix::{name::GeneralName, SubjectAltName};
    let (_, san) = tbs.get_extension::<SubjectAltName>().ok()??;
    let mut ip = None;
    for name in san.0 {
        match name {
            GeneralName::DnsName(dns) => return Some(format!("DNS:{}", dns.as_str())),
            GeneralName::IpAddress(octets) if ip.is_none() => {
                let b = octets.as_bytes();
                ip = match b.len() {
                    4 => Some(format!("IP:{}.{}.{}.{}", b[0], b[1], b[2], b[3])),
                    16 => {
                        let groups: Vec<String> = b.chunks(2).map(|p| format!("{:x}", u16::from_be_bytes([p[0], p[1]]))).collect();
                        Some(format!("IP:{}", groups.join(":")))
                    }
                    _ => None,
                };
            }
            _ => {}
        }
    }
    ip
}

pub fn parse_cert_fields(der: &[u8]) -> Option<CertFields> {
    use x509_cert::der::Decode as _;
    let cert = x509_cert::Certificate::from_der(der).ok()?;
    let tbs = cert.tbs_certificate();
    let mut subject = tbs.subject().to_string();
    if subject.is_empty() {
        // A certificate may carry no subject at all and name the host only in its
        // SubjectAltName. Show that name, and say that the subject was empty, so
        // the prompt never presents a blank identity.
        subject = match first_san(tbs) {
            Some(san) => format!("(empty subject) SAN: {san}"),
            None => "(empty subject)".to_string(),
        };
    }
    Some(CertFields {
        subject,
        issuer: tbs.issuer().to_string(),
        not_before: system_time_seconds(tbs.validity().not_before.to_system_time()),
        not_after: system_time_seconds(tbs.validity().not_after.to_system_time()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_der() -> Vec<u8> {
        let hex = include_str!("../../tests/fixtures/rdp-cert.hex").trim();
        (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn fingerprint_matches_the_openssl_literal() {
        // The fixture was generated with:
        //   openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=rh-test.example.com/O=Remote Hub Test/C=US"
        //   openssl x509 -noout -fingerprint -sha256
        let expected = "75:B2:CE:77:71:A3:C0:EC:5C:BC:9E:3A:41:FF:0E:9F:BF:0E:CB:5B:01:7C:BE:5D:13:E9:41:7C:73:DF:65:7E";
        assert_eq!(fingerprint_sha256(&fixture_der()), expected);
    }

    #[test]
    fn fingerprint_matches_is_case_and_colon_insensitive() {
        let a = "75:B2:CE:77:71:A3:C0:EC:5C:BC:9E:3A:41:FF:0E:9F:BF:0E:CB:5B:01:7C:BE:5D:13:E9:41:7C:73:DF:65:7E";
        assert!(fingerprint_matches(a, "75b2ce7771a3c0ec5cbc9e3a41ff0e9fbf0ecb5b017cbe5d13e9417c73df657e"));
        assert!(fingerprint_matches(a, a));
        // A single changed byte no longer matches.
        let wrong = "74:B2:CE:77:71:A3:C0:EC:5C:BC:9E:3A:41:FF:0E:9F:BF:0E:CB:5B:01:7C:BE:5D:13:E9:41:7C:73:DF:65:7E";
        assert!(!fingerprint_matches(a, wrong));
    }

    #[test]
    fn fingerprint_matches_rejects_invalid_input() {
        assert!(!fingerprint_matches("not-a-fingerprint", "75:B2:CE:77:71:A3:C0:EC:5C:BC:9E:3A:41:FF:0E:9F:BF:0E:CB:5B:01:7C:BE:5D:13:E9:41:7C:73:DF:65:7E"));
        assert!(!fingerprint_matches("", ""));
    }

    fn der_of(hex: &str) -> Vec<u8> {
        let hex = hex.trim();
        (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn an_empty_subject_shows_the_first_san_and_says_so() {
        // Generated with: openssl req -x509 -newkey rsa:2048 -nodes -subj "/" \
        //   -addext "subjectAltName=DNS:san-only.example.com,DNS:second.example.com" -outform DER
        let der = der_of(include_str!("../../tests/fixtures/rdp-cert-empty-subject.hex"));
        let fields = parse_cert_fields(&der).expect("fixture parses");
        assert_eq!(fields.subject, "(empty subject) SAN: DNS:san-only.example.com");
        assert_eq!(fields.issuer, "", "the issuer of this self-signed certificate is empty too");
    }

    #[test]
    fn a_named_subject_is_left_alone_even_when_a_san_exists() {
        let fields = parse_cert_fields(&fixture_der()).expect("fixture parses");
        assert_eq!(fields.subject, "C=US,O=Remote Hub Test,CN=rh-test.example.com");
    }

    #[test]
    fn extracts_subject_issuer_and_validity_literals() {
        let fields = parse_cert_fields(&fixture_der()).expect("fixture parses");
        // RFC 4514 order (x509-cert Display).
        assert_eq!(fields.subject, "C=US,O=Remote Hub Test,CN=rh-test.example.com");
        assert_eq!(fields.issuer, "C=US,O=Remote Hub Test,CN=rh-test.example.com");
        // notBefore=Nov 17 02:28:54 2026 GMT, notAfter=Nov 17 02:28:54 2027 GMT.
        assert_eq!(fields.not_before, "1794882534");
        assert_eq!(fields.not_after, "1826418534");
    }
}
