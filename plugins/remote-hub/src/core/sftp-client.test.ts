// The cases a real server cannot be made to show: a name that is not UTF-8 (macOS refuses to create one), a server without
// the atomic rename, and a channel that dies in the middle. The server here is a script of hand-built replies.
import { describe, expect, it } from "vitest";
import { SftpClient, SftpOpError } from "./sftp-client.ts";
import { T } from "./sftp-wire.ts";

const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const str = (b: number[] | string) => {
  const bytes = typeof b === "string" ? Array.from(new TextEncoder().encode(b)) : b;
  return [...u32(bytes.length), ...bytes];
};
const packet = (body: number[]) => Uint8Array.from([...u32(body.length), ...body]);
const version = (extensions: Array<[string, string]> = []) => packet([T.VERSION, ...u32(3), ...extensions.flatMap(([k, v]) => [...str(k), ...str(v)])]);
const status = (id: number, code: number) => packet([T.STATUS, ...u32(id), ...u32(code), ...str(""), ...str("")]);
const handle = (id: number) => packet([T.HANDLE, ...u32(id), ...str([1])]);
const name = (id: number, names: number[][], mode = 0o100644) => packet([T.NAME, ...u32(id), ...u32(names.length), ...names.flatMap((n) => [...str(n), ...str("l"), ...u32(4), ...u32(mode)])]);

/** A client whose requests are recorded: `sent[i]` is the i-th packet, `id(i)` its request id, `type(i)` its type byte. */
async function started(extensions: Array<[string, string]> = []) {
  const sent: Uint8Array[] = [];
  const client = new SftpClient((bytes) => void sent.push(bytes));
  const ready = client.start();
  client.feed(version(extensions));
  await ready;
  const id = (i: number) => new DataView(sent[i]!.buffer).getUint32(5);
  const type = (i: number) => sent[i]![4];
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { client, sent, id, type, tick };
}

const code = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "ok";
  } catch (e) {
    return e instanceof SftpOpError ? e.code : "threw " + String(e);
  }
};
const P = new TextEncoder().encode("/d");

describe("SftpClient", () => {
  it("returns a name that is not valid UTF-8 as the bytes the server sent", async () => {
    const { client, id, tick } = await started();
    const listing = client.list(P, undefined, 10);
    await tick();
    client.feed(handle(id(1)));
    await tick();
    client.feed(name(id(2), [[0x2e], [0x62, 0xff, 0xfe], [0x2e, 0x2e]]));
    await tick();
    client.feed(status(id(3), 1));
    await tick();
    client.feed(status(id(4), 0)); // close
    const page = await listing;
    expect(page.entries.map((e) => Array.from(e.name))).toEqual([[0x62, 0xff, 0xfe]]);
    expect(page.entries[0]!.attrs.type).toBe("file");
  });

  it("without the server's posix-rename an overwriting rename is unsupported and nothing is sent", async () => {
    const { client, sent } = await started();
    expect(await code(client.rename(P, P, true))).toBe("unsupported");
    expect(sent.length).toBe(1); // only INIT
  });

  it("with posix-rename the overwriting rename is that extension, one request", async () => {
    const { client, sent, id, type, tick } = await started([["posix-rename@openssh.com", "1"]]);
    const renamed = client.rename(P, P, true);
    await tick();
    expect([sent.length, type(1)]).toEqual([2, T.EXTENDED]);
    client.feed(status(id(1), 0));
    expect(await code(renamed)).toBe("ok");
  });

  it("a change that was sent when the channel died is outcome_unknown; a read in flight is channel_closed", async () => {
    const { client, tick } = await started();
    const making = client.mkdir(P);
    const looking = client.stat(P, true);
    await tick();
    client.end();
    expect(await code(making)).toBe("outcome_unknown");
    expect(await code(looking)).toBe("channel_closed");
  });

  it("a write whose file was opened and then lost the channel is outcome_unknown, even for the part never sent", async () => {
    const { client, tick } = await started();
    const writing = client.write(P, 0n, new Uint8Array(10), "truncate");
    await tick();
    client.end(); // the OPEN (which creates or empties the file) went out, its answer never came
    expect(await code(writing)).toBe("outcome_unknown");
  });

  it("a server status becomes the contract's code", async () => {
    const { client, sent, id, tick } = await started();
    for (const [fx, expected] of [[2, "no_such_file"], [3, "permission_denied"], [8, "unsupported"], [4, "failure"], [5, "failure"]] as const) {
      const work = client.realpath(P);
      await tick();
      client.feed(status(id(sent.length - 1), fx));
      expect(await code(work)).toBe(expected);
    }
  });

  it("bytes that are not SFTP end the channel: what was in flight is answered and nothing more is sent", async () => {
    const { client, sent, tick } = await started();
    const looking = client.stat(P, true);
    await tick();
    client.feed(Uint8Array.from([0, 0, 0, 2, 99, 0]));
    expect(await code(looking)).toBe("channel_closed");
    expect(await code(client.stat(P, true))).toBe("channel_closed");
    expect(sent.length).toBe(2);
  });

  it("a server that is not SFTP 3 is refused at the start", async () => {
    const client = new SftpClient(() => undefined);
    const ready = client.start();
    client.feed(packet([T.VERSION, ...u32(6)]));
    expect(await code(ready)).toBe("channel_closed");
  });
});
