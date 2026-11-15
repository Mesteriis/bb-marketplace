// A server-sent events reader over raw bytes (slice 3c, the translator).
// Bytes arrive in arbitrary pieces: a UTF-8 code point and an event may each
// span pieces, so one streaming TextDecoder turns bytes into text and lines
// are buffered until a blank line ends an event. Only `event:` and `data:`
// matter; comments, `id:`, `retry:` and unknown fields are ignored. Event
// text is never logged here: it is model output about the owner's mail.

export type SseEvent = { event: string | null; data: string };

export interface SseReader {
  push(bytes: Uint8Array): void;
  /** Flushes the decoder; an event still missing its blank line is delivered too. */
  end(): void;
}

export function createSseReader(onEvent: (event: SseEvent) => void): SseReader {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  let ended = false;

  const dispatch = () => {
    if (data.length > 0) onEvent({ event, data: data.join("\n") });
    event = null;
    data = [];
  };

  const line = (text: string) => {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };

  /** Splits complete lines off the buffer; a trailing CR waits for a possible LF unless `final`. */
  const drain = (final: boolean) => {
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];
      if (ch === "\n") {
        line(buffer.slice(start, i));
        start = i + 1;
      } else if (ch === "\r") {
        if (i + 1 === buffer.length && !final) break;
        line(buffer.slice(start, i));
        if (buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
    }
    buffer = buffer.slice(start);
  };

  return {
    push(bytes) {
      if (ended) return;
      buffer += decoder.decode(bytes, { stream: true });
      drain(false);
    },
    end() {
      if (ended) return;
      ended = true;
      buffer += decoder.decode();
      drain(true);
      if (buffer !== "") line(buffer);
      buffer = "";
      dispatch();
    },
  };
}
