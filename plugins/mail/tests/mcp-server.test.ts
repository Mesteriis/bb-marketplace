// The MCP server file, run as a real child process against a fake `bb`.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCP_SERVER_FILE_NAME, MCP_SERVER_SOURCE } from "../src/core/mcp-server-source.ts";

const SERVER = fileURLToPath(new URL("../mcp/makosh-mail-mcp.mjs", import.meta.url));
let dir: string;
let fakeBb: string;
let argvLog: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "makosh-mcp-"));
  argvLog = join(dir, "argv.jsonl");
  fakeBb = join(dir, "fake-bb.mjs");
  // Records its arguments; answers by the command, fails for a message id "missing".
  writeFileSync(
    fakeBb,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n");
if (argv[1] === "read" && argv[2] === "missing") { process.stderr.write("unknown message 'missing'\\n"); process.exit(1); }
if (argv[1] === "read" && argv[2] === "slow") { setTimeout(() => {}, 60000); }
else process.stdout.write(JSON.stringify({ ran: argv[1] }) + "\\n");
`,
  );
  chmodSync(fakeBb, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Sends the lines to a fresh server and returns every line it answered. */
function talk(lines: (object | string)[], bb = fakeBb): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, MAKOSH_MAIL_BB: bb }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.on("error", reject);
    child.on("close", () => resolve(out.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>)));
    for (const line of lines) child.stdin.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
    child.stdin.end();
  });
}
const call = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const ranArgv = () => readFileSync(argvLog, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as string[]);

describe("makosh-mail-mcp.mjs", () => {
  it("the text the settings page saves is the file", () => {
    expect(MCP_SERVER_SOURCE).toBe(readFileSync(SERVER, "utf8"));
    expect(MCP_SERVER_FILE_NAME).toBe("makosh-mail-mcp.mjs");
  });

  it("speaks MCP: initialize, no answer to a notification, ping, the three read-only tools", async () => {
    const answers = await talk([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
    ]);
    expect(answers.map((answer) => answer.id)).toEqual([1, 2, 3]);
    expect(answers[0]!.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "makosh-mail" } });
    expect(answers[1]!.result).toEqual({});
    const tools = (answers[2]!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["mail_accounts", "mail_search", "mail_read"]);
  });

  it("runs bb with an argument array in assistant mode; a query cannot become an option or a shell command", async () => {
    writeFileSync(argvLog, "");
    const answers = await talk([
      call(1, "mail_accounts", {}),
      call(2, "mail_search", { query: "-in:inbox; rm -rf ~ $(whoami) --json", account: "acc_1", limit: 99 }),
      call(3, "mail_read", { messageId: "m_1" }),
    ]);
    expect(answers.map((answer) => (answer.result as { content: { text: string }[] }).content[0]!.text)).toEqual(['{"ran":"accounts"}', '{"ran":"search"}', '{"ran":"read"}']);
    expect(ranArgv()).toEqual([
      ["makosh-mail", "accounts", "--assistant", "--json"],
      ["makosh-mail", "search", " -in:inbox; rm -rf ~ $(whoami) --json", "--assistant", "--json", "--limit", "20", "--account", "acc_1"],
      ["makosh-mail", "read", "m_1", "--assistant", "--json"],
    ]);
  });

  it("refuses bad input without running anything, and says so as a tool error", async () => {
    writeFileSync(argvLog, "");
    const answers = await talk([
      call(1, "mail_search", { query: "   " }),
      call(2, "mail_search", { query: "x".repeat(501) }),
      call(3, "mail_search", { query: "invoice", account: "--json" }),
      call(4, "mail_read", { messageId: "--assistant" }),
      call(5, "mail_read", {}),
      call(6, "mail_delete", { messageId: "m_1" }),
      { jsonrpc: "2.0", id: 7, method: "resources/list" },
    ]);
    for (const answer of answers.slice(0, 5)) expect((answer.result as { isError?: boolean }).isError).toBe(true);
    expect(answers[5]!.error).toMatchObject({ code: -32602 });
    expect(answers[6]!.error).toMatchObject({ code: -32601 });
    expect(ranArgv()).toEqual([]);
  });

  it("a failing command is a tool error with what bb said; a missing bb says how to fix it", async () => {
    const failed = await talk([call(1, "mail_read", { messageId: "missing" })]);
    expect(failed[0]!.result).toEqual({ content: [{ type: "text", text: "unknown message 'missing'" }], isError: true });
    const noBb = await talk([call(1, "mail_accounts", {})], join(dir, "no-such-bb"));
    expect((noBb[0]!.result as { isError: boolean; content: { text: string }[] }).isError).toBe(true);
    expect((noBb[0]!.result as { content: { text: string }[] }).content[0]!.text).toContain("MAKOSH_MAIL_BB");
  });

  it("answers a line that is not JSON or not a request with a JSON-RPC error and keeps going", async () => {
    const answers = await talk(["{not json", "[1,2]", { jsonrpc: "2.0", id: 9, method: "ping" }]);
    expect(answers).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } },
      { jsonrpc: "2.0", id: 9, result: {} },
    ]);
  });
});
