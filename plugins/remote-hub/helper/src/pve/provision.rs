//! Onboarding mode 1: reconcile the restricted `RemoteHubConsole` role, one managed user and one ACL entry
//! (docs/pve-consoles.md §3). Nothing is assumed from a name: a user is ours only when it carries the marker comment, a role
//! only when its privileges are exactly ours. The plan is computed from the server's observed state and carries a digest of
//! it; an apply must present the digest of the plan the owner confirmed and is refused before its first write if the state
//! has moved (`plan_changed`). Each step of an apply reports its own outcome.
use sha2::{Digest, Sha256};
use std::sync::Mutex;

use super::api::{valid_acl_path, ApiError, Client, Session, UserInfo};
use super::protocol::{
    AclGrant, ProvisionSteps, UserExtras, ACTION_CREATE, ACTION_DIFFERS, ACTION_KEEP, ACTION_NAME_TAKEN, ACTION_ROTATE, PROVISION_COMMENT, PROVISION_PRIVS, PROVISION_ROLE, STEP_DONE, STEP_FAILED, STEP_KEPT,
    STEP_NOT_ATTEMPTED, STEP_UNKNOWN,
};
use crate::secret::Secret;

/// What the server holds, as read for one plan.
pub struct ServerState {
    pub roles: Vec<(String, String)>,
    pub users: Vec<UserInfo>,
    pub acl: Vec<(String, String, String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub role: &'static str,
    pub user: &'static str,
    pub acl: &'static str,
    pub user_id: String,
    pub role_privs: Option<String>,
    pub extras: UserExtras,
    pub digest: String,
}

/// `name@pve`: the realm is fixed (a Remote Hub user is never a PAM or LDAP account).
pub fn valid_user_id(user: &str) -> bool {
    let Some(name) = user.strip_suffix("@pve") else { return false };
    !name.is_empty() && name.len() <= 32 && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub async fn read_state(client: &Client, session: &Session) -> Result<ServerState, ApiError> {
    Ok(ServerState { roles: client.roles(session).await?, users: client.users(session).await?, acl: client.acl(session).await? })
}

/// The plan for `state`. `context` binds the digest to where and as whom it was made (endpoint, admin, certificate).
pub fn plan_from(state: &ServerState, user_id: &str, acl_path: &str, context: &str) -> Plan {
    let role_current = state.roles.iter().find(|(id, _)| id == PROVISION_ROLE).map(|(_, p)| p.clone());
    let role = match &role_current {
        None => ACTION_CREATE,
        Some(privs) if privs == PROVISION_PRIVS => ACTION_KEEP,
        Some(_) => ACTION_DIFFERS,
    };
    let user_row = state.users.iter().find(|u| u.userid == user_id);
    let user = match user_row {
        None => ACTION_CREATE,
        Some(u) if u.comment == PROVISION_COMMENT => ACTION_ROTATE,
        Some(_) => ACTION_NAME_TAKEN,
    };
    let acl_ours = state.acl.iter().any(|(path, kind, ugid, roleid)| path == acl_path && kind == "user" && ugid == user_id && roleid == PROVISION_ROLE);
    let acl = if acl_ours { ACTION_KEEP } else { ACTION_CREATE };
    // What the user already holds beyond our entry: shown, never removed.
    let mut extras = UserExtras::default();
    if let Some(u) = user_row {
        extras.groups = u.groups.clone();
        extras.tokens = u.tokens.clone();
        extras.acl = state
            .acl
            .iter()
            .filter(|(path, kind, ugid, roleid)| kind == "user" && ugid == user_id && !(path == acl_path && roleid == PROVISION_ROLE))
            .map(|(path, _, _, roleid)| AclGrant { path: path.clone(), role: roleid.clone() })
            .collect();
        extras.acl.sort_by(|a, b| (&a.path, &a.role).cmp(&(&b.path, &b.role)));
    }
    let digest = digest_of(state, user_id, acl_path, context);
    Plan { role, user, acl, user_id: user_id.to_string(), role_privs: role_current, extras, digest }
}

/// A digest of everything a plan depends on: the context, the role, the user (marker, groups, tokens) and the ACL entries
/// on the path or belonging to the user.
fn digest_of(state: &ServerState, user_id: &str, acl_path: &str, context: &str) -> String {
    let mut text = format!("rh-plan-v1\ncontext={context}\nuser={user_id}\nacl-path={acl_path}\n");
    match state.roles.iter().find(|(id, _)| id == PROVISION_ROLE) {
        Some((_, privs)) => text.push_str(&format!("role=present:{privs}\n")),
        None => text.push_str("role=absent\n"),
    }
    match state.users.iter().find(|u| u.userid == user_id) {
        Some(u) => text.push_str(&format!("user=present:{}:{}:{}\n", u.comment, u.groups.join(","), u.tokens.join(","))),
        None => text.push_str("user=absent\n"),
    }
    let mut entries: Vec<String> = state
        .acl
        .iter()
        .filter(|(path, kind, ugid, _)| path == acl_path || (kind == "user" && ugid == user_id))
        .map(|(path, kind, ugid, roleid)| format!("{path}|{kind}|{ugid}|{roleid}"))
        .collect();
    entries.sort();
    for e in entries {
        text.push_str(&format!("acl={e}\n"));
    }
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// A password for the user: 32 characters from a 62-character alphabet, from the operating system's random source, by
/// rejection sampling (no modulo bias). PVE accepts 8..=64 characters.
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

/// How far an apply got. A step in flight when the apply is cut off is `unknown`.
#[derive(Debug, Clone)]
pub struct Progress {
    pub steps: ProvisionSteps,
    inflight: Option<&'static str>,
}

impl Progress {
    pub fn new() -> Self {
        Progress { steps: ProvisionSteps::untouched(), inflight: None }
    }
    fn slot(&mut self, name: &str) -> &mut String {
        match name {
            "role" => &mut self.steps.role,
            "user" => &mut self.steps.user,
            _ => &mut self.steps.acl,
        }
    }
    pub fn begin(&mut self, name: &'static str) {
        self.inflight = Some(name);
    }
    pub fn finish(&mut self, name: &'static str, outcome: &str) {
        *self.slot(name) = outcome.to_string();
        self.inflight = None;
    }
    /// The step failed: a refusal is `failed`; a timeout or a broken connection after the write was sent is `unknown`.
    pub fn fail(&mut self, name: &'static str, error: &ApiError) {
        let outcome = if matches!(error, ApiError::Timeout | ApiError::Unreachable(_)) { STEP_UNKNOWN } else { STEP_FAILED };
        self.finish(name, outcome);
    }
    /// The whole apply was cut off: what was in flight may or may not have happened.
    pub fn cut_off(&mut self) -> ProvisionSteps {
        if let Some(name) = self.inflight.take() {
            *self.slot(name) = STEP_UNKNOWN.to_string();
        }
        self.steps.clone()
    }
}

impl Default for Progress {
    fn default() -> Self {
        Self::new()
    }
}

pub async fn step_role(client: &Client, session: &Session, plan: &Plan, replace: bool, progress: &Mutex<Progress>) -> Result<(), ApiError> {
    progress.lock().unwrap().begin("role");
    let result = match plan.role {
        ACTION_CREATE => client.post(session, "/api2/json/access/roles", &[("roleid", PROVISION_ROLE), ("privs", PROVISION_PRIVS)]).await.map(|_| STEP_DONE),
        ACTION_DIFFERS if replace => {
            let path = format!("/api2/json/access/roles/{PROVISION_ROLE}");
            client.put(session, &path, &[("privs", PROVISION_PRIVS), ("append", "0")]).await.map(|_| STEP_DONE)
        }
        _ => Ok(STEP_KEPT),
    };
    match result {
        Ok(outcome) => {
            progress.lock().unwrap().finish("role", outcome);
            Ok(())
        }
        Err(e) => {
            progress.lock().unwrap().fail("role", &e);
            Err(e)
        }
    }
}

/// Create the user (with the marker) or replace the password of the managed one. Returns the new password.
pub async fn step_user(client: &Client, session: &Session, plan: &Plan, progress: &Mutex<Progress>) -> Result<Secret, ApiError> {
    let password = generate_password()?;
    progress.lock().unwrap().begin("user");
    let result = if plan.user == ACTION_CREATE {
        client
            .post(session, "/api2/json/access/users", &[("userid", plan.user_id.as_str()), ("password", password.expose()), ("comment", PROVISION_COMMENT)])
            .await
    } else {
        client.put(session, "/api2/json/access/password", &[("userid", plan.user_id.as_str()), ("password", password.expose())]).await
    };
    match result {
        Ok(_) => {
            progress.lock().unwrap().finish("user", STEP_DONE);
            Ok(password)
        }
        Err(e) => {
            progress.lock().unwrap().fail("user", &e);
            Err(e)
        }
    }
}

pub async fn step_acl(client: &Client, session: &Session, plan: &Plan, acl_path: &str, progress: &Mutex<Progress>) -> Result<(), ApiError> {
    if plan.acl != ACTION_CREATE {
        progress.lock().unwrap().finish("acl", STEP_KEPT);
        return Ok(());
    }
    progress.lock().unwrap().begin("acl");
    match client
        .put(session, "/api2/json/access/acl", &[("path", acl_path), ("roles", PROVISION_ROLE), ("users", plan.user_id.as_str()), ("propagate", "1")])
        .await
    {
        Ok(_) => {
            progress.lock().unwrap().finish("acl", STEP_DONE);
            Ok(())
        }
        Err(e) => {
            progress.lock().unwrap().fail("acl", &e);
            Err(e)
        }
    }
}

pub fn acl_path_ok(path: &str) -> bool {
    valid_acl_path(path)
}

#[allow(dead_code)]
const _: &str = STEP_NOT_ATTEMPTED;

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str, comment: &str) -> UserInfo {
        UserInfo { userid: id.into(), comment: comment.into(), groups: vec![], tokens: vec![] }
    }
    fn state(roles: Vec<(&str, &str)>, users: Vec<UserInfo>, acl: Vec<(&str, &str, &str, &str)>) -> ServerState {
        ServerState {
            roles: roles.into_iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
            users,
            acl: acl.into_iter().map(|(a, b, c, d)| (a.to_string(), b.to_string(), c.to_string(), d.to_string())).collect(),
        }
    }
    const OURS: &str = "remotehub@pve";

    #[test]
    fn an_empty_pve_needs_everything_created() {
        let p = plan_from(&state(vec![], vec![], vec![]), OURS, "/", "ctx");
        assert_eq!((p.role, p.user, p.acl), ("create", "create", "create"));
        assert_eq!(p.extras, UserExtras::default());
    }

    #[test]
    fn a_managed_user_with_our_role_is_kept_and_only_its_password_is_rotated() {
        let s = state(vec![("RemoteHubConsole", PROVISION_PRIVS)], vec![user(OURS, PROVISION_COMMENT)], vec![("/", "user", OURS, "RemoteHubConsole")]);
        let p = plan_from(&s, OURS, "/", "ctx");
        assert_eq!((p.role, p.user, p.acl), ("keep", "rotate_password", "keep"));
    }

    #[test]
    fn a_user_without_the_marker_is_name_taken_even_if_it_looks_like_ours() {
        let s = state(vec![], vec![user(OURS, ""), ], vec![]);
        assert_eq!(plan_from(&s, OURS, "/", "c").user, "name_taken");
        let s = state(vec![], vec![user(OURS, "my own admin account")], vec![]);
        assert_eq!(plan_from(&s, OURS, "/", "c").user, "name_taken");
    }

    #[test]
    fn a_role_with_other_privileges_differs_and_is_never_silently_replaced() {
        let s = state(vec![("RemoteHubConsole", "VM.Audit")], vec![], vec![]);
        let p = plan_from(&s, OURS, "/", "c");
        assert_eq!(p.role, "differs");
        assert_eq!(p.role_privs.as_deref(), Some("VM.Audit"));
    }

    #[test]
    fn what_a_managed_user_already_holds_is_listed_not_removed() {
        let mut u = user(OURS, PROVISION_COMMENT);
        u.groups = vec!["admins".into()];
        u.tokens = vec!["ci".into()];
        let s = state(vec![], vec![u], vec![("/", "user", OURS, "PVEAdmin"), ("/vms/100", "user", OURS, "PVEVMUser"), ("/", "user", OURS, "RemoteHubConsole"), ("/", "user", "other@pve", "PVEAdmin")]);
        let p = plan_from(&s, OURS, "/", "c");
        assert_eq!(p.extras.groups, vec!["admins"]);
        assert_eq!(p.extras.tokens, vec!["ci"]);
        assert_eq!(p.extras.acl, vec![AclGrant { path: "/".into(), role: "PVEAdmin".into() }, AclGrant { path: "/vms/100".into(), role: "PVEVMUser".into() }]);
    }

    #[test]
    fn the_digest_changes_with_anything_the_plan_depends_on_and_with_the_context() {
        let base = state(vec![], vec![], vec![]);
        let d = plan_from(&base, OURS, "/", "ctx").digest;
        assert_eq!(d.len(), 64);
        assert_eq!(plan_from(&base, OURS, "/", "ctx").digest, d);
        assert_ne!(plan_from(&base, OURS, "/", "other").digest, d, "context (endpoint, admin, certificate)");
        assert_ne!(plan_from(&base, OURS, "/pool/a", "ctx").digest, d, "ACL path");
        assert_ne!(plan_from(&base, "other@pve", "/", "ctx").digest, d, "user id");
        assert_ne!(plan_from(&state(vec![("RemoteHubConsole", PROVISION_PRIVS)], vec![], vec![]), OURS, "/", "ctx").digest, d, "role appeared");
        assert_ne!(plan_from(&state(vec![], vec![user(OURS, "")], vec![]), OURS, "/", "ctx").digest, d, "user appeared");
        assert_ne!(plan_from(&state(vec![], vec![], vec![("/", "user", "x@pve", "R")]), OURS, "/", "ctx").digest, d, "an entry on the path");
        assert_ne!(
            plan_from(&state(vec![], vec![user(OURS, PROVISION_COMMENT)], vec![]), OURS, "/", "ctx").digest,
            plan_from(&state(vec![], vec![user(OURS, PROVISION_COMMENT)], vec![("/vms/1", "user", OURS, "PVEAdmin")]), OURS, "/", "ctx").digest,
            "a grant elsewhere"
        );
    }

    #[test]
    fn user_ids_are_name_at_pve_only() {
        assert!(valid_user_id("remotehub@pve"));
        assert!(valid_user_id("rh.lab-1_x@pve"));
        assert!(!valid_user_id("root@pam"));
        assert!(!valid_user_id("@pve"));
        assert!(!valid_user_id("a b@pve"));
        assert!(!valid_user_id("a@pve!tok"));
        assert!(!valid_user_id("remotehub"));
        assert!(!valid_user_id(&format!("{}@pve", "x".repeat(33))));
    }

    #[test]
    fn progress_marks_a_cut_off_write_unknown_and_a_refused_one_failed() {
        let mut p = Progress::new();
        p.begin("role");
        p.finish("role", STEP_DONE);
        p.begin("user");
        let steps = p.cut_off();
        assert_eq!((steps.role.as_str(), steps.user.as_str(), steps.acl.as_str()), ("done", "unknown", "not_attempted"));
        let mut p = Progress::new();
        p.begin("acl");
        p.fail("acl", &ApiError::NoPermission("x".into()));
        assert_eq!(p.steps.acl, "failed");
        p.begin("user");
        p.fail("user", &ApiError::Timeout);
        assert_eq!(p.steps.user, "unknown");
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
