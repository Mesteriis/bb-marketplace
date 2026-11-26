// Generates gitwand-bridge's `dispatch.rs` from GitWand's own sources: the
// `tauri::generate_handler![…]` list in `lib.rs` and the signatures of the
// `#[tauri::command]` functions it names.
//
// Each command becomes one match arm that reads its arguments by Tauri's
// camelCase key and calls the function; Rust infers every argument type from
// the call, so no upstream type is named here. Commands with a host-only
// parameter (Channel, Webview, Window, AppHandle, State) need a hand-written
// adapter in bridge-src; anything unexpected stops the build instead of
// leaving a command out.

export interface SourceFile {
  /** Path relative to `src-tauri/src`, `/`-separated, e.g. `commands/ops.rs`. */
  path: string;
  text: string;
}

export interface CommandParam {
  name: string;
  type: string;
}

export interface CommandSig {
  name: string;
  isAsync: boolean;
  returnsResult: boolean;
  params: CommandParam[];
}

/** Commands with a hand-written adapter in bridge-src/src/bridge/adapters.rs. */
export const ADAPTED = ["terminal_open", "worktree_run_hook", "git_fetch", "git_clone", "watch_repo_start"];

const HOST_ONLY = /\b(AppHandle|Window|Webview|WebviewWindow|Channel|State)\s*(<|$)/;

/** The command paths listed in `generate_handler![…]`, comments removed. */
export function parseHandlerList(libRs: string): string[] {
  const match = /generate_handler!\s*\[([\s\S]*?)\]/.exec(libRs);
  if (!match) throw new Error("lib.rs: no tauri::generate_handler![…] list found");
  return stripComments(match[1])
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Tauri's default argument key: lowerCamelCase of the Rust parameter name. */
export function camelKey(name: string): string {
  const [head, ...rest] = name.split("_").filter((part) => part !== "");
  return (head ?? "") + rest.map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function modulePath(path: string): string {
  const parts = path.replace(/\.rs$/, "").split("/");
  const last = parts.at(-1);
  if (last === "mod" || last === "lib" || last === "main") parts.pop();
  return parts.join("::");
}

/** Splits at commas that are not inside <>, (), [] or {}. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("<([{".includes(ch)) depth++;
    if (">)]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

function parseParam(raw: string, where: string): CommandParam {
  const text = raw.replace(/#\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  const colon = text.indexOf(":");
  if (colon < 0) throw new Error(`${where}: cannot read parameter "${text}"`);
  const name = text.slice(0, colon).trim().replace(/^mut\s+/, "");
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`${where}: unsupported parameter pattern "${name}"`);
  return { name, type: text.slice(colon + 1).trim() };
}

/** Every `#[tauri::command]` function, keyed by `module::path::name`. */
export function indexCommands(files: SourceFile[]): Map<string, CommandSig> {
  const index = new Map<string, CommandSig>();
  for (const file of files) {
    const mod = modulePath(file.path);
    // Only an attribute that starts its own line: mentions in comments are not commands.
    const attribute = /^[ \t]*#\[tauri::command(\s*\(([^\]]*)\))?\s*\]/gm;
    for (let m = attribute.exec(file.text); m !== null; m = attribute.exec(file.text)) {
      if (m[1] !== undefined) throw new Error(`${file.path}: unsupported #[tauri::command${m[1]}] (only the bare attribute is handled)`);
      const rest = file.text.slice(m.index + m[0].length);
      const fn = /^\s*(?:\/\/[^\n]*\n\s*|#\[[^\]]*\]\s*)*(?:pub(?:\([a-z]+\))?\s+)?(async\s+)?fn\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/.exec(rest);
      if (fn === null) throw new Error(`${file.path}: #[tauri::command] not followed by a function`);
      let i = fn.index + fn[0].length;
      let depth = 1;
      const start = i;
      while (depth > 0 && i < rest.length) {
        if (rest[i] === "(") depth++;
        if (rest[i] === ")") depth--;
        i++;
      }
      const name = fn[2];
      const where = `${file.path}: ${name}`;
      const params = splitTopLevel(stripComments(rest.slice(start, i - 1))).map((p) => parseParam(p, where));
      const ret = /^\s*(?:->\s*([^{]+?))?\s*(?:where\b[^{]*)?\{/.exec(rest.slice(i));
      const returnType = ret?.[1]?.trim() ?? "()";
      index.set(mod === "" ? name : `${mod}::${name}`, {
        name,
        isAsync: fn[1] !== undefined,
        returnsResult: /^(?:[a-z_]+::)*Result\s*</.test(returnType),
        params,
      });
    }
  }
  return index;
}

const PREAMBLE = `// @generated by plugins/gitwand/scripts/gen-bridge-dispatch.ts — do not edit.
#![allow(clippy::all)]
use serde_json::Value;

fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, Value> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| Value::String(format!("invalid args \`{key}\`: {e}")))
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, Value> {
    serde_json::to_value(v).map_err(|e| Value::String(e.to_string()))
}

fn err_value<E: serde::Serialize>(e: E) -> Value {
    serde_json::to_value(e).unwrap_or_else(|e| Value::String(e.to_string()))
}
`;

/** The `dispatch.rs` source and the names of the generated commands. */
export function generateDispatch(
  handlers: string[],
  index: Map<string, CommandSig>,
  adapted: string[],
): { code: string; generated: string[] } {
  const names = new Set(handlers.map((h) => h.split("::").at(-1)));
  for (const name of adapted) {
    if (!names.has(name)) throw new Error(`${name}: has an adapter but is not in generate_handler! any more`);
  }
  const arms: string[] = [];
  const generated: string[] = [];
  for (const path of handlers) {
    const sig = index.get(path);
    if (sig === undefined) throw new Error(`${path}: registered in generate_handler! but its definition not found`);
    const host = sig.params.filter((p) => HOST_ONLY.test(p.type));
    const isAdapted = adapted.includes(sig.name);
    if (host.length > 0 && !isAdapted) {
      throw new Error(`${sig.name}: needs a hand-written adapter (${host.map((p) => `${p.name}: ${p.type}`).join(", ")})`);
    }
    if (host.length === 0 && isAdapted) throw new Error(`${sig.name}: has an adapter but takes no host-only parameter`);
    if (isAdapted) continue;
    const call = `crate::${path}(${sig.params.map((p) => `arg(&args, "${camelKey(p.name)}")?`).join(", ")})${sig.isAsync ? ".await" : ""}`;
    const body = sig.returnsResult ? `${call}.map_err(err_value).and_then(to_value)` : `to_value(${call})`;
    arms.push(`        "${sig.name}" => ${body},`);
    generated.push(sig.name);
  }
  const code = `${PREAMBLE}
pub const GENERATED: &[&str] = &[${generated.map((n) => JSON.stringify(n)).join(", ")}];

/// \`None\` when \`cmd\` is not a generated command.
pub async fn dispatch(cmd: &str, args: Value) -> Option<Result<Value, Value>> {
    if !GENERATED.contains(&cmd) {
        return None;
    }
    Some(run(cmd, args).await)
}

async fn run(cmd: &str, args: Value) -> Result<Value, Value> {
    match cmd {
${arms.join("\n")}
        _ => unreachable!("not a generated command: {cmd}"),
    }
}
`;
  return { code, generated };
}
