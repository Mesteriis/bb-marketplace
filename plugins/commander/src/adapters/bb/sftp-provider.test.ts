import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { CommanderError } from "../../core/errors.ts";
import type { Endpoint } from "../../core/model.ts";
import type { ResourcePath } from "../../core/path.ts";
import { REMOTE_HUB_SFTP_CONTRACT, SFTP_REFUSALS, type SftpRefusalCode } from "../../core/wire/remote-hub-sftp.ts";
import { createSftpProvider } from "./sftp-provider.ts";
import { RemoteHubMock, type RemoteHubMockOptions } from "./testing/remote-hub-mock.ts";

const PROFILE = "5b568675-f842-4a96-83e0-78ae53d96024";
const MIB = 1024 * 1024;

const endpoint: Endpoint = {
  id: "sftp:5b568675-f842-4a96-83e0-78ae53d96024",
  provider: "sftp",
  label: "web",
  machine: "h.example.test:22",
  hostId: null,
  readOnly: false,
  caseSensitive: true,
};

const seg = (t: string) => ({ t });
const at = (...names: string[]): ResourcePath => ({ segments: names.map(seg) });

function setup(options: RemoteHubMockOptions = {}) {
  const mock = new RemoteHubMock({ consent: "granted", level: "write", hostKey: "trusted", ...options });
  const provider = createSftpProvider({ port: mock, profileId: PROFILE, endpoint });
  return { mock, provider };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<CommanderError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${code}, got success`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CommanderError);
  expect((error as CommanderError).code).toBe(code);
  return error as CommanderError;
}

const signal = () => new AbortController().signal;

describe("contract and capabilities", () => {
  it("exports the contract id it mirrors and declares only the stage-one capabilities", () => {
    expect(REMOTE_HUB_SFTP_CONTRACT).toBe("remote-hub@0bdc04d8");
    const { provider } = setup();
    expect([...provider.capabilities].sort()).toEqual(["list", "mkdir", "read", "remove", "rename", "seek", "stat", "write"]);
    expect(provider.capabilities.has("atomicReplace")).toBe(false);
    expect(provider.capabilities.has("checksum")).toBe(false);
  });
});

describe("consent, host key, access", () => {
  it("without a grant, list fails with consent_required and no operation is sent", async () => {
    const { mock, provider } = setup({ consent: "none" });
    await expectCode(provider.list(at(), { cursor: null, limit: 10 }, signal()), "consent_required");
    expect(mock.calls.some((call) => call.method === "hub_sftp_op")).toBe(false);
  });

  it("a revoked grant mid-session makes the next operation fail with consent_required and closes the channel", async () => {
    const { mock, provider } = setup();
    await provider.list(at(), { cursor: null, limit: 10 }, signal());
    mock.revoke();
    await expectCode(provider.list(at(), { cursor: null, limit: 10 }, signal()), "consent_required");
    expect(mock.channelAlive()).toBe(false);
  });

  it("host key unknown is host_key_rejected and no operation is sent", async () => {
    const { mock, provider } = setup({ hostKey: "unknown" });
    await expectCode(provider.stat(at("etc"), signal()), "host_key_rejected");
    expect(mock.calls.some((call) => call.method === "hub_sftp_op")).toBe(false);
  });

  it("host key changed is host_key_rejected and no operation is sent", async () => {
    const { mock, provider } = setup({ hostKey: "changed" });
    await expectCode(provider.stat(at("etc"), signal()), "host_key_rejected");
    expect(mock.calls.some((call) => call.method === "hub_sftp_op")).toBe(false);
  });

  it("access refused by the server is permission_denied", async () => {
    const { provider } = setup({ failNext: "permission_denied" });
    await expectCode(provider.list(at("root"), { cursor: null, limit: 10 }, signal()), "permission_denied");
  });

  it("a connection error is connection_failed and retryable", async () => {
    const { provider } = setup({ failWrite: "unreachable" });
    const error = await expectCode(
      provider.openWrite(at("f.txt"), signal()).then((session) => session.write(0n, new Uint8Array([1]), signal())),
      "connection_failed",
    );
    expect(error.retryable).toBe(true);
  });
});

describe("listing and attributes", () => {
  it("maps a file to an entry with whole-second mtime and nanoseconds as a string", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/a.txt", "hello world!");
    const page = await provider.list(at(), { cursor: null, limit: 100 }, signal());
    const entry = page.entries.find((e) => "t" in e.name && e.name.t === "a.txt");
    expect(entry).toEqual({
      name: { t: "a.txt" },
      kind: "file",
      size: "12",
      mtimeNs: "1795790479000000000",
      mtimePrecision: "s",
      mode: 0o100644,
      linkTarget: null,
      hidden: false,
    });
    expect(page.cursor).toBeNull();
  });

  it("a directory with more than 10000 entries is limit_exceeded, not a silent cut", async () => {
    const { provider } = setup({ dirSize: 10_001 });
    await expectCode(provider.list(at("big"), { cursor: null, limit: 1000 }, signal()), "limit_exceeded");
  });

  it("a byte name from the server is a {b} segment and the same bytes go back into a write", async () => {
    const { mock, provider } = setup();
    // The server holds the single raw byte 0xFF under the root: wire path "/" + 0xFF.
    mock.seedFile(new Uint8Array([0x2f, 0xff]), "old");
    const page = await provider.list({ segments: [] }, { cursor: null, limit: 100 }, signal());
    const raw = page.entries.find((e) => "b" in e.name);
    expect(raw?.name).toEqual({ b: "/w==" });

    const session = await provider.openWrite({ segments: [raw!.name] }, signal());
    await session.write(0n, new TextEncoder().encode("x"), signal());
    await session.commit({ replace: true, expectTarget: null }, signal());
    const rename = mock.calls.filter((c) => c.method === "hub_sftp_op" && (c.input as { op: string }).op === "rename").at(-1)?.input as { to: unknown };
    expect(rename.to).toEqual({ bytes: "L/8=" });
    expect(new TextDecoder().decode(mock.bytesAt(new Uint8Array([0x2f, 0xff])))).toBe("x");
  });
});

describe("reads", () => {
  it("reads 9 MiB in chunks of at most 4 MiB at offsets 0, 4194304 and 8388608", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/big.bin", new Uint8Array(9 * MIB));
    const bytes = await provider.read(at("big.bin"), 0n, 9 * MIB, null, signal());
    expect(bytes.byteLength).toBe(9 * MIB);
    const reads = mock.calls
      .filter((c) => c.method === "hub_sftp_op" && (c.input as { op: string }).op === "read")
      .map((c) => c.input as { offset: string; length: number });
    expect(reads.map((r) => r.offset)).toEqual(["0", "4194304", "8388608"]);
    expect(reads.map((r) => r.length)).toEqual([4194304, 4194304, 1048576]);
  });

  it("a read after a revoked session: an idempotent read reopens once and reports consent_required", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/x.txt", "abc");
    await provider.stat(at("x.txt"), signal());
    mock.revoke();
    await expectCode(provider.read(at("x.txt"), 0n, 3, null, signal()), "consent_required");
    expect(mock.opCount("open")).toBe(1);
  });
});

describe("generation change", () => {
  it("after two operations the helper restarts: list is repeated once, transparently", async () => {
    const { mock, provider } = setup({ generationBumpAfter: 2 });
    mock.seedFile("/a.txt", "a");
    await provider.list(at(), { cursor: null, limit: 100 }, signal());
    await provider.stat(at("a.txt"), signal());
    const page = await provider.list(at(), { cursor: null, limit: 100 }, signal());
    expect(page.entries.length).toBe(1);
    expect(mock.opCount("open")).toBe(2);
    expect(mock.opCount("op:list")).toBe(3);
  });

  it("a write across a restart is outcome_unknown and is not repeated", async () => {
    const { mock, provider } = setup({ generationBumpAfter: 2 });
    mock.seedFile("/a.txt", "a");
    await provider.stat(at("a.txt"), signal());
    await provider.stat(at("a.txt"), signal());
    const session = await provider.openWrite(at("new.txt"), signal());
    await expectCode(session.write(0n, new Uint8Array([1, 2, 3]), signal()), "outcome_unknown");
    expect(mock.opCount("op:write")).toBe(1);
    expect(mock.opCount("open")).toBe(1);
  });
});

describe("atomic replace", () => {
  it("without posix-rename, commit with replace is unsupported, not a remove and rename", async () => {
    const { mock, provider } = setup({ posixRename: false });
    mock.seedFile("/target.txt", "old");
    const session = await provider.openWrite(at("target.txt"), signal());
    await session.write(0n, new TextEncoder().encode("new"), signal());
    await expectCode(session.commit({ replace: true, expectTarget: null }, signal()), "unsupported");
    expect(mock.opCount("op:remove")).toBe(0);
    expect(new TextDecoder().decode(mock.bytesAt("/target.txt"))).toBe("old");
    expect(provider.capabilities.has("atomicReplace")).toBe(false);
  });

  it("atomicReplace is declared only after the first replacing rename succeeds on the channel", async () => {
    const { mock, provider } = setup({ posixRename: true });
    mock.seedFile("/target.txt", "old");
    const session = await provider.openWrite(at("target.txt"), signal());
    await session.write(0n, new TextEncoder().encode("new"), signal());
    expect(provider.capabilities.has("atomicReplace")).toBe(false);
    await session.commit({ replace: true, expectTarget: null }, signal());
    expect(provider.capabilities.has("atomicReplace")).toBe(true);
    expect(new TextDecoder().decode(mock.bytesAt("/target.txt"))).toBe("new");
  });

  it("commit without replace fails with already_exists when the target exists", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/target.txt", "old");
    const session = await provider.openWrite(at("target.txt"), signal());
    await session.write(0n, new TextEncoder().encode("new"), signal());
    await expectCode(session.commit({ replace: false, expectTarget: null }, signal()), "already_exists");
    expect(new TextDecoder().decode(mock.bytesAt("/target.txt"))).toBe("old");
  });

  it("a replacing commit whose expectTarget no longer matches reports changed_since_plan", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/target.txt", "old");
    const session = await provider.openWrite(at("target.txt"), signal());
    await session.write(0n, new TextEncoder().encode("new"), signal());
    await expectCode(
      session.commit({ replace: true, expectTarget: { size: "99", mtimeNs: "1795790479000000000" } }, signal()),
      "changed_since_plan",
    );
    expect(new TextDecoder().decode(mock.bytesAt("/target.txt"))).toBe("old");
  });

  it("a replacing commit with a fingerprint while the target is absent reports changed_since_plan", async () => {
    const { provider } = setup();
    const session = await provider.openWrite(at("gone.txt"), signal());
    await session.write(0n, new TextEncoder().encode("new"), signal());
    await expectCode(
      session.commit({ replace: true, expectTarget: { size: "3", mtimeNs: "1795790479000000000" } }, signal()),
      "changed_since_plan",
    );
  });
});

describe("writes", () => {
  it("stages in a temporary file beside the target, at tempPath, and renames it on commit", async () => {
    const { mock, provider } = setup();
    const session = await provider.openWrite(at("dir", "report.txt"), signal());
    expect(session.tempPath.segments.slice(0, 1)).toEqual([seg("dir")]);
    const temp = session.tempPath.segments[1];
    expect("t" in temp && /^\.report\.txt\.commander-[0-9a-f-]{36}\.part$/.test(temp.t)).toBe(true);

    mock.seedDir("/dir");
    await session.write(0n, new TextEncoder().encode("abc"), signal());
    expect(mock.exists(`/dir/${(temp as { t: string }).t}`)).toBe(true);
    expect(mock.exists("/dir/report.txt")).toBe(false);

    await session.commit({ replace: false, expectTarget: null }, signal());
    expect(mock.exists(`/dir/${(temp as { t: string }).t}`)).toBe(false);
    expect(new TextDecoder().decode(mock.bytesAt("/dir/report.txt"))).toBe("abc");
  });

  it("a file of 5 MiB goes in two chunks: exclusive at 0, then existing at 4194304", async () => {
    const { mock, provider } = setup();
    const session = await provider.openWrite(at("big.bin"), signal());
    await session.write(0n, new Uint8Array(5 * MIB), signal());
    await session.commit({ replace: false, expectTarget: null }, signal());
    const writes = mock.calls
      .filter((c) => c.method === "hub_sftp_op" && (c.input as { op: string }).op === "write")
      .map((c) => c.input as { offset: string; create: string });
    expect(writes.map((w) => [w.offset, w.create])).toEqual([
      ["0", "exclusive"],
      ["4194304", "existing"],
    ]);
    expect(mock.bytesAt("/big.bin")?.byteLength).toBe(5 * MIB);
  });

  it("abort removes the temporary file and can be called again", async () => {
    const { mock, provider } = setup();
    const session = await provider.openWrite(at("tmp.txt"), signal());
    await session.write(0n, new Uint8Array([1]), signal());
    await session.abort();
    await session.abort();
    const temp = session.tempPath.segments[0];
    expect("t" in temp && mock.exists(`/${temp.t}`)).toBe(false);
  });
});

describe("remote errors", () => {
  const codes = Object.keys(SFTP_REFUSALS) as SftpRefusalCode[];
  it.each(codes)("refusal %s never leaks a key path, .ssh or Keychain text into the message", async (code) => {
    const { provider } = setup({ failNext: code });
    const error = await provider.list(at("x"), { cursor: null, limit: 10 }, signal()).then(
      () => null,
      (caught: unknown) => caught,
    );
    if (error === null) return;
    expect(error).toBeInstanceOf(CommanderError);
    const text = (error as CommanderError).message;
    for (const forbidden of ["identityFile", ".ssh/", "Keychain"]) expect(text).not.toContain(forbidden);
  });

  it("an extra password field in a reply is a ZodError, not a silent pass", async () => {
    const { provider } = setup({ leakField: "password" });
    await expect(provider.list(at(), { cursor: null, limit: 10 }, signal())).rejects.toBeInstanceOf(ZodError);
  });
});

describe("channel lifecycle", () => {
  it("close sends hub_sftp_close for the open channel once", async () => {
    const { mock, provider } = setup();
    await provider.stat(at("x"), signal());
    await provider.close();
    expect(mock.opCount("close")).toBe(1);
    expect(mock.channelAlive()).toBe(false);
  });
});
