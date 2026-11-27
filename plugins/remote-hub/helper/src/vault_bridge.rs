//! Private path from the short-lived credential child to the BB vault adapter.
use crate::keychain::KeychainError;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

const SOCKET: &str = "REMOTE_HUB_VAULT_SOCKET";
const TOKEN: &str = "REMOTE_HUB_VAULT_TOKEN";
const MAX_FRAME: u64 = 1_048_576;
static ENDPOINT: OnceLock<Client> = OnceLock::new();

pub(crate) struct Client {
    path: PathBuf,
    token: String,
}

#[derive(Serialize)]
struct Request<'a> {
    op: &'a str,
    #[serde(rename = "ref")]
    reference: &'a str,
    token: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<&'a str>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, untagged)]
enum Reply {
    Read { value: Option<String> },
    Write { stored: bool },
}

impl Client {
    pub(crate) fn from_env() -> Result<Option<Self>, KeychainError> {
        match (std::env::var_os(SOCKET), std::env::var(TOKEN)) {
            (None, Err(std::env::VarError::NotPresent)) => Ok(None),
            (Some(path), Ok(token))
                if token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()) =>
            {
                let path = PathBuf::from(path);
                if !path.is_absolute() {
                    return Err(KeychainError::VaultUnavailable);
                }
                Ok(Some(Self { path, token }))
            }
            _ => Err(KeychainError::VaultUnavailable),
        }
    }

    fn call(&self, op: &str, reference: &str, value: Option<&str>) -> Result<Reply, KeychainError> {
        let failed = |_| KeychainError::VaultUnavailable;
        let mut socket = UnixStream::connect(&self.path).map_err(failed)?;
        let request = Request { op, reference, token: &self.token, value };
        let body = serde_json::to_vec(&request).map_err(|_| KeychainError::VaultUnavailable)?;
        socket.write_all(&body).map_err(failed)?;
        socket.shutdown(std::net::Shutdown::Write).map_err(failed)?;
        let mut reply = Vec::new();
        socket.take(MAX_FRAME + 1).read_to_end(&mut reply).map_err(failed)?;
        if reply.len() as u64 > MAX_FRAME {
            return Err(KeychainError::VaultUnavailable);
        }
        // Untagged structs would otherwise accept an error as an empty optional
        // `value`. Require that field to be present even when the value is null.
        let parsed: serde_json::Value = serde_json::from_slice(&reply).map_err(|_| KeychainError::VaultUnavailable)?;
        if parsed.get("error").is_some() || (op == "get" && parsed.get("value").is_none()) {
            return Err(KeychainError::VaultUnavailable);
        }
        serde_json::from_value(parsed).map_err(|_| KeychainError::VaultUnavailable)
    }

    pub(crate) fn get(&self, reference: &str) -> Result<Option<String>, KeychainError> {
        match self.call("get", reference, None)? {
            Reply::Read { value } => Ok(value),
            _ => Err(KeychainError::VaultUnavailable),
        }
    }

    pub(crate) fn write(&self, op: &str, reference: &str, value: &str) -> Result<bool, KeychainError> {
        // The write result has a different shape from the read reply.
        match self.call(op, reference, Some(value))? {
            Reply::Write { stored } => Ok(stored),
            _ => Err(KeychainError::VaultUnavailable),
        }
    }
}

/// Called before the helper spawns any engine or shell. Only the credential
/// child inherits these two values.
pub fn configure() -> Result<(), KeychainError> {
    let endpoint = Client::from_env()?;
    std::env::remove_var(SOCKET);
    std::env::remove_var(TOKEN);
    if let Some(endpoint) = endpoint {
        ENDPOINT.set(endpoint).map_err(|_| KeychainError::VaultUnavailable)?;
    }
    Ok(())
}

pub(crate) fn configure_child(command: &mut Command) {
    if let Some(endpoint) = ENDPOINT.get() {
        command.env(SOCKET, &endpoint.path).env(TOKEN, &endpoint.token);
    }
}
