//! gitwand-bridge: GitWand's Tauri commands without a window, driven over
//! stdio by the Makosh GitWand plugin for BB.
//!
//! Copied into `apps/desktop/src-tauri/src/bridge/` by the plugin's
//! `build-runtime` script; `dispatch.rs` next to it is generated from the
//! `generate_handler!` list in `lib.rs`.
//!
//! Protocol: one JSON object per line.
//!   in   {"id":1,"cmd":"git_status","args":{...},"conn":"c1"}   (`conn` optional)
//!   out  {"id":1,"ok":...} | {"id":1,"error":...}
//!   out  {"channel":7,"message":...}                            (Channel output)
//! Service commands: `__hello` (version, commit, protocol, command counts) and
//! `__close_conn` {conn} (stops that connection's watchers and terminals).
//! The process ends when stdin closes, after closing every terminal and watcher.
mod adapters;
mod dispatch;

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::sync::{Mutex, OnceLock};

/// Version of the line protocol above.
pub(crate) const PROTOCOL: u32 = 1;
/// Connection label used when a request carries no `conn`.
pub(crate) const DEFAULT_CONN: &str = "bridge";

static OUT: Mutex<()> = Mutex::new(());

/// Writes one line to stdout; lines from concurrent tasks never interleave.
pub(crate) fn emit_line(v: Value) {
    let _guard = OUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", v);
    let _ = out.flush();
}

/// What each connection opened, so it can be closed with the connection.
#[derive(Default)]
pub(crate) struct Connections {
    pub(crate) labels: HashSet<String>,
    pub(crate) terminals: HashMap<String, Vec<u64>>,
}

pub(crate) fn connections() -> std::sync::MutexGuard<'static, Connections> {
    static C: OnceLock<Mutex<Connections>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Connections::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

async fn close_conn(conn: &str) -> Result<Value, Value> {
    crate::commands::watcher::stop_all_for_webview(conn);
    let ids = {
        let mut c = connections();
        c.labels.remove(conn);
        c.terminals.remove(conn).unwrap_or_default()
    };
    for id in &ids {
        let _ = crate::commands::terminal::terminal_close(*id).await;
    }
    Ok(json!({ "terminalsClosed": ids.len() }))
}

fn hello() -> Value {
    json!({
        "protocol": PROTOCOL,
        "version": env!("CARGO_PKG_VERSION"),
        "commit": option_env!("GITWAND_COMMIT").unwrap_or("unknown"),
        "runtime": option_env!("GITWAND_RUNTIME_VERSION").unwrap_or("dev"),
        "generated": dispatch::GENERATED.len(),
        "adapted": adapters::ADAPTED,
    })
}

async fn handle(cmd: &str, args: Value, conn: String) -> Result<Value, Value> {
    match cmd {
        "__hello" => Ok(hello()),
        "__close_conn" => {
            let target = args.get("conn").and_then(Value::as_str).unwrap_or(DEFAULT_CONN).to_string();
            close_conn(&target).await
        }
        _ => {
            if let Some(r) = adapters::dispatch(cmd, &args, &conn).await {
                return r;
            }
            match dispatch::dispatch(cmd, args).await {
                Some(r) => r,
                None => Err(Value::String(format!("unknown command: {cmd}"))),
            }
        }
    }
}

/// Runs the stdio loop until stdin closes.
pub fn run() {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                emit_line(json!({ "id": null, "error": format!("invalid request line: {e}") }));
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let cmd = req.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
        let args = req.get("args").cloned().unwrap_or_else(|| json!({}));
        let conn = req.get("conn").and_then(Value::as_str).unwrap_or(DEFAULT_CONN).to_string();
        // A panicking command must still answer, or the caller waits forever.
        let task = tauri::async_runtime::spawn(async move { handle(&cmd, args, conn).await });
        tauri::async_runtime::spawn(async move {
            let line = match task.await {
                Ok(Ok(v)) => json!({ "id": id, "ok": v }),
                Ok(Err(e)) => json!({ "id": id, "error": e }),
                Err(e) => json!({ "id": id, "error": format!("command panicked: {e}") }),
            };
            emit_line(line);
        });
    }
    crate::commands::terminal::terminal_close_all();
    let labels: Vec<String> = connections().labels.drain().collect();
    for label in labels {
        crate::commands::watcher::stop_all_for_webview(&label);
    }
    crate::commands::watcher::stop_all_for_webview(DEFAULT_CONN);
}

/// Number of generated command arms (for `--version` output).
pub fn generated_count() -> usize {
    dispatch::GENERATED.len()
}
