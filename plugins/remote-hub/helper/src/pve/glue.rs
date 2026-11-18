//! The part of the helper's request loop that belongs to PVE: turning a wire request into the engine's `Open`
//! (resolving a saved secret in the helper, checking what it was saved for), and turning engine frames into wire
//! responses. Kept out of ipc.rs so that file does not take another unrelated duty.
use std::collections::VecDeque;

use super::manager::{ClosedReport, EnqueueError, Kind, PveFrame, PveManager};
use super::protocol::{ConsoleTarget, Endpoint, PveAuth, PveCommand, PveOp, PROVISION_USER};
use crate::ipc::{keychain_child, keychain_ok, resolve_item, CredentialRefusal};
use crate::protocol::{self, PveConnect, PveSave, Response};
use crate::secret::Secret;

fn error(id: u64, code: &str, message: impl Into<String>) -> Vec<u8> {
    protocol::encode_response(&Response::Error { id: Some(id), code: code.to_string(), message: message.into() })
}

/// The secret and who it is for. A saved secret is handed over only when it was saved for exactly this endpoint.
fn resolve_auth(current_exe: &str, c: &PveConnect) -> Result<PveAuth, CredentialRefusal> {
    let secret: Secret = match (&c.password, &c.credential_ref) {
        (Some(p), None) => p.clone(),
        (None, Some(reference)) => {
            let item = resolve_item(current_exe, reference)?;
            if !item.bind.is_pve_endpoint(&c.host, c.port, &c.user) {
                return Err(CredentialRefusal::Mismatch);
            }
            item.secret
        }
        _ => return Err(CredentialRefusal::BadRef),
    };
    Ok(match c.auth_mode.as_str() {
        "token" => PveAuth::Token { token_id: c.user.clone(), secret },
        _ => PveAuth::Ticket { username: c.user.clone(), password: secret },
    })
}

fn build_open(current_exe: &str, id: u64, c: &PveConnect, op: PveOp, keepalive: Option<u64>) -> Result<PveCommand, Vec<u8>> {
    if c.auth_mode != "ticket" && c.auth_mode != "token" {
        return Err(error(id, "invalid_request", "authMode must be ticket or token"));
    }
    if c.password.is_some() == c.credential_ref.is_some() {
        return Err(error(id, "invalid_credential_source", "give exactly one of password and credentialRef"));
    }
    let auth = resolve_auth(current_exe, c).map_err(|r| protocol::encode_response(&r.into_response(id)))?;
    Ok(PveCommand::Open { endpoint: Endpoint { host: c.host.clone(), port: c.port }, auth, trust: c.trust.clone(), op, keepalive_secs: keepalive })
}

pub fn open_terminal(
    pve: &mut PveManager,
    current_exe: &str,
    id: u64,
    c: &PveConnect,
    target: ConsoleTarget,
    cols: u16,
    rows: u16,
    keepalive: Option<u64>,
) -> Vec<u8> {
    if !(1..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return error(id, "invalid_request", "the terminal size must be 1..=1000 columns and rows");
    }
    let open = match build_open(current_exe, id, c, PveOp::Terminal { target, cols, rows }, keepalive) {
        Ok(o) => o,
        Err(frames) => return frames,
    };
    match pve.open_terminal(current_exe, &open) {
        Ok((session_id, pid)) => protocol::encode_response(&Response::SessionOpened { id, session_id, cols, rows, pid: pid as u32, kind: "pve".to_string() }),
        Err(message) => error(id, "pve_open_failed", message),
    }
}

pub fn open_targets(pve: &mut PveManager, current_exe: &str, id: u64, c: &PveConnect) -> Vec<u8> {
    let open = match build_open(current_exe, id, c, PveOp::Targets, None) {
        Ok(o) => o,
        Err(frames) => return frames,
    };
    match pve.open_targets(current_exe, &open, id) {
        // The answer is sent when the engine has one (see `relay_frames`).
        Ok(_) => Vec::new(),
        Err(message) => error(id, "pve_open_failed", message),
    }
}

/// Onboarding mode 1. The admin's login is a use-once password (never a saved credential); an apply must say where the
/// created user's password is saved, and that place must be a `pve` binding for this very endpoint and the created user,
/// so the new password cannot be directed anywhere else.
pub fn open_provision(pve: &mut PveManager, current_exe: &str, id: u64, c: &PveConnect, dry_run: bool, acl_path: String, save: Option<PveSave>) -> Vec<u8> {
    if c.credential_ref.is_some() || c.password.is_none() {
        return error(id, "invalid_credential_source", "provisioning signs in with a password that is used once");
    }
    if !super::api::valid_acl_path(&acl_path) {
        return error(id, "invalid_request", "the ACL path must be / or /pool/<id>");
    }
    let target = match (dry_run, save) {
        (true, _) => None,
        (false, None) => return error(id, "invalid_request", "an apply needs a place to save the new password"),
        (false, Some(save)) => {
            let bind = save.bind.canonical();
            if !crate::keychain::valid_credential_ref(&save.reference) || !bind.is_valid() || !bind.is_pve_endpoint(&c.host, c.port, PROVISION_USER) {
                return error(id, "invalid_request", "the password may only be saved for this endpoint and the user remotehub@pve");
            }
            Some((save.reference, bind))
        }
    };
    let open = match build_open(current_exe, id, c, PveOp::Provision { dry_run, acl_path }, None) {
        Ok(o) => o,
        Err(frames) => return frames,
    };
    match pve.open_provision(current_exe, &open, id, target) {
        Ok(_) => Vec::new(),
        Err(message) => error(id, "pve_open_failed", message),
    }
}

pub fn enqueue_error(id: u64, session_id: u32, e: EnqueueError) -> Vec<u8> {
    match e {
        EnqueueError::UnknownSession => error(id, "session_not_found", format!("no pve session {session_id}")),
        EnqueueError::Dead => error(id, "session_closed", "the pve console has ended"),
        EnqueueError::Overflow => error(id, "input_overflow", "too much pending input for this session; retry"),
    }
}

/// Wire frames for what the engine said. Console bytes become stream frames; a discovery answer or failure answers
/// the request that asked.
pub fn relay_frames(pve: &mut PveManager, outbox: &mut VecDeque<u8>, current_exe: &str, session_id: u32, frames: Vec<PveFrame>) {
    for frame in frames {
        match frame {
            PveFrame::State(state) => {
                if pve.job_request(session_id).is_none() {
                    outbox.extend(protocol::encode_response(&Response::PveState { session_id, state }));
                }
            }
            PveFrame::Data { seq, bytes } => outbox.extend(protocol::encode_stream(session_id, seq, &bytes)),
            PveFrame::Targets { version, nodes, guests } => {
                if let Some(id) = pve.job_request(session_id) {
                    outbox.extend(protocol::encode_response(&Response::PveTargetsResult { id, version, nodes, guests }));
                    pve.mark_job_answered(session_id);
                }
            }
            PveFrame::Plan { role, user, acl } => {
                if let Some(id) = pve.job_request(session_id) {
                    outbox.extend(protocol::encode_response(&Response::PvePlan { id, role, user, acl }));
                    pve.mark_job_answered(session_id);
                }
            }
            PveFrame::Provisioned { role, user, acl, password } => {
                let Some(id) = pve.job_request(session_id) else { continue };
                pve.mark_job_answered(session_id);
                // The new password goes to the Keychain here and nowhere else; the client is told what happened, never the secret.
                let saved = match (password, pve.take_job_save(session_id)) {
                    (Some(secret), Some((reference, bind))) => {
                        keychain_child(current_exe, "save", &reference, Some(&secret), Some(&bind)).and_then(keychain_ok).map(|_| ()).map_err(|r| r.code())
                    }
                    _ => Err("credential_unavailable".to_string()),
                };
                outbox.extend(protocol::encode_response(&match saved {
                    Ok(()) => Response::PveProvisioned { id, role, user, acl },
                    Err(code) => Response::PveFailed {
                        id,
                        code,
                        message: "the user was set up on the server but its new password could not be saved; run the setup again to replace it".to_string(),
                        fingerprint: None,
                    },
                }));
            }
            PveFrame::Error { code, message, fingerprint } => match pve.job_request(session_id) {
                Some(id) => {
                    outbox.extend(protocol::encode_response(&Response::PveFailed { id, code, message, fingerprint }));
                    pve.mark_job_answered(session_id);
                }
                None => outbox.extend(protocol::encode_response(&Response::PveError { session_id, code, message, fingerprint })),
            },
        }
    }
}

/// What an ended engine owes the wire: a failure for a discovery request it never answered, and `session.closed`
/// for a console.
pub fn closed_frames(report: &ClosedReport) -> Vec<u8> {
    match report.kind {
        Kind::Targets | Kind::Provision => match report.unanswered_job {
            Some(id) => protocol::encode_response(&Response::PveFailed {
                id,
                code: "engine_exited".to_string(),
                message: "the PVE engine ended without an answer".to_string(),
                fingerprint: None,
            }),
            None => Vec::new(),
        },
        Kind::Terminal => protocol::encode_response(&Response::SessionClosed {
            id: report.close_request,
            session_id: report.session_id,
            exit_code: report.exit.code,
            signal: report.exit.signal,
            reason: report.reason.clone(),
        }),
    }
}
