import { describe, expect, it, vi } from "vitest";
import { CommanderError } from "../../core/errors.ts";
import type { Endpoint } from "../../core/model.ts";
import { parsePosix } from "../../core/path.ts";
import type { ArchiveEntry } from "../../core/wire/archive-protocol.ts";
import { ArchiveProvider, type ArchiveRpc } from "./archive-provider.ts";

const ENDPOINT: Endpoint = {
  id: "archive:123e4567-e89b-42d3-a456-426614174000", provider: "archive", label: "a.zip", machine: "server",
  hostId: null, readOnly: true, caseSensitive: true,
};
const signal = new AbortController().signal;
const b64 = (s: string | number[]) => Buffer.from(typeof s === "string" ? s : Uint8Array.from(s)).toString("base64");

const file = (id: number, name: string, size: number, over: Partial<ArchiveEntry> = {}): ArchiveEntry => ({
  id, nameB64: b64(name), name, nameLossy: false, kind: "file", size: String(size), csize: String(size),
  mtime: 1732665600, mode: 0o644, encrypted: false, ...over,
});

type Call = { t: string; [key: string]: unknown };
function rpcWith(handler: (body: Call) => { json: Record<string, unknown>; data?: Uint8Array[] } | Promise<{ json: Record<string, unknown>; data?: Uint8Array[] }>) {
  const calls: Call[] = [];
  const rpc: ArchiveRpc = {
    request: vi.fn(async (body: Call) => {
      calls.push(body);
      const out = await handler(body);
      return { json: { req: 1, ...out.json } as unknown as { t: string }, data: out.data ?? [] };
    }) as unknown as ArchiveRpc["request"],
  };
  return { rpc, calls };
}
const make = (rpc: ArchiveRpc, over: Partial<ConstructorParameters<typeof ArchiveProvider>[0]> = {}) =>
  new ArchiveProvider({ endpoint: ENDPOINT, rpc, verifySource: async () => {}, ...over });

describe("list and stat", () => {
  it("maps helper entries to Entry values and sends the prefix as base64 of the joined segments", async () => {
    const { rpc, calls } = rpcWith(() => ({
      json: {
        t: "ok", cursor: null, entries: [
          file(0, "docs/a.txt", 5),
          { ...file(1, "docs/sub", 0), kind: "dir", synthetic: true },
          { ...file(2, "docs/.hidden", 1) },
          { ...file(3, "docs/l", 0), kind: "symlink", linkB64: b64("a.txt") },
        ],
      },
    }));
    const page = await make(rpc).list(parsePosix("/docs"), { cursor: null, limit: 10 }, signal);
    expect(calls[0]).toMatchObject({ t: "list", prefix: b64("docs"), cursor: null, limit: 10 });
    expect(page.cursor).toBeNull();
    expect(page.entries).toEqual([
      { name: { t: "a.txt" }, kind: "file", size: "5", mtimeNs: "1732665600000000000", mtimePrecision: "s", mode: 0o644, linkTarget: null, hidden: false },
      { name: { t: "sub" }, kind: "dir", size: "0", mtimeNs: "1732665600000000000", mtimePrecision: "s", mode: 0o644, linkTarget: null, hidden: false },
      { name: { t: ".hidden" }, kind: "file", size: "1", mtimeNs: "1732665600000000000", mtimePrecision: "s", mode: 0o644, linkTarget: null, hidden: true },
      { name: { t: "l" }, kind: "symlink", size: "0", mtimeNs: "1732665600000000000", mtimePrecision: "s", mode: 0o644, linkTarget: { t: "a.txt" }, hidden: false },
    ]);
  });
  it("represents a non UTF-8 name as raw bytes and uses null time when the entry has none", async () => {
    const raw = [0x63, 0x61, 0x66, 0x82];
    const { rpc } = rpcWith(() => ({ json: { t: "ok", cursor: null, entries: [{ ...file(0, "caf?", 1), nameB64: b64(raw), nameLossy: true, mtime: null }] } }));
    const page = await make(rpc).list(parsePosix("/"), { cursor: null, limit: 10 }, signal);
    expect(page.entries[0]).toMatchObject({ name: { b: b64(raw) }, mtimeNs: null, mtimePrecision: "unknown" });
  });
  it("stat returns null when the helper has no such entry", async () => {
    const { rpc, calls } = rpcWith(() => ({ json: { t: "ok", entry: null } }));
    expect(await make(rpc).stat(parsePosix("/missing.txt"), signal)).toBeNull();
    expect(calls[0]).toMatchObject({ t: "stat", nameB64: b64("missing.txt") });
  });
  it("checks the source version before every operation and fails changed_since_plan", async () => {
    const { rpc } = rpcWith(() => ({ json: { t: "ok", entry: null } }));
    const verifySource = vi.fn(async () => { throw new CommanderError("changed_since_plan", "Archive changed"); });
    await expect(make(rpc, { verifySource }).stat(parsePosix("/a"), signal)).rejects.toMatchObject({ code: "changed_since_plan" });
    expect(rpc.request).not.toHaveBeenCalled();
  });
});

describe("read", () => {
  function reading(size: number) {
    let pos = 0;
    const h = rpcWith((body) => {
      switch (body.t) {
        case "stat": return { json: { t: "ok", entry: file(7, "a.bin", size) } };
        case "read_open": pos = 0; return { json: { t: "ok", stream: 3, size: String(size) } };
        case "read": {
          const n = Math.min(body.length as number, size - pos);
          const bytes = Uint8Array.from({ length: n }, (_, i) => (pos + i) % 256);
          pos += n;
          return { json: { t: "ok", pos }, data: [bytes] };
        }
        case "read_finish": return { json: { t: "ok", size: String(size), crc32: null, aes_auth: null } };
        case "read_close": return { json: { t: "ok" } };
        default: throw new Error(body.t);
      }
    });
    return h;
  }
  const path = parsePosix("/a.bin");
  const same = { size: "10", mtimeNs: "1732665600000000000" };

  it("reads sequentially through one stream", async () => {
    const { rpc, calls } = reading(10);
    const provider = make(rpc);
    expect([...await provider.read(path, 0n, 4, same, signal)]).toEqual([0, 1, 2, 3]);
    expect([...await provider.read(path, 4n, 6, same, signal)]).toEqual([4, 5, 6, 7, 8, 9]);
    expect(calls.filter((c) => c.t === "read_open")).toHaveLength(1);
  });
  it("opens a stream of its own for a jump and skips to the offset, leaving the first reader's stream open", async () => {
    const { rpc, calls } = reading(10);
    const provider = make(rpc);
    await provider.read(path, 0n, 4, same, signal);
    expect([...await provider.read(path, 2n, 3, same, signal)]).toEqual([2, 3, 4]);
    expect(calls.filter((c) => c.t === "read_open")).toHaveLength(2);
    expect(calls.some((c) => c.t === "read_close")).toBe(false);
  });
  it("fails changed_since_plan when the expected version differs from the entry", async () => {
    const { rpc } = reading(10);
    await expect(make(rpc).read(path, 0n, 4, { size: "11", mtimeNs: same.mtimeNs }, signal)).rejects.toMatchObject({ code: "changed_since_plan" });
    await expect(make(rpc).read(path, 0n, 4, { size: "10", mtimeNs: "1" }, signal)).rejects.toMatchObject({ code: "changed_since_plan" });
  });
  it("refuses to read a directory and a missing entry", async () => {
    const dir = rpcWith(() => ({ json: { t: "ok", entry: { ...file(1, "d", 0), kind: "dir" } } }));
    await expect(make(dir.rpc).read(parsePosix("/d"), 0n, 1, null, signal)).rejects.toMatchObject({ code: "is_a_directory" });
    const none = rpcWith(() => ({ json: { t: "ok", entry: null } }));
    await expect(make(none.rpc).read(parsePosix("/x"), 0n, 1, null, signal)).rejects.toMatchObject({ code: "not_found" });
  });
  it("passes the owner's password callback to read_open and never to the agent path", async () => {
    const { rpc } = reading(10);
    const password = async () => Uint8Array.from([1]);
    await make(rpc, { password }).read(path, 0n, 1, same, signal);
    const [, options] = (rpc.request as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => (c[0] as Call).t === "read_open")!;
    expect((options as { password?: unknown }).password).toBe(password);
    const agent = reading(10);
    await make(agent.rpc).read(path, 0n, 1, same, signal);
    const [, agentOptions] = (agent.rpc.request as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => (c[0] as Call).t === "read_open")!;
    expect((agentOptions as { password?: unknown }).password).toBeUndefined();
  });
});

describe("refused entries", () => {
  it("never shows a refused record as a file or directory and refuses to read it with the specific reason", async () => {
    const entries = [
      { ...file(0, "l", 0), kind: "symlink" as const, linkB64: b64("../../outside"), refused: "link_escapes" },
      { ...file(1, "docs/h", 0), kind: "hardlink" as const, linkB64: b64("docs/x") },
      // The helper did not flag it: the TypeScript guard is the second line.
      { ...file(2, "../x", 3), nameB64: b64("../x") },
      { ...file(3, "ok.txt", 3) },
    ];
    const { rpc } = rpcWith((body) => body.t === "list"
      ? { json: { t: "ok", cursor: null, entries } }
      : { json: { t: "ok", entry: entries[Number((body as unknown as { idx?: number }).idx ?? 0)] } });
    const page = await make(rpc).list(parsePosix("/"), { cursor: null, limit: 10 }, signal);
    // "../x" has no addressable name: it is not listed at all.
    expect(page.entries.map((e) => [e.name, e.kind])).toEqual([
      [{ t: "l" }, "symlink"], [{ t: "h" }, "other"], [{ t: "ok.txt" }, "file"],
    ]);
    for (const [index, expected] of [
      [0, { code: "unsupported", reason: "link_escapes" }],
      [1, { code: "unsupported", reason: "link_not_supported" }],
      [2, { code: "invalid_path" }],
    ] as const) {
      const one = rpcWith(() => ({ json: { t: "ok", entry: entries[index] } }));
      await expect(make(one.rpc).read(parsePosix("/n"), 0n, 1, null, signal)).rejects.toMatchObject(expected);
    }
  });
});

describe("finishRead (the integrity barrier)", () => {
  const path = parsePosix("/a.bin");
  it("runs read_finish after the whole entry was read", async () => {
    let finished = false;
    const { rpc, calls } = rpcWith((body) => {
      if (body.t === "stat") return { json: { t: "ok", entry: file(7, "a.bin", 3) } };
      if (body.t === "read_open") return { json: { t: "ok", stream: 3, size: "3" } };
      if (body.t === "read") return { json: { t: "ok", pos: 3 }, data: [Uint8Array.from([1, 2, 3])] };
      if (body.t === "read_finish") { finished = true; return { json: { t: "ok", size: "3", crc32: 1, aes_auth: null } }; }
      return { json: { t: "ok" } };
    });
    const provider = make(rpc);
    await provider.read(path, 0n, 3, null, signal);
    await provider.finishRead!(path, { size: "3", mtimeNs: "1732665600000000000" }, signal);
    expect(finished).toBe(true);
    expect(calls.map((c) => c.t)).toEqual(["stat", "read_open", "read", "stat", "read_finish", "read_close"]);
  });
  it("runs the barrier for an empty entry without any read", async () => {
    const { rpc, calls } = rpcWith((body) => {
      if (body.t === "stat") return { json: { t: "ok", entry: file(7, "a.bin", 0) } };
      if (body.t === "read_open") return { json: { t: "ok", stream: 4, size: "0" } };
      return { json: { t: "ok", size: "0", crc32: 0, aes_auth: null } };
    });
    await make(rpc).finishRead!(path, { size: "0", mtimeNs: "1732665600000000000" }, signal);
    expect(calls.map((c) => c.t)).toEqual(["stat", "read_open", "read_finish", "read_close"]);
  });
  it("propagates a failed barrier so the caller never commits", async () => {
    const { rpc } = rpcWith((body) => {
      if (body.t === "stat") return { json: { t: "ok", entry: file(7, "a.bin", 0) } };
      if (body.t === "read_open") return { json: { t: "ok", stream: 4, size: "0" } };
      if (body.t === "read_close") return { json: { t: "ok" } };
      throw new CommanderError("invalid_archive", "bad crc", false, "crc_mismatch");
    });
    await expect(make(rpc).finishRead!(path, { size: "0", mtimeNs: "1732665600000000000" }, signal))
      .rejects.toMatchObject({ code: "invalid_archive", reason: "crc_mismatch" });
  });
  it("reads an entry that was read only in part through before it confirms it", async () => {
    let finished = false;
    const { rpc, calls } = rpcWith((body) => {
      if (body.t === "stat") return { json: { t: "ok", entry: file(7, "a.bin", 3) } };
      if (body.t === "read_open") return { json: { t: "ok", stream: 3, size: "3" } };
      if (body.t === "read") return { json: { t: "ok", pos: 1 }, data: [Uint8Array.from([1])] };
      if (body.t === "read_finish") { finished = true; return { json: { t: "ok", size: "3", crc32: 1, aes_auth: null } }; }
      return { json: { t: "ok" } };
    });
    const provider = make(rpc);
    await provider.read(path, 0n, 1, null, signal);
    await provider.finishRead!(path, { size: "3", mtimeNs: "1732665600000000000" }, signal);
    expect(finished).toBe(true);
    expect(calls.filter((c) => c.t === "read")).toHaveLength(1 + 3);
  });
});

describe("a read-only provider", () => {
  it("advertises list, stat and read only and refuses every mutation with unsupported", async () => {
    const provider = make(rpcWith(() => ({ json: { t: "ok" } })).rpc);
    expect([...provider.capabilities].sort()).toEqual(["list", "read", "stat"]);
    const path = parsePosix("/a");
    await expect(provider.openWrite(path, { tempName: { t: "x" } }, signal)).rejects.toMatchObject({ code: "unsupported" });
    await expect(provider.mkdir(path, signal)).rejects.toMatchObject({ code: "unsupported" });
    await expect(provider.rename(path, path, { replace: false }, signal)).rejects.toMatchObject({ code: "unsupported" });
    await expect(provider.remove(path, { kind: "file" }, signal)).rejects.toMatchObject({ code: "unsupported" });
    expect(provider.copyWithin).toBeUndefined();
    expect(provider.sha256).toBeUndefined();
  });
});

describe("two readers of one archive (a viewer window and a copy job)", () => {
  // A helper that keeps one position per stream, like the real one.
  function multi(sizes: Record<string, number>) {
    const streams = new Map<number, { id: number; pos: number; size: number }>();
    let nextStream = 1;
    const names = Object.keys(sizes);
    const finishes: number[] = [];
    const h = rpcWith((body) => {
      switch (body.t) {
        case "stat": {
          const index = names.indexOf(Buffer.from(body.nameB64 as string, "base64").toString());
          return { json: { t: "ok", entry: file(index, names[index]!, sizes[names[index]!]!) } };
        }
        case "read_open": {
          const id = body.id as number;
          const stream = nextStream++;
          streams.set(stream, { id, pos: 0, size: sizes[names[id]!]! });
          return { json: { t: "ok", stream, size: String(sizes[names[id]!]) } };
        }
        case "read": {
          const s = streams.get(body.stream as number)!;
          const n = Math.min(body.length as number, s.size - s.pos);
          const bytes = Uint8Array.from({ length: n }, (_, i) => (s.pos + i) % 251);
          s.pos += n;
          return { json: { t: "ok", pos: s.pos }, data: [bytes] };
        }
        case "read_finish": {
          const s = streams.get(body.stream as number)!;
          if (s.pos !== s.size) throw new CommanderError("invalid_archive", "short", false, "truncated");
          finishes.push(body.stream as number);
          return { json: { t: "ok", size: String(s.size), crc32: 0, aes_auth: null } };
        }
        case "read_close": streams.delete(body.stream as number); return { json: { t: "ok" } };
        default: throw new Error(body.t);
      }
    });
    return { ...h, streams, finishes };
  }
  const sameVersion = (size: number) => ({ size: String(size), mtimeNs: "1732665600000000000" });

  it("keeps the bytes right when a window read lands between the chunks of a copy, and the barrier still passes", async () => {
    const { rpc } = multi({ "a.bin": 20, "b.bin": 10 });
    const provider = make(rpc);
    const a = parsePosix("/a.bin"), b = parsePosix("/b.bin");
    expect([...await provider.read(a, 0n, 8, sameVersion(20), signal)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // The viewer reads another entry and then a window of the same one.
    expect([...await provider.read(b, 0n, 4, sameVersion(10), signal)]).toEqual([0, 1, 2, 3]);
    expect([...await provider.read(a, 2n, 3, sameVersion(20), signal)]).toEqual([2, 3, 4]);
    // The copy continues where it was.
    expect([...await provider.read(a, 8n, 12, sameVersion(20), signal)]).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    await expect(provider.finishRead!(a, sameVersion(20), signal)).resolves.toBeUndefined();
  });

  it("the barrier of an entry another reader moved is proven by reading it through again, never by guessing", async () => {
    const h = multi({ "a.bin": 20 });
    const provider = make(h.rpc);
    const a = parsePosix("/a.bin");
    await provider.read(a, 0n, 20, sameVersion(20), signal);
    await provider.read(a, 5n, 3, sameVersion(20), signal);
    await expect(provider.finishRead!(a, sameVersion(20), signal)).resolves.toBeUndefined();
    expect(h.finishes).toHaveLength(1);
  });
});

describe("a stream stays with its reader until the barrier", () => {
  // The helper opens independent streams (up to four); the fake counts every byte it hands out.
  function helper(sizes: Record<string, number>) {
    const names = Object.keys(sizes);
    const streams = new Map<number, { id: number; pos: number }>();
    let next = 1;
    let served = 0;
    const log: string[] = [];
    const h = rpcWith(async (body) => {
      await new Promise((r) => setTimeout(r, 1));
      log.push(body.t + (body.stream ? ":" + body.stream : ""));
      switch (body.t) {
        case "stat": {
          const index = names.indexOf(Buffer.from(body.nameB64 as string, "base64").toString());
          return { json: { t: "ok", entry: file(index, names[index]!, sizes[names[index]!]!) } };
        }
        case "read_open": {
          if (streams.size >= 4) throw new CommanderError("invalid_path", "Too many open streams");
          const stream = next++;
          streams.set(stream, { id: body.id as number, pos: 0 });
          return { json: { t: "ok", stream, size: String(sizes[names[body.id as number]!]) } };
        }
        case "read": {
          const s = streams.get(body.stream as number);
          if (!s) throw new CommanderError("invalid_path", "No such stream");
          const size = sizes[names[s.id]!]!;
          const n = Math.min(body.length as number, size - s.pos);
          const bytes = Uint8Array.from({ length: n }, (_, i) => (s.id * 100 + s.pos + i) % 251);
          s.pos += n;
          served += n;
          return { json: { t: "ok", pos: s.pos }, data: [bytes] };
        }
        case "read_finish": {
          const s = streams.get(body.stream as number);
          if (!s || s.pos !== sizes[names[s.id]!]) throw new CommanderError("invalid_archive", "short", false, "truncated");
          return { json: { t: "ok", size: String(s.pos), crc32: 0, aes_auth: null } };
        }
        case "read_close": streams.delete(body.stream as number); return { json: { t: "ok" } };
        default: throw new Error(body.t);
      }
    });
    return { ...h, streams, log, served: () => served };
  }
  const v = (size: number) => ({ size: String(size), mtimeNs: "1732665600000000000" });
  const at = (name: string) => parsePosix("/" + name);

  it("two entries read by turns cost exactly their own sizes: no stream is dropped and read again, no limit is hit", async () => {
    const h = helper({ "a.bin": 400, "b.bin": 400 });
    const provider = make(h.rpc);
    const a: number[] = [], b: number[] = [];
    for (let o = 0; o < 400; o += 50) {
      a.push(...await provider.read(at("a.bin"), BigInt(o), 50, v(400), signal));
      b.push(...await provider.read(at("b.bin"), BigInt(o), 50, v(400), signal));
    }
    expect(a).toEqual(Array.from({ length: 400 }, (_, i) => i % 251));
    expect(b).toEqual(Array.from({ length: 400 }, (_, i) => (100 + i) % 251));
    expect(h.served()).toBe(800);
    await provider.finishRead!(at("a.bin"), v(400), signal);
    await provider.finishRead!(at("b.bin"), v(400), signal);
    expect(h.served()).toBe(800);
    expect(h.streams.size).toBe(0);
  });

  it("a window read of the entry being copied uses a stream of its own and leaves the copy's stream where it was", async () => {
    const h = helper({ "a.bin": 100 });
    const provider = make(h.rpc);
    await provider.read(at("a.bin"), 0n, 40, v(100), signal);
    expect([...await provider.read(at("a.bin"), 10n, 3, v(100), signal)]).toEqual([10, 11, 12]);
    await provider.read(at("a.bin"), 40n, 60, v(100), signal);
    await provider.finishRead!(at("a.bin"), v(100), signal);
    // 100 for the copy, 13 for the window (skip 10 + read 3); the copy was never re-read.
    expect(h.served()).toBe(113);
  });

  it("two simultaneous reads that both continue the same stream never share it", async () => {
    const h = helper({ "a.bin": 100 });
    const provider = make(h.rpc);
    await provider.read(at("a.bin"), 0n, 20, v(100), signal);
    const [first, second] = await Promise.all([
      provider.read(at("a.bin"), 20n, 10, v(100), signal), provider.read(at("a.bin"), 20n, 10, v(100), signal),
    ]);
    expect([...first]).toEqual(Array.from({ length: 10 }, (_, i) => 20 + i));
    expect([...second]).toEqual(Array.from({ length: 10 }, (_, i) => 20 + i));
  });

  it("an error or a cancel on a read frees that stream; the next read starts clean", async () => {
    const h = helper({ "a.bin": 100 });
    const provider = make(h.rpc);
    await provider.read(at("a.bin"), 0n, 20, v(100), signal);
    const real = h.rpc.request;
    let fail = true;
    (h.rpc as { request: unknown }).request = vi.fn(async (body: { t: string }, options: unknown) => {
      if (fail && body.t === "read") { fail = false; throw new CommanderError("cancelled", "stopped"); }
      return (real as (b: unknown, o: unknown) => Promise<unknown>)(body, options);
    });
    await expect(provider.read(at("a.bin"), 20n, 10, v(100), signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(h.streams.size).toBe(0);
    expect([...await provider.read(at("a.bin"), 20n, 3, v(100), signal)]).toEqual([20, 21, 22]);
  });

  it("an idle stream is released after 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = helper({ "a.bin": 100 });
      const provider = make(h.rpc);
      const pending = provider.read(at("a.bin"), 0n, 20, v(100), signal);
      await vi.advanceTimersByTimeAsync(10);
      await pending;
      expect(h.streams.size).toBe(1);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(h.streams.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps at most four streams: the least recently used one is closed to make room", async () => {
    const h = helper({ "a": 10, "b": 10, "c": 10, "d": 10, "e": 10 });
    const provider = make(h.rpc);
    for (const name of ["a", "b", "c", "d", "e"]) await provider.read(at(name), 0n, 5, v(10), signal);
    expect(h.streams.size).toBe(4);
    // The first entry's stream was the one closed; reading on from its position starts a new stream and skips.
    expect([...await provider.read(at("a"), 5n, 3, v(10), signal)]).toEqual([5, 6, 7]);
  });
});
