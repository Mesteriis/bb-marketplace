//! TLS trust for the PVE API and console sockets. Three modes and no way to switch verification off:
//! the system roots, one owner-supplied CA, or one pinned leaf certificate. Whatever certificate the
//! server presents is recorded (SHA-256), so a refusal can show the owner exactly what to confirm.
use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, ClientConfig, DigitallySignedStruct, Error, RootCertStore, SignatureScheme};

use super::protocol::Trust;
use crate::rdp::cert::{fingerprint_matches, fingerprint_sha256};

/// The leaf fingerprint the server presented in the latest handshake.
#[derive(Clone, Default)]
pub struct Presented(Arc<Mutex<Option<String>>>);

impl Presented {
    fn set(&self, der: &[u8]) {
        *self.0.lock().unwrap() = Some(fingerprint_sha256(der));
    }
    pub fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
}

#[derive(Debug)]
pub struct Recording {
    inner: Arc<WebPkiServerVerifier>,
    seen: Presented,
}

impl std::fmt::Debug for Presented {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Presented")
    }
}

impl ServerCertVerifier for Recording {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, Error> {
        self.seen.set(end_entity.as_ref());
        self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        self.inner.verify_tls12_signature(m, c, d)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        self.inner.verify_tls13_signature(m, c, d)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// Accepts exactly one leaf certificate, whatever its issuer, name or validity: the owner confirmed it.
#[derive(Debug)]
pub struct Pinned {
    fingerprint: String,
    provider: Arc<CryptoProvider>,
    seen: Presented,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, Error> {
        self.seen.set(end_entity.as_ref());
        if fingerprint_matches(&fingerprint_sha256(end_entity.as_ref()), &self.fingerprint) {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure))
        }
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(m, c, d, &self.provider.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(m, c, d, &self.provider.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2).map(|i| u8::from_str_radix(s.get(2 * i..2 * i + 2)?, 16).ok()).collect()
}

#[derive(Debug, PartialEq, Eq)]
pub struct TrustError(pub &'static str);

/// A client configuration for `trust`, and the cell that learns the presented certificate.
pub fn client_config(trust: &Trust) -> Result<(Arc<ClientConfig>, Presented), TrustError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let seen = Presented::default();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|_| TrustError("tls_setup_failed"))?;
    let config = match trust {
        Trust::Pin { fingerprint } => {
            if !crate::rdp::cert::normalize_fingerprint(fingerprint).is_some() {
                return Err(TrustError("invalid_fingerprint"));
            }
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(Pinned { fingerprint: fingerprint.clone(), provider, seen: seen.clone() }))
                .with_no_client_auth()
        }
        Trust::System | Trust::Ca { .. } => {
            let mut roots = RootCertStore::empty();
            match trust {
                Trust::Ca { der_hex } => {
                    let der = hex_decode(der_hex).ok_or(TrustError("invalid_ca"))?;
                    roots.add(CertificateDer::from(der)).map_err(|_| TrustError("invalid_ca"))?;
                }
                _ => {
                    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
                }
            }
            let inner = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider)
                .build()
                .map_err(|_| TrustError("tls_setup_failed"))?;
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(Recording { inner, seen: seen.clone() }))
                .with_no_client_auth()
        }
    };
    Ok((Arc::new(config), seen))
}

/// Does this handshake failure come from certificate verification?
pub fn is_certificate_failure(e: &std::io::Error) -> bool {
    e.get_ref().and_then(|inner| inner.downcast_ref::<Error>()).is_some_and(|re| matches!(re, Error::InvalidCertificate(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pin_must_be_a_real_fingerprint() {
        assert_eq!(client_config(&Trust::Pin { fingerprint: "nope".into() }).err(), Some(TrustError("invalid_fingerprint")));
    }

    #[test]
    fn a_bad_ca_is_refused() {
        assert_eq!(client_config(&Trust::Ca { der_hex: "zz".into() }).err(), Some(TrustError("invalid_ca")));
        assert_eq!(client_config(&Trust::Ca { der_hex: "00".into() }).err(), Some(TrustError("invalid_ca")));
    }

    #[test]
    fn hex_decode_literals() {
        assert_eq!(hex_decode("00ff10"), Some(vec![0, 255, 16]));
        assert_eq!(hex_decode("0"), None);
    }
}
