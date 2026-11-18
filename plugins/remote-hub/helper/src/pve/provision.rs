//! Onboarding mode 1: reconcile the restricted `RemoteHubConsole` role, the `remotehub@pve` user and one ACL entry
//! (docs/pve-consoles.md §3). Idempotent: every object is read first and only what differs is written, and a
//! dry run writes nothing. The admin's own credentials are the engine's `auth` and are used for this one job.
use super::api::{valid_acl_path, ApiError, Client, Session};
use super::protocol::{ACTION_CREATE, ACTION_KEEP, ACTION_ROTATE, ACTION_UPDATE, PROVISION_PRIVS, PROVISION_ROLE, PROVISION_USER};
use crate::secret::Secret;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub role: &'static str,
    pub user: &'static str,
    pub acl: &'static str,
}

/// What differs between the wanted state and what PVE has.
pub fn plan_from(roles: &[(String, String)], users: &[String], acl: &[(String, String, String, String)], acl_path: &str) -> Plan {
    let role = match roles.iter().find(|(id, _)| id == PROVISION_ROLE) {
        None => ACTION_CREATE,
        Some((_, privs)) if privs == PROVISION_PRIVS => ACTION_KEEP,
        Some(_) => ACTION_UPDATE,
    };
    let user = if users.iter().any(|u| u == PROVISION_USER) { ACTION_ROTATE } else { ACTION_CREATE };
    let acl = if acl.iter().any(|(path, kind, ugid, roleid)| path == acl_path && kind == "user" && ugid == PROVISION_USER && roleid == PROVISION_ROLE) {
        ACTION_KEEP
    } else {
        ACTION_CREATE
    };
    Plan { role, user, acl }
}

/// A password for the created user: 32 characters from a 62-character alphabet, from the operating system's random
/// source, by rejection sampling (no modulo bias). PVE accepts 8..=64 characters.
pub fn generate_password() -> Result<Secret, ApiError> {
    const ALPHABET: &[u8; 62] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::with_capacity(32);
    while out.len() < 32 {
        let mut buf = [0u8; 64];
        getrandom::fill(&mut buf).map_err(|_| ApiError::Protocol("the system random source failed".to_string()))?;
        for b in buf {
            // 248 = 4 * 62: bytes at or above it would favour the first letters.
            if b < 248 && out.len() < 32 {
                out.push(ALPHABET[(b % 62) as usize] as char);
            }
        }
    }
    Ok(Secret::new(out))
}

pub async fn read_plan(client: &Client, session: &Session, acl_path: &str) -> Result<Plan, ApiError> {
    if !valid_acl_path(acl_path) {
        return Err(ApiError::Invalid("the ACL path must be / or /pool/<id>"));
    }
    let roles = client.roles(session).await?;
    let users = client.users(session).await?;
    let acl = client.acl(session).await?;
    Ok(plan_from(&roles, &users, &acl, acl_path))
}

/// Apply `plan`; returns the new password of the user.
pub async fn apply(client: &Client, session: &Session, plan: &Plan, acl_path: &str) -> Result<Secret, ApiError> {
    let password = generate_password()?;
    match plan.role {
        ACTION_CREATE => {
            client.post(session, "/api2/json/access/roles", &[("roleid", PROVISION_ROLE), ("privs", PROVISION_PRIVS)]).await?;
        }
        ACTION_UPDATE => {
            let path = format!("/api2/json/access/roles/{PROVISION_ROLE}");
            client.put(session, &path, &[("privs", PROVISION_PRIVS), ("append", "0")]).await?;
        }
        _ => {}
    }
    match plan.user {
        ACTION_CREATE => {
            client
                .post(session, "/api2/json/access/users", &[("userid", PROVISION_USER), ("password", password.expose()), ("comment", "Remote Hub (managed)")])
                .await?;
        }
        _ => {
            client.put(session, "/api2/json/access/password", &[("userid", PROVISION_USER), ("password", password.expose())]).await?;
        }
    }
    if plan.acl == ACTION_CREATE {
        client
            .put(session, "/api2/json/access/acl", &[("path", acl_path), ("roles", PROVISION_ROLE), ("users", PROVISION_USER), ("propagate", "1")])
            .await?;
    }
    Ok(password)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acl(path: &str) -> (String, String, String, String) {
        (path.into(), "user".into(), PROVISION_USER.into(), PROVISION_ROLE.into())
    }

    #[test]
    fn an_empty_pve_needs_everything_created() {
        let p = plan_from(&[], &[], &[], "/");
        assert_eq!((p.role, p.user, p.acl), ("create", "create", "create"));
    }

    #[test]
    fn a_finished_setup_keeps_the_role_and_acl_and_only_rotates_the_password() {
        let roles = vec![(PROVISION_ROLE.to_string(), PROVISION_PRIVS.to_string())];
        let p = plan_from(&roles, &[PROVISION_USER.to_string()], &[acl("/")], "/");
        assert_eq!((p.role, p.user, p.acl), ("keep", "rotate_password", "keep"));
    }

    #[test]
    fn a_role_with_other_privileges_is_updated_and_an_acl_on_another_path_is_created() {
        let roles = vec![(PROVISION_ROLE.to_string(), "VM.Audit".to_string())];
        let p = plan_from(&roles, &[PROVISION_USER.to_string()], &[acl("/pool/a")], "/");
        assert_eq!((p.role, p.acl), ("update", "create"));
    }

    #[test]
    fn a_group_or_other_role_entry_does_not_count_as_ours() {
        let mut e = acl("/");
        e.1 = "group".into();
        assert_eq!(plan_from(&[], &[], &[e], "/").acl, "create");
        let mut e = acl("/");
        e.3 = "PVEAdmin".into();
        assert_eq!(plan_from(&[], &[], &[e], "/").acl, "create");
    }

    #[test]
    fn passwords_are_32_alphanumerics_and_differ() {
        let a = generate_password().unwrap();
        let b = generate_password().unwrap();
        assert_eq!(a.expose().len(), 32);
        assert!(a.expose().bytes().all(|c| c.is_ascii_alphanumeric()));
        assert_ne!(a.expose(), b.expose());
    }
}
