//! Hand-written adapters for the commands the generator skips: they take a
//! `tauri::ipc::Channel` or a `tauri::Webview`. The generator refuses a
//! command with such a parameter unless its name is in `ADAPTED`, so a new
//! one upstream breaks the build instead of going missing.
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};

/// `?` for an argument inside a function that returns `Option<Result<..>>`.
macro_rules! try_arg {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return Some(Err(e)),
        }
    };
}

/// Commands handled here. Keep in sync with `scripts/gen-bridge-dispatch.ts`.
pub(crate) const ADAPTED: &[&str] = &["terminal_open", "worktree_run_hook", "git_fetch", "git_clone", "watch_repo_start"];

fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, Value> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| Value::String(format!("invalid args `{key}`: {e}")))
}

/// The page passes a channel as "__CHANNEL__:<id>" (Tauri's wire form); the
/// plugin relay owns the id space and maps it back to the page.
fn channel<T: serde::Serialize + Clone>(args: &Value, key: &str) -> Result<Channel<T>, Value> {
    let raw: String = arg(args, key)?;
    let id: u64 = raw
        .strip_prefix("__CHANNEL__:")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| Value::String(format!("invalid args `{key}`: not a channel")))?;
    Ok(Channel::new(move |body| {
        let message = match body {
            InvokeResponseBody::Json(s) => serde_json::from_str(&s).unwrap_or(Value::String(s)),
            InvokeResponseBody::Raw(bytes) => json!({ "raw": bytes }),
        };
        super::emit_line(json!({ "channel": id, "message": message }));
        Ok(())
    }))
}

fn out<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, Value> {
    r.map_err(Value::String)
        .and_then(|v| serde_json::to_value(v).map_err(|e| Value::String(e.to_string())))
}

fn own_terminal(conn: &str, r: &Result<u64, String>) {
    if let Ok(id) = r {
        super::connections().terminals.entry(conn.to_string()).or_default().push(*id);
    }
}

/// `Some` when `cmd` is one of `ADAPTED`; terminals and watchers are recorded
/// under `conn` so they close with it.
pub(crate) async fn dispatch(cmd: &str, a: &Value, conn: &str) -> Option<Result<Value, Value>> {
    use crate::commands::{ops, terminal, watcher, worktree};
    let r = match cmd {
        "terminal_open" => {
            let r = terminal::terminal_open(
                try_arg!(arg(a, "cwd")),
                try_arg!(arg(a, "shell")),
                try_arg!(arg(a, "agent")),
                try_arg!(arg(a, "cols")),
                try_arg!(arg(a, "rows")),
                try_arg!(channel(a, "onOutput")),
            );
            own_terminal(conn, &r);
            out(r)
        }
        "worktree_run_hook" => {
            let r = worktree::worktree_run_hook(
                try_arg!(arg(a, "cwd")),
                try_arg!(arg(a, "path")),
                try_arg!(arg(a, "hook")),
                try_arg!(arg(a, "hash")),
                try_arg!(arg(a, "cols")),
                try_arg!(arg(a, "rows")),
                try_arg!(channel(a, "onOutput")),
            );
            own_terminal(conn, &r);
            out(r)
        }
        "git_fetch" => out(ops::git_fetch(try_arg!(arg(a, "cwd")), try_arg!(channel(a, "onProgress"))).await),
        "git_clone" => out(
            ops::git_clone(try_arg!(arg(a, "url")), try_arg!(arg(a, "dest")), try_arg!(channel(a, "onProgress"))).await,
        ),
        "watch_repo_start" => {
            super::connections().labels.insert(conn.to_string());
            out(watcher::watch_repo_start_for_label(conn, try_arg!(arg(a, "cwd")), try_arg!(channel(a, "onChange"))))
        }
        _ => return None,
    };
    Some(r)
}
