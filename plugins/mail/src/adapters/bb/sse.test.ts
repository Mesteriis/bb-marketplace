import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSseReader, type SseEvent } from "./sse.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const encode = (text: string) => new TextEncoder().encode(text);

function readAll(pieces: Uint8Array[]): SseEvent[] {
  const events: SseEvent[] = [];
  const reader = createSseReader((event) => events.push(event));
  for (const piece of pieces) reader.push(piece);
  reader.end();
  return events;
}

function textOf(events: SseEvent[]): string {
  return events
    .map((e) => JSON.parse(e.data) as { type: string; delta?: { type: string; text: string } })
    .filter((d) => d.type === "content_block_delta" && d.delta?.type === "text_delta")
    .map((d) => d.delta!.text)
    .join("");
}

describe("createSseReader", () => {
  it("reads events with names and data, ignoring comments", () => {
    const events = readAll([fixture("anthropic-messages.sse.txt")]);
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "ping",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(textOf(events)).toBe("Привет, сад 花园\nвторая строка");
  });

  it("gives the same events when the bytes are split at every boundary, through multi-byte characters", () => {
    const bytes = fixture("anthropic-messages.sse.txt");
    const whole = readAll([bytes]);
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(readAll([bytes.slice(0, cut), bytes.slice(cut)])).toEqual(whole);
    }
  });

  it("gives the same events when fed one byte at a time", () => {
    const bytes = fixture("openai-responses.sse.txt");
    const whole = readAll([bytes]);
    expect(readAll([...bytes].map((b) => new Uint8Array([b])))).toEqual(whole);
    expect(whole.at(-1)).toEqual({ event: null, data: "[DONE]" });
  });

  it("joins multi-line data with line feeds and accepts CRLF and CR line ends, also split between CR and LF", () => {
    const text = "event: x\r\ndata: one\r\ndata:two\r\n\r\nevent: y\rdata: three\r\r";
    const whole = readAll([encode(text)]);
    expect(whole).toEqual([
      { event: "x", data: "one\ntwo" },
      { event: "y", data: "three" },
    ]);
    const bytes = encode(text);
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(readAll([bytes.slice(0, cut), bytes.slice(cut)])).toEqual(whole);
    }
  });

  it("ignores unknown fields and events without data, and resets the name after each event", () => {
    expect(readAll([encode("id: 7\nretry: 10\nevent: lonely\n\ndata: a\n\nfoo: bar\ndata\n\n")])).toEqual([
      { event: null, data: "a" },
      { event: null, data: "" },
    ]);
  });

  it("delivers a last event without its blank line at the end", () => {
    expect(readAll([encode("event: last\ndata: {}")])).toEqual([{ event: "last", data: "{}" }]);
  });

  it("replaces invalid UTF-8 instead of throwing", () => {
    expect(readAll([new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a])])).toEqual([
      { event: null, data: "�" },
    ]);
  });
});
