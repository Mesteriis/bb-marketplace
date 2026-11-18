//! Maps IronRDP / rustls outcomes to the stable codes the client sees. Pure:
//! no I/O, so the literals below are unit-tested. Library error text is never
//! forwarded as a code.
use ironrdp_connector::{ConnectorError, ConnectorErrorKind};
use ironrdp_session::GracefulDisconnectReason;

use super::reasons::RdpClosedReason;

/// Which step of the connection sequence produced an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// X.224 negotiation (`connect_begin`), before TLS.
    Negotiate,
    /// Security exchange and everything after TLS (`connect_finalize`).
    Finalize,
}

fn has_io_source(e: &ConnectorError) -> bool {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = cur {
        if err.downcast_ref::<std::io::Error>().is_some() {
            return true;
        }
        cur = err.source();
    }
    false
}

/// A CredSSP public-key echo/hash mismatch means the TLS peer is not the
/// machine that authenticated: a possible man in the middle, never a wrong
/// password.
fn is_public_key_mismatch(e: &ironrdp_connector::sspi::Error) -> bool {
    use ironrdp_connector::sspi::ErrorKind;
    e.error_type == ErrorKind::MessageAltered && e.description.to_ascii_lowercase().contains("public key")
}

/// The closed reason for a connect-sequence error. None of these cases is ever
/// retried by the engine.
pub fn map_connector_error(phase: Phase, e: &ConnectorError) -> RdpClosedReason {
    match e.kind() {
        // The server refused TLS or HYBRID (CredSSP): a security-layer
        // problem, not a network one.
        ConnectorErrorKind::Negotiation(_) => RdpClosedReason::TlsError,
        ConnectorErrorKind::AccessDenied => RdpClosedReason::AuthFailed,
        ConnectorErrorKind::Credssp(inner) => {
            if is_public_key_mismatch(inner) {
                RdpClosedReason::TlsError
            } else {
                RdpClosedReason::AuthFailed
            }
        }
        ConnectorErrorKind::EntraAuth(_) => RdpClosedReason::AuthFailed,
        _ if has_io_source(e) => RdpClosedReason::NetworkError,
        _ => match phase {
            Phase::Negotiate | Phase::Finalize => RdpClosedReason::ProtocolError,
        },
    }
}

/// An orderly server disconnect is not a protocol error.
pub fn map_terminate(reason: &GracefulDisconnectReason) -> RdpClosedReason {
    match reason {
        GracefulDisconnectReason::UserInitiated
        | GracefulDisconnectReason::ServerInitiated
        | GracefulDisconnectReason::Other(_) => RdpClosedReason::ServerDisconnected,
    }
}

/// A stable code for why a certificate failed strict validation, from rustls'
/// error text. The text itself travels only as optional detail.
pub fn cert_reason_code(rustls_error: &str) -> &'static str {
    // `CaUsedAsEndEntity`: a self-signed certificate that carries the CA flag
    // (what `openssl req -x509` makes, and what xrdp ships) is rejected by
    // webpki before the issuer lookup; to the user it is the same case: the
    // certificate does not chain to a trusted root.
    if rustls_error.contains("UnknownIssuer") || rustls_error.contains("CaUsedAsEndEntity") {
        "untrusted_root"
    } else if rustls_error.contains("NotValidForName") {
        "hostname_mismatch"
    } else if rustls_error.contains("Expired") {
        "expired"
    } else {
        "other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_connector::sspi::{Error as SspiError, ErrorKind as SspiKind};
    use ironrdp_connector::{ConnectorErrorExt as _, NegotiationFailure};
    use ironrdp_pdu::nego::FailureCode;

    fn credssp(kind: SspiKind, text: &str) -> ConnectorError {
        ConnectorError::new("CredSSP", ConnectorErrorKind::Credssp(SspiError::new(kind, text)))
    }

    #[test]
    fn tls_or_hybrid_refusal_is_tls_error_not_network_error() {
        for code in [FailureCode::SSL_REQUIRED_BY_SERVER, FailureCode::HYBRID_REQUIRED_BY_SERVER, FailureCode::SSL_NOT_ALLOWED_BY_SERVER] {
            let e = ConnectorError::new("nego", ConnectorErrorKind::Negotiation(NegotiationFailure::from(code)));
            assert_eq!(map_connector_error(Phase::Negotiate, &e).as_str(), "tls_error");
        }
    }

    #[test]
    fn credssp_public_key_mismatch_is_tls_error_never_auth_failed() {
        let e = credssp(SspiKind::MessageAltered, "could not verify a public key echo");
        assert_eq!(map_connector_error(Phase::Finalize, &e).as_str(), "tls_error");
        let e = credssp(SspiKind::MessageAltered, "could not verify a public key hash");
        assert_eq!(map_connector_error(Phase::Finalize, &e).as_str(), "tls_error");
    }

    #[test]
    fn credssp_credential_failures_are_auth_failed() {
        let e = credssp(SspiKind::LogonDenied, "logon denied");
        assert_eq!(map_connector_error(Phase::Finalize, &e).as_str(), "auth_failed");
        // MessageAltered without the public-key text is the NTLM bad-credentials case.
        let e = credssp(SspiKind::MessageAltered, "message integrity check failed");
        assert_eq!(map_connector_error(Phase::Finalize, &e).as_str(), "auth_failed");
        let e = ConnectorError::new("CredSSP", ConnectorErrorKind::AccessDenied);
        assert_eq!(map_connector_error(Phase::Finalize, &e).as_str(), "auth_failed");
    }

    #[test]
    fn io_failures_are_network_errors_and_the_rest_protocol_errors() {
        let io = std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset");
        let e = ConnectorError::custom("read frame", io);
        assert_eq!(map_connector_error(Phase::Finalize, &e).as_str(), "network_error");
        let e = ConnectorError::general("unexpected state");
        assert_eq!(map_connector_error(Phase::Finalize, &e).as_str(), "protocol_error");
        let e = ConnectorError::reason("x", "bad pdu");
        assert_eq!(map_connector_error(Phase::Negotiate, &e).as_str(), "protocol_error");
    }

    #[test]
    fn orderly_server_terminate_is_not_a_protocol_error() {
        assert_eq!(map_terminate(&GracefulDisconnectReason::UserInitiated).as_str(), "server_disconnected");
        assert_eq!(map_terminate(&GracefulDisconnectReason::ServerInitiated).as_str(), "server_disconnected");
        assert_eq!(map_terminate(&GracefulDisconnectReason::Other("idle timeout".into())).as_str(), "server_disconnected");
    }

    #[test]
    fn certificate_failures_have_stable_codes() {
        // The Display text of rustls 0.23 errors.
        assert_eq!(cert_reason_code("invalid peer certificate: UnknownIssuer"), "untrusted_root");
        // Observed against xrdp's self-signed (CA:TRUE) certificate.
        assert_eq!(
            cert_reason_code("invalid peer certificate: Other(OtherError(CaUsedAsEndEntity))"),
            "untrusted_root"
        );
        assert_eq!(
            cert_reason_code("invalid peer certificate: NotValidForNameContext { expected: IpAddress(V4(Ipv4Addr([127, 0, 0, 1]))), presented: [] }"),
            "hostname_mismatch"
        );
        assert_eq!(cert_reason_code("invalid peer certificate: NotValidForName"), "hostname_mismatch");
        assert_eq!(cert_reason_code("invalid peer certificate: Expired"), "expired");
        assert_eq!(cert_reason_code("invalid peer certificate: ExpiredContext { time: UnixTime(1), not_after: UnixTime(0) }"), "expired");
        assert_eq!(cert_reason_code("invalid peer certificate: BadSignature"), "other");
        assert_eq!(cert_reason_code(""), "other");
    }
}
