import { describe, expect, it } from "vitest";
import type { Folder } from "../core/index.ts";
import { folderRows, inboxPath, readCollapsedAccounts, writeCollapsedAccounts } from "./folder-list.tsx";

function folder(path: string, overrides: Partial<Folder> = {}): Folder {
  return {
    accountId: "acc-1",
    path,
    name: path.split(/[/.]/).at(-1)!,
    specialUse: null,
    selectable: true,
    unreadCount: 0,
    totalCount: 0,
    ...overrides,
  };
}

const rows = (folders: Folder[]) =>
  folderRows(folders).map((row) => `${row.kind}:${row.folder.path}:${row.depth}`);

describe("folderRows", () => {
  it("indents the owner's folders below a drawn parent, selectable or not", () => {
    expect(
      rows([
        folder("INBOX", { specialUse: "inbox" }),
        folder("[Gmail]", { selectable: false }),
        folder("[Gmail]/Spam", { specialUse: "junk" }),
        folder("Projects", { selectable: false }),
        folder("Projects/Alpha"),
        folder("Projects/Alpha/Notes"),
        folder("Work"),
        folder("Work.Reports"),
      ]),
    ).toEqual([
      "folder:INBOX:0",
      "folder:[Gmail]/Spam:0",
      "group:Projects:0",
      "folder:Projects/Alpha:1",
      "folder:Projects/Alpha/Notes:2",
      "folder:Work:0",
      "folder:Work.Reports:1",
    ]);
  });

  it("groups only by '/' or '.' right after the parent's exact path", () => {
    expect(rows([folder("Work"), folder("Work-Old"), folder("Workshop"), folder("Work Old")])).toEqual([
      "folder:Work:0",
      "folder:Work-Old:0",
      "folder:Workshop:0",
      "folder:Work Old:0",
    ]);
  });

  it("finds the inbox path", () => {
    expect(inboxPath([folder("Inbox", { specialUse: "inbox" })])).toBe("Inbox");
    expect(inboxPath([])).toBeNull();
    expect(inboxPath(null)).toBeNull();
  });
});

describe("collapsed accounts storage", () => {
  const store = (value: string | null) => ({ getItem: () => value });

  it("is empty without storage, value, valid JSON or an array", () => {
    expect(readCollapsedAccounts(null).size).toBe(0);
    expect(readCollapsedAccounts(store(null)).size).toBe(0);
    expect(readCollapsedAccounts(store("{not json")).size).toBe(0);
    expect(readCollapsedAccounts(store('{"a":1}')).size).toBe(0);
  });

  it("keeps only string ids", () => {
    expect([...readCollapsedAccounts(store('["a", 1, null, "b"]'))]).toEqual(["a", "b"]);
  });

  it("survives a storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readCollapsedAccounts(throwing).size).toBe(0);
    expect(() => writeCollapsedAccounts(throwing, new Set(["a"]))).not.toThrow();
    expect(() => writeCollapsedAccounts(null, new Set(["a"]))).not.toThrow();
  });

  it("round-trips", () => {
    let saved: string | null = null;
    const memory = {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    };
    writeCollapsedAccounts(memory, new Set(["acc-1", "acc-2"]));
    expect([...readCollapsedAccounts(memory)].sort()).toEqual(["acc-1", "acc-2"]);
  });
});
