import { describe, expect, it } from "vitest";
import { encodeBridgeRequest, parseBridgeLine } from "./bridge-protocol.ts";

describe("encodeBridgeRequest", () => {
  it("writes one JSON line with id, cmd and args", () => {
    expect(encodeBridgeRequest(7, "git_status", { cwd: "/tmp/repo a" })).toBe(
      '{"id":7,"cmd":"git_status","args":{"cwd":"/tmp/repo a"}}\n',
    );
  });

  it("keeps a newline inside a value escaped, so one request stays one line", () => {
    const line = encodeBridgeRequest(1, "terminal_write", { id: 2, data: "echo hi\n" });
    expect(line).toBe('{"id":1,"cmd":"terminal_write","args":{"id":2,"data":"echo hi\\n"}}\n');
    expect(line.indexOf("\n")).toBe(line.length - 1);
  });

  it("accepts the bridge's own service commands", () => {
    expect(encodeBridgeRequest(1, "__hello", {})).toBe('{"id":1,"cmd":"__hello","args":{}}\n');
  });

  it.each([
    ["a Tauri plugin command", "plugin:dialog|open"],
    ["an empty name", ""],
    ["upper case", "Git_Status"],
    ["a space", "git status"],
    ["a newline", "git_status\n"],
  ])("refuses %s as a command name", (_name, cmd) => {
    expect(() => encodeBridgeRequest(1, cmd, {})).toThrow(/command name/);
  });
});

describe("parseBridgeLine", () => {
  it("reads a successful result", () => {
    expect(parseBridgeLine('{"id":3,"ok":{"branch":"main"}}')).toEqual({ kind: "result", id: 3, ok: true, value: { branch: "main" } });
  });

  it("reads a successful result whose value is null", () => {
    expect(parseBridgeLine('{"id":3,"ok":null}')).toEqual({ kind: "result", id: 3, ok: true, value: null });
  });

  it("reads a command error as text", () => {
    expect(parseBridgeLine('{"id":4,"error":"session not found"}')).toEqual({ kind: "result", id: 4, ok: false, error: "session not found" });
  });

  it("keeps a structured command error as it came", () => {
    expect(parseBridgeLine('{"id":4,"error":{"kind":"auth","message":"no token"}}')).toEqual({
      kind: "result",
      id: 4,
      ok: false,
      error: { kind: "auth", message: "no token" },
    });
  });

  it("reads a channel message", () => {
    expect(parseBridgeLine('{"channel":12,"message":{"type":"chunk","data":"gw-ok"}}')).toEqual({
      kind: "channel",
      channel: 12,
      message: { type: "chunk", data: "gw-ok" },
    });
  });

  it.each([
    ["not JSON", "panicked at src/lib.rs"],
    ["a JSON array", "[1,2]"],
    ["an empty object", "{}"],
    ["a result without ok or error", '{"id":1}'],
    ["a text id", '{"id":"1","ok":true}'],
    ["a negative id", '{"id":-1,"ok":true}'],
    ["a fractional channel", '{"channel":1.5,"message":null}'],
    ["a channel without a message", '{"channel":1}'],
  ])("marks %s as invalid instead of throwing", (_name, line) => {
    expect(parseBridgeLine(line)).toMatchObject({ kind: "invalid" });
  });
});

describe("encodeBridgeRequest with a connection", () => {
  it("adds conn after args, so the bridge files terminals and watchers under it", () => {
    expect(encodeBridgeRequest(5, "watch_repo_start", { cwd: "/r" }, "c-1")).toBe('{"id":5,"cmd":"watch_repo_start","args":{"cwd":"/r"},"conn":"c-1"}\n');
  });
});
