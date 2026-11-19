// @vitest-environment jsdom
// The REAL xterm.js terminal (not opened: no canvas is needed to parse and keep a buffer) is fed what a container console through dtach
// sends first, and the carried text must still be in the buffer afterwards.
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { writeCarriedHistory } from "./terminal-history.ts";

const HISTORY = "root@ct:~# ls\r\nfile-a\r\n\u001b[33m──── connection lost ────\u001b[0m\r\n\u001b[33m──── reconnected: a new console ────\u001b[0m\r\n";
const feed = (t: Terminal, data: string) => new Promise<void>((r) => t.write(data, r));
const all = (t: Terminal): string => {
  const b = t.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n");
};
const viewportBlank = (t: Terminal): boolean => {
  const b = t.buffer.active;
  for (let i = b.baseY; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? "") !== "") return false;
  return true;
};

async function carried(first: string) {
  const t = new Terminal({ rows: 24, cols: 80, allowProposedApi: true });
  writeCarriedHistory({ rows: t.rows, write: (d) => t.write(d) }, HISTORY);
  await feed(t, first); // exactly the first bytes of the new console
  return t;
}

describe("the carried screen survives what a guest sends when it is attached", () => {
  it.each([["ESC[2J", "\u001b[2J"], ["ESC[H ESC[J", "\u001b[H\u001b[J"], ["ESC[2J ESC[H", "\u001b[2J\u001b[H"], ["clear then a prompt", "\u001b[H\u001b[2Jroot@ct:~# "]])("%s", async (_n, seq) => {
    const t = await carried(seq);
    const text = all(t);
    expect(text).toContain("file-a");
    expect(text).toContain("connection lost");
    expect(text).toContain("reconnected: a new console");
  });

  it("the guest's bytes are written as they are: its prompt appears after the carried text", async () => {
    const t = await carried("root@ct:~# ");
    const text = all(t);
    expect(text.indexOf("file-a")).toBeLessThan(text.lastIndexOf("root@ct:~# "));
  });

  it("without the scroll-out the same sequence erases the text (what the live run saw)", async () => {
    const t = new Terminal({ rows: 24, cols: 80, allowProposedApi: true });
    t.write(HISTORY);
    await feed(t, "\u001b[2J");
    expect(all(t)).not.toContain("file-a");
    expect(viewportBlank(t)).toBe(true);
  });
});
