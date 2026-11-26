import { describe, expect, it } from "vitest";
import { ADAPTED, camelKey, generateDispatch, indexCommands, parseHandlerList } from "./dispatch-gen.ts";

const LIB_RS = `
pub(crate) mod commands;

#[tauri::command]
async fn open_repo(path: String) -> Result<String, String> { Ok(path) }

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            // read side
            commands::read::git_status,
            commands::read::git_log, // trailing comment
            open_repo,
            commands::terminal::terminal_open,
        ])
        .run(tauri::generate_context!())
        .expect("error");
}
`;

const READ_RS = `
use crate::types::*;

/// Status.
#[tauri::command]
pub(crate) async fn git_status(cwd: String, pathspec: Option<Vec<String>>) -> Result<GitStatus, String> {
    todo!()
}

#[tauri::command]
pub(crate) fn git_log(
    cwd: String,
    #[allow(unused)] mut source_branch: Option<String>,
    pairs: Vec<(String, HashMap<String, u32>)>,
) -> Vec<GitLogEntry> {
    todo!()
}

fn helper(x: u8) -> u8 { x }
`;

const TERMINAL_RS = `
#[tauri::command]
pub(crate) fn terminal_open(
    cwd: String,
    on_output: Channel<TerminalEvent>,
) -> Result<u64, String> {
    todo!()
}
`;

const FILES = [
  { path: "lib.rs", text: LIB_RS },
  { path: "commands/mod.rs", text: "pub(crate) mod read;\npub(crate) mod terminal;\n" },
  { path: "commands/read.rs", text: READ_RS },
  { path: "commands/terminal.rs", text: TERMINAL_RS },
];

describe("parseHandlerList", () => {
  it("lists the paths in generate_handler!, without comments", () => {
    expect(parseHandlerList(LIB_RS)).toEqual([
      "commands::read::git_status",
      "commands::read::git_log",
      "open_repo",
      "commands::terminal::terminal_open",
    ]);
  });

  it("fails when lib.rs has no generate_handler! list", () => {
    expect(() => parseHandlerList("pub fn run() {}")).toThrow(/generate_handler!/);
  });
});

describe("camelKey", () => {
  it.each([
    ["cwd", "cwd"],
    ["source_branch", "sourceBranch"],
    ["on_output", "onOutput"],
    ["repo_id_2", "repoId2"],
  ])("maps %s to Tauri's argument key %s", (name, key) => {
    expect(camelKey(name)).toBe(key);
  });
});

describe("indexCommands", () => {
  const index = indexCommands(FILES);

  it("keys commands by module path and name, with lib.rs at the crate root", () => {
    expect([...index.keys()].sort()).toEqual(["commands::read::git_log", "commands::read::git_status", "commands::terminal::terminal_open", "open_repo"]);
  });

  it("reads parameters with nested generics, attributes and mut", () => {
    expect(index.get("commands::read::git_log")).toEqual({
      name: "git_log",
      isAsync: false,
      returnsResult: false,
      params: [
        { name: "cwd", type: "String" },
        { name: "source_branch", type: "Option<String>" },
        { name: "pairs", type: "Vec<(String, HashMap<String, u32>)>" },
      ],
    });
  });

  it("marks async commands that return Result", () => {
    expect(index.get("commands::read::git_status")).toMatchObject({ isAsync: true, returnsResult: true });
  });
});

describe("generateDispatch", () => {
  const index = indexCommands(FILES);
  const handlers = parseHandlerList(LIB_RS);

  it("generates an arm per command, args by camelCase key, types inferred from the call", () => {
    const { code, generated } = generateDispatch(handlers, index, ["terminal_open"]);
    expect(generated).toEqual(["git_status", "git_log", "open_repo"]);
    expect(code).toContain(
      '        "git_status" => crate::commands::read::git_status(arg(&args, "cwd")?, arg(&args, "pathspec")?).await.map_err(err_value).and_then(to_value),',
    );
    expect(code).toContain(
      '        "git_log" => to_value(crate::commands::read::git_log(arg(&args, "cwd")?, arg(&args, "sourceBranch")?, arg(&args, "pairs")?)),',
    );
    expect(code).toContain('        "open_repo" => crate::open_repo(arg(&args, "path")?).await.map_err(err_value).and_then(to_value),');
    expect(code).toContain('pub const GENERATED: &[&str] = &["git_status", "git_log", "open_repo"];');
    expect(code).not.toContain('"terminal_open" =>');
  });

  it("refuses a Channel command that has no adapter", () => {
    expect(() => generateDispatch(handlers, index, [])).toThrow(/terminal_open.*needs a hand-written adapter/);
  });

  it("refuses an adapter for a command that no longer needs one", () => {
    expect(() => generateDispatch(handlers, index, ["terminal_open", "git_log"])).toThrow(/git_log.*has an adapter but/);
  });

  it("refuses an adapter for a command that is no longer registered", () => {
    expect(() => generateDispatch(handlers, index, ["terminal_open", "gone_cmd"])).toThrow(/gone_cmd.*not in generate_handler!/);
  });

  it("refuses a registered command whose definition was not found", () => {
    expect(() => generateDispatch([...handlers, "commands::read::vanished"], index, ["terminal_open"])).toThrow(
      /commands::read::vanished.*definition not found/,
    );
  });

  it.each(["AppHandle", "tauri::Window", "tauri::Webview", "State<'_, Db>"])("treats a %s parameter as host-only", (type) => {
    const files = [
      { path: "lib.rs", text: "fn run() { tauri::generate_handler![host_cmd] }" },
      { path: "x.rs", text: `#[tauri::command]\nfn host_cmd(h: ${type}) {}` },
    ];
    const idx = indexCommands(files);
    expect(() => generateDispatch(["x::host_cmd"], idx, [])).toThrow(/needs a hand-written adapter/);
  });
});

describe("unsupported command attributes", () => {
  it("stops on #[tauri::command(rename_all = …)] instead of guessing argument keys", () => {
    const files = [{ path: "x.rs", text: '#[tauri::command(rename_all = "snake_case")]\nfn a(b_c: String) {}' }];
    expect(() => indexCommands(files)).toThrow(/unsupported #\[tauri::command\(rename_all/);
  });
});

describe("ADAPTED", () => {
  it("names the five commands bridge-src adapts, the same list as adapters.rs", async () => {
    const { readFileSync } = await import("node:fs");
    const rs = readFileSync(new URL("../../bridge-src/src/bridge/adapters.rs", import.meta.url), "utf8");
    const inRust = [...(/ADAPTED: &\[&str\] = &\[([^\]]*)\]/.exec(rs)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    const expected = ["terminal_open", "worktree_run_hook", "git_fetch", "git_clone", "watch_repo_start"];
    expect(ADAPTED).toEqual(expected);
    expect(inRust).toEqual(expected);
  });
});

describe("attributes mentioned in comments", () => {
  it("ignores `#[tauri::command]` inside // and //! comments", () => {
    const files = [
      {
        path: "x.rs",
        text: "//! wraps a `#[tauri::command]` body\n// Mirrors the `#[tauri::command]` wrapper below\n#[tauri::command]\npub(crate) fn real(a: u8) -> u8 { a }\n/// without a runtime; the #[tauri::command] is a thin wrapper.\nfn inner() {}\n",
      },
    ];
    expect([...indexCommands(files).keys()]).toEqual(["x::real"]);
  });
});
