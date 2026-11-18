//! Closed-reason codes for an RDP session (stage 2b contract B2/B4). These are
//! the literal strings reported in `session.closed` / `rdp.closed` and stored in
//! the session record; they are never free-form error text.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RdpClosedReason {
    AuthFailed,
    CertRejected,
    CertChanged,
    TlsError,
    ProtocolError,
    NetworkError,
    Timeout,
    KilledByClose,
    EngineExited,
    HelperShutdown,
    /// The server ended the session in an orderly way (logoff, disconnect,
    /// idle timeout). Not a protocol failure.
    ServerDisconnected,
}

impl RdpClosedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RdpClosedReason::AuthFailed => "auth_failed",
            RdpClosedReason::CertRejected => "cert_rejected",
            RdpClosedReason::CertChanged => "cert_changed",
            RdpClosedReason::TlsError => "tls_error",
            RdpClosedReason::ProtocolError => "protocol_error",
            RdpClosedReason::NetworkError => "network_error",
            RdpClosedReason::Timeout => "timeout",
            RdpClosedReason::KilledByClose => "killed_by_close",
            RdpClosedReason::EngineExited => "engine_exited",
            RdpClosedReason::HelperShutdown => "helper_shutdown",
            RdpClosedReason::ServerDisconnected => "server_disconnected",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_reason_maps_to_its_literal() {
        let cases = [
            (RdpClosedReason::AuthFailed, "auth_failed"),
            (RdpClosedReason::CertRejected, "cert_rejected"),
            (RdpClosedReason::CertChanged, "cert_changed"),
            (RdpClosedReason::TlsError, "tls_error"),
            (RdpClosedReason::ProtocolError, "protocol_error"),
            (RdpClosedReason::NetworkError, "network_error"),
            (RdpClosedReason::Timeout, "timeout"),
            (RdpClosedReason::KilledByClose, "killed_by_close"),
            (RdpClosedReason::EngineExited, "engine_exited"),
            (RdpClosedReason::HelperShutdown, "helper_shutdown"),
            (RdpClosedReason::ServerDisconnected, "server_disconnected"),
        ];
        for (reason, literal) in cases {
            assert_eq!(reason.as_str(), literal);
        }
    }

    #[test]
    fn all_reasons_are_distinct() {
        let all = [
            RdpClosedReason::AuthFailed,
            RdpClosedReason::CertRejected,
            RdpClosedReason::CertChanged,
            RdpClosedReason::TlsError,
            RdpClosedReason::ProtocolError,
            RdpClosedReason::NetworkError,
            RdpClosedReason::Timeout,
            RdpClosedReason::KilledByClose,
            RdpClosedReason::EngineExited,
            RdpClosedReason::HelperShutdown,
            RdpClosedReason::ServerDisconnected,
        ];
        for i in 0..all.len() {
            for j in (i + 1)..all.len() {
                assert_ne!(all[i].as_str(), all[j].as_str());
            }
        }
    }
}
