// The SFTP client against a REAL server: macOS's own /usr/libexec/sftp-server speaks SFTP on its stdin and stdout, so no
// ssh, no network and no account are involved. Everything happens inside a temporary directory made for the test.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SftpClient, SftpOpError } from "../../core/sftp-client.ts";

const SERVER = "/usr/libexec/sftp-server";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

let dir = "";
let server: ChildProcessWithoutNullStreams;
let client: SftpClient;

async function connect(): Promise<void> {
  // Each connection keeps its own pair: a server that exits late must not end the next test's client.
  const child = spawn(SERVER, ["-e"], { cwd: dir });
  const mine = new SftpClient((bytes) => void child.stdin.write(bytes));
  child.stdout.on("data", (chunk: Buffer) => mine.feed(new Uint8Array(chunk)));
  child.on("close", () => mine.end());
  server = child;
  client = mine;
  await mine.start();
}

const code = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "ok";
  } catch (e) {
    return e instanceof SftpOpError ? e.code : "threw " + String(e);
  }
};
const at = (name: string) => enc(join(dir, name));

describe.skipIf(!existsSync(SERVER))("SftpClient against sftp-server", () => {
  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "rh-sftp-")));
    await connect();
  });
  afterEach(() => {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a path and stats a file, a directory and a link", async () => {
    writeFileSync(join(dir, "a.txt"), "hello");
    mkdirSync(join(dir, "sub"));
    symlinkSync("a.txt", join(dir, "link"));
    expect(dec(await client.realpath(enc(".")))).toBe(dir);
    const file = await client.stat(at("a.txt"), false);
    expect([file.type, file.size, file.linkTarget]).toEqual(["file", 5n, null]);
    expect(file.mode! & 0o777).toBe(0o644);
    expect(typeof file.mtime).toBe("number");
    expect((await client.stat(at("sub"), false)).type).toBe("dir");
    const link = await client.stat(at("link"), false);
    expect([link.type, dec(link.linkTarget!)]).toEqual(["symlink", "a.txt"]);
    const followed = await client.stat(at("link"), true);
    expect([followed.type, followed.size, followed.linkTarget]).toEqual(["file", 5n, null]);
    expect(await code(client.stat(at("nope"), false))).toBe("no_such_file");
  });

  it("lists a directory in byte order of the names, without . and .., with link targets", async () => {
    writeFileSync(join(dir, "b"), "");
    writeFileSync(join(dir, "A"), "xy");
    mkdirSync(join(dir, "c"));
    symlinkSync("/etc/hosts", join(dir, "z"));
    const page = await client.list(enc(dir), undefined, 1000);
    expect(page.entries.map((e) => [dec(e.name), e.attrs.type, e.attrs.size === 2n])).toEqual([
      ["A", "file", true],
      ["b", "file", false],
      ["c", "dir", false],
      ["z", "symlink", false],
    ]);
    expect(dec(page.entries[3]!.attrs.linkTarget!)).toBe("/etc/hosts");
    expect(page.nextCursor).toBeNull();
  });

  it("pages through a listing; a later page continues after the last name even if entries changed in between", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) writeFileSync(join(dir, n), "");
    const first = await client.list(enc(dir), undefined, 2);
    expect(first.entries.map((e) => dec(e.name))).toEqual(["a", "b"]);
    const second = await client.list(enc(dir), first.nextCursor!, 2);
    expect(second.entries.map((e) => dec(e.name))).toEqual(["c", "d"]);
    const third = await client.list(enc(dir), second.nextCursor!, 2);
    expect([third.entries.map((e) => dec(e.name)), third.nextCursor]).toEqual([["e"], null]);
    // The listing is over, so the cursor is read against the directory as it is now.
    rmSync(join(dir, "b"));
    const again = await client.list(enc(dir), first.nextCursor!, 2);
    expect(again.entries.map((e) => dec(e.name))).toEqual(["c", "d"]);
  });

  it("reads a range, says when the file ended, and reads more than one request can carry", async () => {
    writeFileSync(join(dir, "f"), "0123456789");
    expect(await client.read(at("f"), 2n, 4)).toEqual({ data: enc("2345"), eof: false });
    expect(await client.read(at("f"), 8n, 4)).toEqual({ data: enc("89"), eof: true });
    expect(await client.read(at("f"), 10n, 4)).toEqual({ data: new Uint8Array(0), eof: true });
    const big = Buffer.alloc(300_000, 0);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    writeFileSync(join(dir, "big"), big);
    const got = await client.read(at("big"), 1000n, 250_000);
    expect(got.eof).toBe(false);
    expect(Buffer.from(got.data).equals(big.subarray(1000, 251_000))).toBe(true);
    expect(await code(client.read(at("nope"), 0n, 4))).toBe("no_such_file");
  });

  it("writes a new file exclusively, refuses a second exclusive write, continues at an offset, truncates", async () => {
    expect(await client.write(at("n"), 0n, enc("hello"), "exclusive")).toEqual({ written: 5 });
    expect(await code(client.write(at("n"), 0n, enc("again"), "exclusive"))).toBe("exists");
    expect(readFileSync(join(dir, "n"), "utf8")).toBe("hello");
    await client.write(at("n"), 5n, enc(" world"), "existing");
    expect(readFileSync(join(dir, "n"), "utf8")).toBe("hello world");
    await client.write(at("n"), 0n, enc("hi"), "truncate");
    expect(readFileSync(join(dir, "n"), "utf8")).toBe("hi");
    await client.write(at("empty"), 0n, new Uint8Array(0), "truncate");
    expect(readFileSync(join(dir, "empty")).length).toBe(0);
    expect(await code(client.write(at("missing"), 0n, enc("x"), "existing"))).toBe("no_such_file");
  });

  it("writes a chunk larger than one request, byte for byte", async () => {
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
    await client.write(at("big"), 0n, big, "exclusive");
    expect(Buffer.from(big).equals(readFileSync(join(dir, "big")))).toBe(true);
  });

  it("makes and removes directories and files, and says exists, not_empty and no_such_file", async () => {
    await client.mkdir(at("d"));
    expect(await code(client.mkdir(at("d")))).toBe("exists");
    writeFileSync(join(dir, "d", "x"), "");
    expect(await code(client.remove(at("d"), "dir"))).toBe("not_empty");
    await client.remove(at("d/x"), "file");
    await client.remove(at("d"), "dir");
    expect(readdirSync(dir)).toEqual([]);
    expect(await code(client.remove(at("nope"), "file"))).toBe("no_such_file");
  });

  it("renames without overwriting, and replaces atomically only when asked to", async () => {
    writeFileSync(join(dir, "a"), "A");
    writeFileSync(join(dir, "b"), "B");
    expect(await code(client.rename(at("a"), at("b"), false))).toBe("exists");
    expect(readFileSync(join(dir, "b"), "utf8")).toBe("B");
    await client.rename(at("a"), at("c"), false);
    expect(readdirSync(dir).sort()).toEqual(["b", "c"]);
    await client.rename(at("c"), at("b"), true);
    expect([readdirSync(dir), readFileSync(join(dir, "b"), "utf8")]).toEqual([["b"], "A"]);
  });

  it("after the channel died nothing is sent: a change answers channel_closed, not outcome_unknown", async () => {
    server.kill();
    await new Promise((r) => server.on("close", r));
    expect(await code(client.mkdir(at("late")))).toBe("channel_closed");
    expect(await code(client.stat(at("x"), false))).toBe("channel_closed");
    expect(existsSync(join(dir, "late"))).toBe(false);
  });
});
