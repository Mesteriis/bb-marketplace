import { describe, expect, it } from "vitest";
import { parseWindowMessage } from "../src/core/window-protocol.ts";

describe("lines from the window", () => {
  it("accepts exactly the known messages", () => {
    expect(parseWindowMessage('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(parseWindowMessage('{"type":"url","url":"https://chatgpt.com/c/abc"}')).toEqual({ type: "url", url: "https://chatgpt.com/c/abc" });
    expect(parseWindowMessage('{"type":"result","id":"1","ok":true,"value":{"status":"handed-off"}}')).toEqual({
      type: "result",
      id: "1",
      ok: true,
      value: { status: "handed-off" },
    });
    expect(parseWindowMessage('{"type":"pressed","action":"insert"}')).toEqual({ type: "pressed", action: "insert" });
    expect(parseWindowMessage('{"type":"copied","ok":false}')).toEqual({ type: "copied", ok: false });
    expect(parseWindowMessage('{"type":"closed"}')).toEqual({ type: "closed" });
  });

  it.each([
    ["not json", "{"],
    ["an array", "[]"],
    ["an unknown type", '{"type":"evaluate","expression":"1"}'],
    ["an unknown button", '{"type":"pressed","action":"send"}'],
    ["a url that is not a string", '{"type":"url","url":1}'],
    ["a result without id", '{"type":"result","ok":true}'],
    ["an empty line", ""],
  ])("rejects %s", (_name, line) => {
    expect(parseWindowMessage(line)).toBeNull();
  });

  it("rejects an oversized line", () => {
    expect(parseWindowMessage('{"type":"url","url":"' + "x".repeat(1_000_001) + '"}')).toBeNull();
  });
});
