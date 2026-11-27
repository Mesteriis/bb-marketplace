import { describe, expect, it } from "vitest";
import type { ErrorCode } from "../../core/errors.ts";
import { CommanderError } from "../../core/errors.ts";
import type { Endpoint } from "../../core/model.ts";
import type { NameSegment, ResourcePath } from "../../core/path.ts";
import { REMOTE_HUB_SFTP_CONTRACT, SFTP_REFUSALS, type SftpRefusalCode, type SftpPath } from "../../core/wire/remote-hub-sftp.ts";
import { createSftpProvider, type SftpProvider, type SftpWriteSession } from "./sftp-provider.ts";
import { RemoteHubMock, type RemoteHubMockOptions } from "./testing/remote-hub-mock.ts";

const PROFILE = "5b568675-f842-4a96-83e0-78ae53d96024";
const MIB = 1024 * 1024;
const LEAK = "identityFile ~/.ssh/id_x Keychain:foo";

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
/** The caller-chosen temp name every test session uses unless it passes its own (contract C4). */
const DEFAULT_TEMP: NameSegment = { t: ".commander-test.part" };

function openWrite(provider: SftpProvider, target: ResourcePath, sig: AbortSignal, tempName: NameSegment = DEFAULT_TEMP) {
  return provider.openWrite(target, { tempName }, sig);
}

const signal = () => new AbortController().signal;
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | undefined) => (data === undefined ? undefined : new TextDecoder().decode(data));

function setup(options: RemoteHubMockOptions = {}) {
  const mock = new RemoteHubMock({ consent: "granted", level: "write", hostKey: "trusted", ...options });
  const provider = createSftpProvider({ port: mock, profileId: PROFILE, endpoint });
  return { mock, provider };
}

/** Rejects with the error; fails the test if the call succeeds. */
async function failureOf(promise: Promise<unknown>): Promise<CommanderError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a CommanderError, got success");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CommanderError);
  return error as CommanderError;
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode): Promise<CommanderError> {
  const error = await failureOf(promise);
  expect(error.code).toBe(code);
  return error;
}

/** The temporary file's name; sessions in these tests write into the root. */
function tempName(session: SftpWriteSession): string {
  const last = session.tempPath.segments.at(-1);
  if (last === undefined || !("t" in last)) throw new Error("temp name is not text");
  return last.t;
}

describe("contract and capabilities", () => {
  it("exports the contract id it mirrors and declares only the stage-one capabilities", () => {
    expect(REMOTE_HUB_SFTP_CONTRACT).toBe("remote-hub@ea8e3bfa");
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
    expect(mock.opCount("op:list")).toBe(0);
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
    expect(mock.opCount("op:stat")).toBe(0);
  });

  it("host key changed is host_key_rejected and no operation is sent", async () => {
    const { mock, provider } = setup({ hostKey: "changed" });
    await expectCode(provider.stat(at("etc"), signal()), "host_key_rejected");
    expect(mock.opCount("op:stat")).toBe(0);
  });

  it("access refused by the server is permission_denied", async () => {
    const { provider } = setup({ failNext: "permission_denied" });
    await expectCode(provider.list(at("root"), { cursor: null, limit: 10 }, signal()), "permission_denied");
  });

  it("a channel that cannot be opened is connection_failed, retryable, and sends no operation", async () => {
    const { mock, provider } = setup({ openFailure: "unreachable" });
    const error = await expectCode(provider.list(at(), { cursor: null, limit: 10 }, signal()), "connection_failed");
    expect(error.retryable).toBe(true);
    expect(mock.opCount("op:list")).toBe(0);
  });

  it("a read that hits a connection error is connection_failed and retryable", async () => {
    const { provider } = setup({ failNext: "unreachable" });
    const error = await expectCode(provider.list(at(), { cursor: null, limit: 10 }, signal()), "connection_failed");
    expect(error.retryable).toBe(true);
  });
});

describe("ambiguous outcome of a mutation (a transport failure after sending)", () => {
  it("a dropped connection after a write applied is outcome_unknown, not retryable, and not repeated", async () => {
    const { mock, provider } = setup();
    const session = await openWrite(provider, at("f.txt"), signal());
    mock.arm("drop");
    const error = await expectCode(session.write(0n, bytes("abc"), signal()), "outcome_unknown");
    expect(error.retryable).toBe(false);
    expect(mock.opCount("op:write")).toBe(2);
    expect(mock.exists(`/${tempName(session)}`)).toBe(true);
  });

  it("a dropped connection after a rename applied is outcome_unknown", async () => {
    const { mock, provider } = setup({ faultNext: "drop" });
    mock.seedFile("/a.txt", "a");
    await expectCode(provider.rename(at("a.txt"), at("b.txt"), { replace: false }, signal()), "outcome_unknown");
    expect(mock.exists("/b.txt")).toBe(true);
    expect(mock.exists("/a.txt")).toBe(false);
  });

  it("a dropped connection after a remove applied is outcome_unknown", async () => {
    const { mock, provider } = setup({ faultNext: "drop" });
    mock.seedFile("/a.txt", "a");
    await expectCode(provider.remove(at("a.txt"), { kind: "file" }, signal()), "outcome_unknown");
    expect(mock.exists("/a.txt")).toBe(false);
  });

  it("a dropped connection after a mkdir applied is outcome_unknown", async () => {
    const { mock, provider } = setup({ faultNext: "drop" });
    await expectCode(provider.mkdir(at("d"), signal()), "outcome_unknown");
    expect(mock.exists("/d")).toBe(true);
  });

  it.each(["unreachable", "failure", "channel_closed"] as const)("a creating write refused with %s is outcome_unknown from openWrite", async (code) => {
    const { provider } = setup({ failAll: code });
    const error = await expectCode(openWrite(provider, at("f.txt"), signal()), "outcome_unknown");
    expect(error.retryable).toBe(false);
  });

  it("a definitive refusal on the creating write keeps its own code", async () => {
    const { provider } = setup({ failAll: "permission_denied" });
    await expectCode(openWrite(provider, at("f.txt"), signal()), "permission_denied");
  });

});

describe("temporary file after an uncertain or refused creation", () => {
  it("a creation refused with exists is already_exists from openWrite, and no removal is sent", async () => {
    const { mock, provider } = setup({ failNext: "exists" });
    await expectCode(openWrite(provider, at("f.txt"), signal()), "already_exists");
    expect(mock.opCount("op:remove")).toBe(0);
  });

  it("an unknown outcome of the creation leaves no session, and nothing is removed", async () => {
    const { mock, provider } = setup({ faultNext: "drop" });
    await expectCode(openWrite(provider, at("f.txt"), signal()), "outcome_unknown");
    expect(mock.opCount("op:remove")).toBe(0);
    expect(mock.exists("/.commander-test.part")).toBe(true);
  });

  it("abort of a fresh session removes the empty temp it created", async () => {
    const { mock, provider } = setup();
    const session = await openWrite(provider, at("f.txt"), signal());
    await session.abort();
    expect(mock.opCount("op:remove")).toBe(1);
    expect(mock.exists("/.commander-test.part")).toBe(false);
  });

});

describe("cancellation", () => {
  it("an already aborted signal is cancelled before anything is sent", async () => {
    const { mock, provider } = setup();
    const aborted = new AbortController();
    aborted.abort();
    await expectCode(provider.list(at(), { cursor: null, limit: 10 }, aborted.signal), "cancelled");
    expect(mock.opCount("op:list")).toBe(0);
  });

  it("an aborted write before sending is cancelled and sends no write", async () => {
    const { mock, provider } = setup();
    const session = await openWrite(provider, at("f.txt"), signal());
    const before = mock.opCount("op:write");
    const aborted = new AbortController();
    aborted.abort();
    await expectCode(session.write(0n, bytes("abc"), aborted.signal), "cancelled");
    expect(mock.opCount("op:write")).toBe(before);
  });

  it("an abort during a read is cancelled", async () => {
    const { mock, provider } = setup({ faultNext: "abort" });
    mock.seedFile("/x.txt", "abc");
    await expectCode(provider.read(at("x.txt"), 0n, 3, null, signal()), "cancelled");
  });

  it("an AbortError from the port during a mutation is outcome_unknown", async () => {
    const { mock, provider } = setup();
    const session = await openWrite(provider, at("f.txt"), signal());
    mock.arm("abort");
    await expectCode(session.write(0n, bytes("abc"), signal()), "outcome_unknown");
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

  it("a listing page is continued by its cursor", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/a1", "");
    mock.seedFile("/a2", "");
    mock.seedFile("/a3", "");
    const first = await provider.list(at(), { cursor: null, limit: 2 }, signal());
    expect(first.entries.map((e) => e.name)).toEqual([{ t: "a1" }, { t: "a2" }]);
    expect(first.cursor).toBe("2");
    const second = await provider.list(at(), { cursor: first.cursor, limit: 2 }, signal());
    expect(second.entries.map((e) => e.name)).toEqual([{ t: "a3" }]);
    expect(second.cursor).toBeNull();
  });

  it("a directory with more than 10000 entries is limit_exceeded, not a silent cut", async () => {
    const { provider } = setup({ dirSize: 10_001 });
    await expectCode(provider.list(at("big"), { cursor: null, limit: 1000 }, signal()), "limit_exceeded");
  });

  it("a hidden name given as bytes is hidden", async () => {
    const { mock, provider } = setup();
    // The root holds the two raw bytes 0x2E 0xFF: "." followed by an invalid UTF-8 byte.
    mock.seedFile(new Uint8Array([0x2f, 0x2e, 0xff]), "raw");
    const page = await provider.list({ segments: [] }, { cursor: null, limit: 100 }, signal());
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ name: { b: "Lv8=" }, hidden: true });
  });

  it("stat of the root names it with the valid segment t:root", async () => {
    const { provider } = setup();
    const entry = await provider.stat({ segments: [] }, signal());
    expect(entry).toMatchObject({ name: { t: "root" }, kind: "dir" });
  });

  it("a byte name from the server is a {b} segment and the same bytes go back into a rename", async () => {
    const { mock, provider } = setup();
    // The server holds the single raw byte 0xFF under the root: wire path "/" + 0xFF.
    mock.seedFile(new Uint8Array([0x2f, 0xff]), "old");
    const page = await provider.list({ segments: [] }, { cursor: null, limit: 100 }, signal());
    const raw = page.entries.find((e) => "b" in e.name);
    expect(raw?.name).toEqual({ b: "/w==" });

    const session = await openWrite(provider, { segments: [raw!.name] }, signal());
    await session.write(0n, bytes("x"), signal());
    await session.commit({ replace: true, expectTarget: null }, signal());
    const rename = mock.calls.filter((c) => c.method === "hub_sftp_op" && (c.input as { op: string }).op === "rename").at(-1)?.input as { to: unknown };
    expect(rename.to).toEqual({ bytes: "L/8=" });
    expect(text(mock.bytesAt(new Uint8Array([0x2f, 0xff])))).toBe("x");
  });
});

describe("hostile names from the server", () => {
  it(". and .. are skipped; an ordinary name is kept", async () => {
    const { provider } = setup({ extraNames: [{ text: "." }, { text: ".." }, { text: "ok.txt" }] });
    const page = await provider.list(at(), { cursor: null, limit: 100 }, signal());
    expect(page.entries.map((e) => e.name)).toEqual([{ t: "ok.txt" }]);
  });

  it.each([
    ["a name with a slash", [{ text: "a/b" }]],
    ["a name over 1024 characters", [{ text: "x".repeat(1025) }]],
    ["a name with a NUL", [{ text: "a\u0000b" }]],
    ["a raw name with a slash", [{ bytes: Buffer.from([0x61, 0x2f, 0xff]).toString("base64") }]],
  ] as const)("%s is internal and its text is not echoed", async (_label, names) => {
    const { provider } = setup({ extraNames: names as unknown as SftpPath[] });
    const error = await expectCode(provider.list(at(), { cursor: null, limit: 100 }, signal()), "internal");
    expect(error.message).toBe("Remote Hub call failed");
    expect(error.message).not.toContain("a/b");
    expect(error.message).not.toContain("xxxx");
  });
});

describe("reads", () => {
  it("reads 9 MiB in chunks of at most 4 MiB at offsets 0, 4194304 and 8388608", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/big.bin", new Uint8Array(9 * MIB));
    const data = await provider.read(at("big.bin"), 0n, 9 * MIB, null, signal());
    expect(data.byteLength).toBe(9 * MIB);
    const reads = mock.calls
      .filter((c) => c.method === "hub_sftp_op" && (c.input as { op: string }).op === "read")
      .map((c) => c.input as { offset: string; length: number });
    expect(reads.map((r) => r.offset)).toEqual(["0", "4194304", "8388608"]);
    expect(reads.map((r) => r.length)).toEqual([4194304, 4194304, 1048576]);
  });

  it("a chunk longer than asked is internal", async () => {
    const { mock, provider } = setup({ readFault: "oversize" });
    mock.seedFile("/x.txt", "abc");
    await expectCode(provider.read(at("x.txt"), 0n, 10, null, signal()), "internal");
  });

  it("an empty chunk without eof is internal, not a silent loop", async () => {
    const { mock, provider } = setup({ readFault: "empty-no-eof" });
    mock.seedFile("/x.txt", "abc");
    await expectCode(provider.read(at("x.txt"), 0n, 10, null, signal()), "internal");
  });

  it("a read after revocation fails with consent_required and does not reopen the channel", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/x.txt", "abc");
    await provider.stat(at("x.txt"), signal());
    mock.revoke();
    await expectCode(provider.read(at("x.txt"), 0n, 3, null, signal()), "consent_required");
    expect(mock.opCount("open")).toBe(1);
  });

  it("with expect that matches, the read returns the bytes", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/x.txt", "abc");
    const data = await provider.read(at("x.txt"), 0n, 3, { size: "3", mtimeNs: "1795790479000000000" }, signal());
    expect(text(data)).toBe("abc");
    expect(mock.opCount("op:read")).toBe(1);
  });

  it("with expect whose mtime changed, the read is changed_since_plan and sends no read", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/x.txt", "abc");
    mock.setMtime("/x.txt", 1795790480);
    const before = mock.opCount("op:read");
    await expectCode(provider.read(at("x.txt"), 0n, 3, { size: "3", mtimeNs: "1795790479000000000" }, signal()), "changed_since_plan");
    expect(mock.opCount("op:read")).toBe(before);
  });

  it("with expect whose file disappeared, the read is changed_since_plan and sends no read", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/x.txt", "abc");
    await provider.remove(at("x.txt"), { kind: "file" }, signal());
    const before = mock.opCount("op:read");
    await expectCode(provider.read(at("x.txt"), 0n, 3, { size: "3", mtimeNs: "1795790479000000000" }, signal()), "changed_since_plan");
    expect(mock.opCount("op:read")).toBe(before);
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

  it("a creating write across a restart is outcome_unknown from openWrite, and not repeated", async () => {
    const { mock, provider } = setup({ generationBumpAfter: 2 });
    mock.seedFile("/a.txt", "a");
    await provider.stat(at("a.txt"), signal());
    await provider.stat(at("a.txt"), signal());
    await expectCode(openWrite(provider, at("new.txt"), signal()), "outcome_unknown");
    expect(mock.opCount("op:write")).toBe(1);
    expect(mock.opCount("open")).toBe(1);
  });

  it("after a second channel_closed on an idempotent read, the retry stops with connection_failed", async () => {
    const { mock, provider } = setup({ failAll: "channel_closed" });
    await expectCode(provider.list(at(), { cursor: null, limit: 10 }, signal()), "connection_failed");
    expect(mock.opCount("open")).toBe(2);
    expect(mock.opCount("op:list")).toBe(2);
  });
});

describe("atomic replace", () => {
  it("without posix-rename, commit with replace is unsupported, not a remove and rename", async () => {
    const { mock, provider } = setup({ posixRename: false });
    mock.seedFile("/target.txt", "old");
    const session = await openWrite(provider, at("target.txt"), signal());
    await session.write(0n, bytes("new"), signal());
    await expectCode(session.commit({ replace: true, expectTarget: null }, signal()), "unsupported");
    expect(mock.opCount("op:remove")).toBe(0);
    expect(text(mock.bytesAt("/target.txt"))).toBe("old");
    expect(provider.capabilities.has("atomicReplace")).toBe(false);
  });

  it("an overwrite rename is unsupported without posix-rename even when the target is absent", async () => {
    const { mock, provider } = setup({ posixRename: false });
    mock.seedFile("/a.txt", "a");
    await expectCode(provider.rename(at("a.txt"), at("absent.txt"), { replace: true }, signal()), "unsupported");
    expect(mock.exists("/a.txt")).toBe(true);
  });

  it("a replacing rename onto an absent target does not declare atomicReplace", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/a.txt", "a");
    await provider.rename(at("a.txt"), at("absent.txt"), { replace: true }, signal());
    expect(provider.capabilities.has("atomicReplace")).toBe(false);
  });

  it("atomicReplace is declared only after the first replacing rename of an existing target succeeds", async () => {
    const { mock, provider } = setup({ posixRename: true });
    mock.seedFile("/target.txt", "old");
    const session = await openWrite(provider, at("target.txt"), signal());
    await session.write(0n, bytes("new"), signal());
    expect(provider.capabilities.has("atomicReplace")).toBe(false);
    await session.commit({ replace: true, expectTarget: null }, signal());
    expect(provider.capabilities.has("atomicReplace")).toBe(true);
    expect(text(mock.bytesAt("/target.txt"))).toBe("new");
  });

  it("closing the channel withdraws atomicReplace", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/target.txt", "old");
    mock.seedFile("/src.txt", "new");
    await provider.rename(at("src.txt"), at("target.txt"), { replace: true }, signal());
    expect(provider.capabilities.has("atomicReplace")).toBe(true);
    await provider.close();
    expect(provider.capabilities.has("atomicReplace")).toBe(false);
  });

  it("a rename whose reply is for another operation is outcome_unknown, not retryable", async () => {
    const { mock, provider } = setup({ misreply: true });
    mock.seedFile("/a.txt", "a");
    const error = await expectCode(provider.rename(at("a.txt"), at("b.txt"), { replace: false }, signal()), "outcome_unknown");
    expect(error.retryable).toBe(false);
  });

  it("a creating write whose reply is for another operation is outcome_unknown from openWrite", async () => {
    const { provider } = setup({ misreply: true });
    await expectCode(openWrite(provider, at("f.txt"), signal()), "outcome_unknown");
  });

  it("a read whose reply is for another operation is internal", async () => {
    const { mock, provider } = setup({ misreply: true });
    mock.seedFile("/x.txt", "abc");
    await expectCode(provider.read(at("x.txt"), 0n, 3, null, signal()), "internal");
  });

  it("a listing whose reply is for another operation is internal", async () => {
    const { provider } = setup({ misreply: true });
    await expectCode(provider.list(at(), { cursor: null, limit: 10 }, signal()), "internal");
  });

  it("commit without replace fails with already_exists when the target exists", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/target.txt", "old");
    const session = await openWrite(provider, at("target.txt"), signal());
    await session.write(0n, bytes("new"), signal());
    await expectCode(session.commit({ replace: false, expectTarget: null }, signal()), "already_exists");
    expect(text(mock.bytesAt("/target.txt"))).toBe("old");
  });

  it("a replacing commit whose expectTarget no longer matches reports changed_since_plan", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/target.txt", "old");
    const session = await openWrite(provider, at("target.txt"), signal());
    await session.write(0n, bytes("new"), signal());
    await expectCode(
      session.commit({ replace: true, expectTarget: { size: "99", mtimeNs: "1795790479000000000" } }, signal()),
      "changed_since_plan",
    );
    expect(text(mock.bytesAt("/target.txt"))).toBe("old");
  });

  it("a replacing commit with a fingerprint while the target is absent reports changed_since_plan", async () => {
    const { provider } = setup();
    const session = await openWrite(provider, at("gone.txt"), signal());
    await session.write(0n, bytes("new"), signal());
    await expectCode(
      session.commit({ replace: true, expectTarget: { size: "3", mtimeNs: "1795790479000000000" } }, signal()),
      "changed_since_plan",
    );
  });

  it("when the rename landed but the final stat fails, commit is outcome_unknown", async () => {
    const { mock, provider } = setup({ statFailsAfterRename: true });
    const session = await openWrite(provider, at("landed.txt"), signal());
    await session.write(0n, bytes("abc"), signal());
    await expectCode(session.commit({ replace: false, expectTarget: null }, signal()), "outcome_unknown");
    expect(text(mock.bytesAt("/landed.txt"))).toBe("abc");
  });
});

describe("writes", () => {
  it("stages in the caller's temp name, exactly at parent(target) + tempName, and renames it on commit", async () => {
    const { mock, provider } = setup();
    mock.seedDir("/dir");
    const session = await openWrite(provider, at("dir", "report.txt"), signal(), { t: ".report.part" });
    expect(session.tempPath).toEqual({ segments: [seg("dir"), { t: ".report.part" }] });

    await session.write(0n, bytes("abc"), signal());
    expect(mock.exists("/dir/.report.part")).toBe(true);
    expect(mock.exists("/dir/report.txt")).toBe(false);

    await session.commit({ replace: false, expectTarget: null }, signal());
    expect(mock.exists("/dir/.report.part")).toBe(false);
    expect(text(mock.bytesAt("/dir/report.txt"))).toBe("abc");
  });

  it("a temp name already taken is already_exists from openWrite, and the file there is not overwritten", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/.taken", "keep");
    await expectCode(openWrite(provider, at("f.txt"), signal(), { t: ".taken" }), "already_exists");
    expect(text(mock.bytesAt("/.taken"))).toBe("keep");
  });

  it("a temp name that is not a valid segment is invalid_name, and nothing is sent", async () => {
    const { mock, provider } = setup();
    await expectCode(openWrite(provider, at("f.txt"), signal(), { t: "a/b" }), "invalid_name");
    await expectCode(openWrite(provider, at("f.txt"), signal(), { t: "x".repeat(1025) }), "invalid_name");
    expect(mock.calls).toHaveLength(0);
  });

  it("a temp name equal to the target's own name is invalid_name", async () => {
    const { provider } = setup();
    await expectCode(openWrite(provider, at("f.txt"), signal(), { t: "f.txt" }), "invalid_name");
  });

  it("a 1000-character target commits from a short caller temp name", async () => {
    const { mock, provider } = setup();
    const name = "n".repeat(1000);
    const session = await openWrite(provider, at(name), signal(), { t: ".n.part" });
    await session.write(0n, bytes("abc"), signal());
    await session.commit({ replace: false, expectTarget: null }, signal());
    expect(text(mock.bytesAt(`/${name}`))).toBe("abc");
  });

  it("committing an empty file creates it with zero bytes", async () => {
    const { mock, provider } = setup();
    const session = await openWrite(provider, at("empty.txt"), signal());
    await session.commit({ replace: false, expectTarget: null }, signal());
    expect(mock.exists("/empty.txt")).toBe(true);
    expect(mock.bytesAt("/empty.txt")?.byteLength).toBe(0);
  });

  it("a file of 5 MiB: the empty creation, then two chunks at 0 and 4194304", async () => {
    const { mock, provider } = setup();
    const session = await openWrite(provider, at("big.bin"), signal());
    await session.write(0n, new Uint8Array(5 * MIB), signal());
    await session.commit({ replace: false, expectTarget: null }, signal());
    const writes = mock.calls
      .filter((c) => c.method === "hub_sftp_op" && (c.input as { op: string }).op === "write")
      .map((c) => c.input as { offset: string; create: string });
    expect(writes.map((w) => [w.offset, w.create])).toEqual([
      ["0", "exclusive"],
      ["0", "existing"],
      ["4194304", "existing"],
    ]);
    expect(mock.bytesAt("/big.bin")?.byteLength).toBe(5 * MIB);
  });

  it("abort removes the temporary file and can be called again", async () => {
    const { mock, provider } = setup();
    const session = await openWrite(provider, at("tmp.txt"), signal());
    await session.write(0n, new Uint8Array([1]), signal());
    await session.abort();
    await session.abort();
    expect(mock.exists(`/${tempName(session)}`)).toBe(false);
  });

  it("mkdir, rename and remove of the provider behave as the server answers", async () => {
    const { mock, provider } = setup();
    await provider.mkdir(at("d"), signal());
    expect(mock.exists("/d")).toBe(true);
    await expectCode(provider.mkdir(at("d"), signal()), "already_exists");

    mock.seedFile("/a.txt", "a");
    mock.seedFile("/b.txt", "b");
    await expectCode(provider.rename(at("a.txt"), at("b.txt"), { replace: false }, signal()), "already_exists");
    await provider.rename(at("a.txt"), at("c.txt"), { replace: false }, signal());
    expect(mock.exists("/a.txt")).toBe(false);
    expect(mock.exists("/c.txt")).toBe(true);
  });

  it("remove refuses a non-empty directory with is_a_directory and a kind mismatch with permission_denied", async () => {
    const { mock, provider } = setup();
    await provider.mkdir(at("d"), signal());
    mock.seedFile("/d/x", "x");
    await expectCode(provider.remove(at("d"), { kind: "dir" }, signal()), "is_a_directory");
    await expectCode(provider.remove(at("d"), { kind: "file" }, signal()), "permission_denied");
    expect(mock.exists("/d")).toBe(true);
  });
});

describe("error mapping", () => {
  // Literal mapping of each Remote Hub refusal code: code, Commander error code, retryable.
  const TABLE: ReadonlyArray<readonly [SftpRefusalCode, ErrorCode, boolean]> = [
    ["caller_not_plugin", "permission_denied", false],
    ["consent_required", "consent_required", false],
    ["consent_revoked", "consent_required", false],
    ["host_key_unknown", "host_key_rejected", false],
    ["host_key_changed", "host_key_rejected", false],
    ["permission_denied", "permission_denied", false],
    ["profile_not_found", "unsupported", false],
    ["channel_closed", "connection_failed", true],
    ["no_such_file", "not_found", false],
    ["profile_not_sftp", "unsupported", false],
    ["limit_exceeded", "limit_exceeded", false],
    ["invalid_path", "invalid_path", false],
    ["profile_needs_config", "unsupported", false],
    ["agent_unavailable", "auth_failed", false],
    ["keychain_locked", "auth_failed", false],
    ["keychain_needs_approval", "auth_failed", false],
    ["credential_missing", "auth_failed", false],
    ["auth_failed", "auth_failed", false],
    ["unreachable", "connection_failed", true],
    ["exists", "already_exists", false],
    ["not_empty", "is_a_directory", false],
    ["unsupported", "unsupported", false],
    ["failure", "internal", false],
  ];

  it("the table covers every refusal code of the contract", () => {
    expect(TABLE.map(([code]) => code).sort()).toEqual(Object.keys(SFTP_REFUSALS).sort());
    expect(TABLE).toHaveLength(23);
  });

  it.each(TABLE)("refusal %s on a read is %s (retryable %s), with no leaked text", async (code, expected, retryable) => {
    const { provider } = setup({ failAll: code, refusalDetail: LEAK });
    const error = await expectCode(provider.list(at(), { cursor: null, limit: 10 }, signal()), expected);
    expect(error.retryable).toBe(retryable);
    for (const marker of ["identityFile", ".ssh/", "Keychain"]) {
      expect(error.message).not.toContain(marker);
      expect(error.toShape().message).not.toContain(marker);
    }
  });

  it("a refusal's detail text never reaches the caller, even on a failed auth", async () => {
    const { provider } = setup({ failNext: "auth_failed", refusalDetail: LEAK });
    const error = await expectCode(provider.list(at(), { cursor: null, limit: 10 }, signal()), "auth_failed");
    expect(error.message).toBe("Sign-in to the SFTP server failed");
  });

  it("a mkdir whose reply carries an extra field is outcome_unknown, and the directory was applied", async () => {
    const { mock, provider } = setup({ leakField: "password" });
    const error = await expectCode(provider.mkdir(at("d"), signal()), "outcome_unknown");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("The outcome of the operation is unknown");
    expect(error.message).not.toContain("password");
    expect(mock.exists("/d")).toBe(true);
  });

  it("a rename whose reply carries an extra field is outcome_unknown, and the rename was applied", async () => {
    const { mock, provider } = setup({ leakField: "password" });
    mock.seedFile("/a.txt", "a");
    const error = await expectCode(provider.rename(at("a.txt"), at("b.txt"), { replace: false }, signal()), "outcome_unknown");
    expect(error.retryable).toBe(false);
    expect(error.toShape().message).not.toContain("hunter2");
    expect(mock.exists("/b.txt")).toBe(true);
  });

  it("a full 4 MiB write chunk goes through the schema in one call (after the creation)", async () => {
    const { mock, provider } = setup();
    const session = await openWrite(provider, at("full.bin"), signal());
    await session.write(0n, new Uint8Array(4 * MIB), signal());
    await session.commit({ replace: false, expectTarget: null }, signal());
    expect(mock.opCount("op:write")).toBe(2);
    expect(mock.bytesAt("/full.bin")?.byteLength).toBe(4 * MIB);
  });

  it("a reply with a field the schema does not allow is internal, with no field name in the message", async () => {
    const { provider } = setup({ leakField: "password" });
    const error = await expectCode(provider.list(at(), { cursor: null, limit: 10 }, signal()), "internal");
    expect(error.message).toBe("Remote Hub call failed");
    expect(error.message).not.toContain("password");
    expect(error.message).not.toContain("hunter2");
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

describe("expected target and expected entry (S3 contract)", () => {
  // 3 bytes, mtime 1795790479: the fingerprint of "abc" as stat reports it.
  const SIZE3 = { size: "3", mtimeNs: "1795790479000000000" };

  it("rename with an expected fingerprint that does not match is changed_since_plan, and no rename is sent", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/a.txt", "a");
    mock.seedFile("/t.txt", "old!");
    await expectCode(provider.rename(at("a.txt"), at("t.txt"), { replace: true, expectTarget: SIZE3 }, signal()), "changed_since_plan");
    expect(mock.opCount("op:rename")).toBe(0);
    expect(text(mock.bytesAt("/t.txt"))).toBe("old!");
  });

  it("rename with a matching expected fingerprint replaces the target", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/a.txt", "a");
    mock.seedFile("/t.txt", "abc");
    await provider.rename(at("a.txt"), at("t.txt"), { replace: true, expectTarget: SIZE3 }, signal());
    expect(text(mock.bytesAt("/t.txt"))).toBe("a");
    expect(mock.exists("/a.txt")).toBe(false);
  });

  it("rename expecting absence onto an existing target is changed_since_plan, and nothing is overwritten", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/a.txt", "a");
    mock.seedFile("/t.txt", "abc");
    await expectCode(provider.rename(at("a.txt"), at("t.txt"), { replace: true, expectTarget: "absent" }, signal()), "changed_since_plan");
    expect(text(mock.bytesAt("/t.txt"))).toBe("abc");
    expect(mock.exists("/a.txt")).toBe(true);
  });

  it("rename expecting absence onto a free name succeeds", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/a.txt", "a");
    await provider.rename(at("a.txt"), at("free.txt"), { replace: false, expectTarget: "absent" }, signal());
    expect(text(mock.bytesAt("/free.txt"))).toBe("a");
  });

  it("rename expecting a fingerprint when the target is absent is changed_since_plan, with no rename sent", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/a.txt", "a");
    await expectCode(provider.rename(at("a.txt"), at("gone.txt"), { replace: true, expectTarget: SIZE3 }, signal()), "changed_since_plan");
    expect(mock.opCount("op:rename")).toBe(0);
  });

  it("remove with an expected fingerprint that changed is changed_since_plan, and no remove is sent", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/x.txt", "abc");
    mock.setMtime("/x.txt", 1795790480);
    await expectCode(provider.remove(at("x.txt"), { kind: "file", expect: SIZE3 }, signal()), "changed_since_plan");
    expect(mock.opCount("op:remove")).toBe(0);
    expect(mock.exists("/x.txt")).toBe(true);
  });

  it("remove with a matching expected fingerprint removes the file", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/x.txt", "abc");
    await provider.remove(at("x.txt"), { kind: "file", expect: SIZE3 }, signal());
    expect(mock.exists("/x.txt")).toBe(false);
  });
});

describe("atomic replace and consent (review repair)", () => {
  it("an unknown rename outcome does not declare atomicReplace", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/a.txt", "a");
    mock.seedFile("/t.txt", "old");
    await provider.stat(at("t.txt"), signal());
    mock.arm("drop");
    await expectCode(provider.rename(at("a.txt"), at("t.txt"), { replace: true }, signal()), "outcome_unknown");
    expect(provider.capabilities.has("atomicReplace")).toBe(false);
  });

  it("consent revoked drops the channel and withdraws atomicReplace", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/a.txt", "a");
    mock.seedFile("/t.txt", "old");
    await provider.rename(at("a.txt"), at("t.txt"), { replace: true }, signal());
    expect(provider.capabilities.has("atomicReplace")).toBe(true);
    mock.revoke();
    await expectCode(provider.list(at(), { cursor: null, limit: 10 }, signal()), "consent_required");
    expect(provider.capabilities.has("atomicReplace")).toBe(false);
    expect(mock.channelAlive()).toBe(false);
  });
});

describe("abort checked before each port call (review repair)", () => {
  it("an abort while hub_sftp_open is in flight: mkdir is cancelled and nothing is mutated", async () => {
    const aborting = new AbortController();
    const { mock, provider } = setup({ onOpen: (opened) => { if (opened === 1) aborting.abort(); } });
    await expectCode(provider.mkdir(at("d"), aborting.signal), "cancelled");
    expect(mock.opCount("op:mkdir")).toBe(0);
    expect(mock.exists("/d")).toBe(false);
  });

  it("an abort during the reopen that a closed channel triggers sends no second read", async () => {
    const aborting = new AbortController();
    const { mock, provider } = setup({ failNext: "channel_closed", onOpen: (opened) => { if (opened === 2) aborting.abort(); } });
    await expectCode(provider.list(at(), { cursor: null, limit: 10 }, aborting.signal), "cancelled");
    expect(mock.opCount("op:list")).toBe(1);
  });
});

describe("empty commit checks the written count (review repair)", () => {
  it("a creation whose reply disagrees is outcome_unknown from openWrite, with no rename or remove", async () => {
    const { mock, provider } = setup({ writtenOverride: 5 });
    await expectCode(openWrite(provider, at("empty.txt"), signal()), "outcome_unknown");
    expect(mock.opCount("op:rename")).toBe(0);
    expect(mock.opCount("op:remove")).toBe(0);
  });

});

describe("shared open, reopen after abort, race with a held rename (third review)", () => {
  it("two parallel calls share one open: the aborted one is cancelled, the live one gets its result", async () => {
    const aborting = new AbortController();
    const { mock, provider } = setup();
    mock.seedFile("/x.txt", "abc");
    const first = provider.stat(at("x.txt"), aborting.signal);
    const second = provider.stat(at("x.txt"), signal());
    aborting.abort();
    await expectCode(first, "cancelled");
    expect(await second).toMatchObject({ kind: "file", size: "3" });
    expect(mock.opCount("open")).toBe(1);
  });

  it("a shared open that fails for a transport reason: the live caller gets connection_failed, not cancelled", async () => {
    const aborting = new AbortController();
    const { provider } = setup({ openTransportFault: true });
    const first = provider.stat(at("x.txt"), aborting.signal);
    const second = provider.stat(at("x.txt"), signal());
    aborting.abort();
    await expectCode(first, "cancelled");
    await expectCode(second, "connection_failed");
  });

  it("an abort during the first operation: the channel is not reopened", async () => {
    const aborting = new AbortController();
    const { mock, provider } = setup({ failNext: "channel_closed", onOperation: () => aborting.abort() });
    await expectCode(provider.list(at(), { cursor: null, limit: 10 }, aborting.signal), "cancelled");
    expect(mock.opCount("open")).toBe(1);
  });

  it("a read that finds the channel closed reopens it while a rename waits: atomicReplace is not declared", async () => {
    const { mock, provider } = setup({ holdRename: true });
    mock.seedFile("/a.txt", "a");
    mock.seedFile("/t.txt", "old");
    const renaming = provider.rename(at("a.txt"), at("t.txt"), { replace: true }, signal());
    for (let turn = 0; turn < 200 && mock.opCount("op:rename") === 0; turn++) await new Promise((done) => setTimeout(done, 0));
    expect(mock.opCount("op:rename")).toBe(1);
    mock.expireChannels();
    // The rename is applied on the server already; only its reply is held, so the read sees "a".
    expect(text(await provider.read(at("t.txt"), 0n, 1, null, signal()))).toBe("a");
    expect(mock.opCount("open")).toBe(2);
    mock.releaseHeld();
    await renaming;
    expect(provider.capabilities.has("atomicReplace")).toBe(false);
  });

  it("rename with replace false and a fingerprint expectation is internal, with no rename sent", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/a.txt", "a");
    await expectCode(
      provider.rename(at("a.txt"), at("t.txt"), { replace: false, expectTarget: { size: "3", mtimeNs: "1795790479000000000" } }, signal()),
      "internal",
    );
    expect(mock.opCount("op:rename")).toBe(0);
  });
});

describe("shared open failure with an already aborted caller (final review)", () => {
  it("a caller aborted during hub_sftp_open gets cancelled, and the shared failure is not an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const controller = new AbortController();
      const { provider } = setup({ onOpen: () => controller.abort(), openTransportFault: true });
      await expectCode(provider.stat(at("x.txt"), controller.signal), "cancelled");
      await new Promise((done) => setTimeout(done, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("temp file created before the session is returned (review C4)", () => {
  it("a taken temp name is already_exists from openWrite, the file is untouched, and nothing else is sent", async () => {
    const { mock, provider } = setup();
    mock.seedFile("/.taken", "keep");
    await expectCode(openWrite(provider, at("f.txt"), signal(), { t: ".taken" }), "already_exists");
    expect(text(mock.bytesAt("/.taken"))).toBe("keep");
    expect(mock.opCount("op:write")).toBe(1);
    expect(mock.opCount("op:remove")).toBe(0);
  });

  it("openWrite returns only after the empty temp file exists", async () => {
    const { mock, provider } = setup();
    const session = await openWrite(provider, at("f.txt"), signal(), { t: ".fresh" });
    expect(session.tempPath).toEqual({ segments: [{ t: ".fresh" }] });
    expect(mock.bytesAt("/.fresh")?.byteLength).toBe(0);
  });

  it("an unknown outcome of the creation is outcome_unknown from openWrite, and no session is returned", async () => {
    const { provider } = setup({ failAll: "unreachable" });
    await expectCode(openWrite(provider, at("f.txt"), signal()), "outcome_unknown");
  });

  it("a creation whose reply says other than 0 bytes is outcome_unknown from openWrite", async () => {
    const { mock, provider } = setup({ writtenOverride: 5 });
    await expectCode(openWrite(provider, at("f.txt"), signal()), "outcome_unknown");
    expect(mock.opCount("op:rename")).toBe(0);
  });
});

describe("temp name equal to the target under the endpoint's case rule (review C4)", () => {
  const insensitive = (mock: RemoteHubMock) =>
    createSftpProvider({ port: mock, profileId: PROFILE, endpoint: { ...endpoint, caseSensitive: false } });

  it("Report with the temp name report is invalid_name on a case-insensitive endpoint, with no call sent", async () => {
    const mock = new RemoteHubMock({ consent: "granted", level: "write", hostKey: "trusted" });
    await expectCode(openWrite(insensitive(mock), at("Report"), signal(), { t: "report" }), "invalid_name");
    expect(mock.calls).toHaveLength(0);
  });

  it("the same two names are a different file on a case-sensitive endpoint, and are accepted", async () => {
    const { provider } = setup();
    const session = await openWrite(provider, at("Report"), signal(), { t: "report" });
    expect(session.tempPath).toEqual({ segments: [{ t: "report" }] });
  });
});
