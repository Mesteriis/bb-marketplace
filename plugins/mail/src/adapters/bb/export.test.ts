import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImapAuthError, type FolderSession, type ImapGateway } from "../../core/ports.ts";
import { IdentityVault, InMemoryMailStore, imapError, makeStoredAccount } from "../../core/testing/fakes.ts";
import { ExportRefused, exportFolder, type ExportDeps, type ExportInput } from "./export.ts";

const NOW = new Date("2026-11-17T10:00:00.000Z");
const mail = (n: number, body = `Invented body ${n}`) =>
  new TextEncoder().encode(
    `From: Sender ${n} <sender${n}@example.com>\r\nDate: Fri, 13 Nov 2026 08:0${n}:00 +0000\r\nSubject: Invented ${n}\r\n\r\n${body}\r\n`,
  );

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "makosh-export-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(raw: Map<number, Uint8Array | "gone" | "large" | "drop">, options: { open?: Error; sinceUids?: number[] } = {}) {
  const store = new InMemoryMailStore();
  store.saveAccount(makeStoredAccount({ id: "acc_1" }));
  store.saveFolders("acc_1", [
    { path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "inbox", selectable: true, subscribed: true },
    { path: "[Gmail]", name: "[Gmail]", delimiter: "/", specialUse: null, selectable: false, subscribed: true },
  ]);
  const calls: string[] = [];
  const session = {
    uidsAfter: async (uid: number) => {
      calls.push(`uidsAfter ${uid}`);
      return [...raw.keys()].reverse();
    },
    searchSince: async (date: Date) => {
      calls.push(`searchSince ${date.toISOString()}`);
      return options.sinceUids ?? [];
    },
    fetchRaw: async (uid: number) => {
      calls.push(`fetchRaw ${uid}`);
      const entry = raw.get(uid);
      if (entry === undefined || entry === "gone") throw imapError("NotFound");
      if (entry === "large") throw imapError("TooLarge");
      if (entry === "drop") throw new Error("socket closed");
      return entry;
    },
    close: async () => {
      calls.push("close");
    },
  } as unknown as FolderSession;
  const gateway = {
    openFolder: async (_config: unknown, path: string, opened: { readOnly: boolean }) => {
      calls.push(`open ${path} readOnly=${opened.readOnly}`);
      if (options.open !== undefined) throw options.open;
      return session;
    },
  } as unknown as ImapGateway;
  const deps: ExportDeps = { store, gateway, vault: new IdentityVault(), now: () => NOW };
  const input = (overrides: Partial<ExportInput> = {}): ExportInput => ({
    accountId: "acc_1",
    folder: "INBOX",
    file: join(dir, "inbox.mbox"),
    format: "mbox",
    since: null,
    max: 100,
    ...overrides,
  });
  return { deps, input, calls, store };
}

const reasonOf = async (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => (error instanceof ExportRefused ? [error.reason, error.written] : String(error)),
  );

describe("exportFolder", () => {
  it("writes the folder as one mbox, oldest first, through a read-only session, readable by the owner only", async () => {
    const { deps, input, calls } = setup(new Map([[1, mail(1)], [2, mail(2, "From here on\r\nit goes")], [3, mail(3)]]));
    const result = await exportFolder(deps, input());
    const text = await readFile(join(dir, "inbox.mbox"), "utf8");
    expect(text).toBe(
      [
        "From sender1@example.com Fri Nov 13 08:01:00 2026",
        "From: Sender 1 <sender1@example.com>",
        "Date: Fri, 13 Nov 2026 08:01:00 +0000",
        "Subject: Invented 1",
        "",
        "Invented body 1",
        "",
        "From sender2@example.com Fri Nov 13 08:02:00 2026",
        "From: Sender 2 <sender2@example.com>",
        "Date: Fri, 13 Nov 2026 08:02:00 +0000",
        "Subject: Invented 2",
        "",
        ">From here on",
        "it goes",
        "",
        "From sender3@example.com Fri Nov 13 08:03:00 2026",
        "From: Sender 3 <sender3@example.com>",
        "Date: Fri, 13 Nov 2026 08:03:00 +0000",
        "Subject: Invented 3",
        "",
        "Invented body 3",
        "",
        "",
      ].join("\n"),
    );
    expect(result).toEqual({ messages: 3, skipped: 0, left: 0, bytes: Buffer.byteLength(text) });
    expect((await stat(join(dir, "inbox.mbox"))).mode & 0o777).toBe(0o600);
    expect(calls).toEqual(["open INBOX readOnly=true", "uidsAfter 0", "fetchRaw 1", "fetchRaw 2", "fetchRaw 3", "close"]);
  });

  it("writes .eml files into a new directory, each the message's own bytes", async () => {
    const { deps, input } = setup(new Map([[7, mail(7)], [12, mail(2)]]));
    const target = join(dir, "inbox-eml");
    const result = await exportFolder(deps, input({ file: target, format: "eml" }));
    expect(await readdir(target)).toEqual(["00000007.eml", "00000012.eml"]);
    expect(new Uint8Array(await readFile(join(target, "00000007.eml")))).toEqual(mail(7));
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    expect((await stat(join(target, "00000012.eml"))).mode & 0o777).toBe(0o600);
    expect(result).toMatchObject({ messages: 2, skipped: 0, left: 0 });
  });

  it("keeps the newest up to max and says how many were left; since asks the server by date", async () => {
    const all = new Map([1, 2, 3, 4, 5].map((n) => [n, mail(n)]));
    const newest = setup(all);
    expect(await exportFolder(newest.deps, newest.input({ max: 2 }))).toMatchObject({ messages: 2, left: 3 });
    expect(newest.calls.filter((c) => c.startsWith("fetchRaw"))).toEqual(["fetchRaw 4", "fetchRaw 5"]);
    const since = setup(all, { sinceUids: [5, 3] });
    const day = new Date("2026-11-13T00:00:00.000Z");
    expect(await exportFolder(since.deps, since.input({ since: day, file: join(dir, "since.mbox") }))).toMatchObject({ messages: 2, left: 0 });
    expect(since.calls).toContain("searchSince 2026-11-13T00:00:00.000Z");
    expect(since.calls.filter((c) => c.startsWith("fetchRaw"))).toEqual(["fetchRaw 3", "fetchRaw 5"]);
  });

  it("skips a message that is gone or too large, and stops with what it has when the connection drops", async () => {
    const skipping = setup(new Map<number, Uint8Array | "gone" | "large">([[1, mail(1)], [2, "gone"], [3, "large"], [4, mail(4)]]));
    expect(await exportFolder(skipping.deps, skipping.input())).toMatchObject({ messages: 2, skipped: 2 });
    const dropping = setup(new Map<number, Uint8Array | "drop">([[1, mail(1)], [2, "drop"], [3, mail(3)]]));
    const file = join(dir, "partial.mbox");
    expect(await reasonOf(exportFolder(dropping.deps, dropping.input({ file })))).toEqual(["connection", 1]);
    expect(await readFile(file, "utf8")).toContain("Invented body 1");
    expect(dropping.calls.at(-1)).toBe("close");
  });

  it("refuses before touching the server or the disk when it cannot work", async () => {
    const { deps, input, calls, store } = setup(new Map([[1, mail(1)]]));
    await writeFile(join(dir, "taken.mbox"), "mine");
    expect(await reasonOf(exportFolder(deps, input({ file: join(dir, "taken.mbox") })))).toEqual(["exists", 0]);
    expect(await readFile(join(dir, "taken.mbox"), "utf8")).toBe("mine");
    expect(await reasonOf(exportFolder(deps, input({ file: "inbox.mbox" })))).toEqual(["not_absolute", 0]);
    expect(await reasonOf(exportFolder(deps, input({ file: join(dir, "missing", "inbox.mbox") })))).toEqual(["no_directory", 0]);
    expect(await reasonOf(exportFolder(deps, input({ folder: "Nope" })))).toEqual(["unknown_folder", 0]);
    expect(await reasonOf(exportFolder(deps, input({ folder: "[Gmail]" })))).toEqual(["unknown_folder", 0]);
    expect(await reasonOf(exportFolder(deps, input({ accountId: "acc_nope" })))).toEqual(["unknown_folder", 0]);
    expect(await reasonOf(exportFolder({ ...deps, vault: null }, input()))).toEqual(["needs_key", 0]);
    store.saveAccount(makeStoredAccount({ id: "acc_1", authFailed: true }));
    expect(await reasonOf(exportFolder(deps, input()))).toEqual(["password", 0]);
    expect(calls).toEqual([]);
    expect(await readdir(dir)).toEqual(["taken.mbox"]);
  });

  it("a refused sign-in or an unreachable server writes nothing", async () => {
    const auth = setup(new Map(), { open: new ImapAuthError() });
    expect(await reasonOf(exportFolder(auth.deps, auth.input()))).toEqual(["password", 0]);
    const down = setup(new Map(), { open: new Error("ECONNREFUSED") });
    expect(await reasonOf(exportFolder(down.deps, down.input()))).toEqual(["connection", 0]);
    expect(await readdir(dir)).toEqual([]);
  });
});
