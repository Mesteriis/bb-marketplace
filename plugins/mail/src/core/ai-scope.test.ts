import { describe, expect, it } from "vitest";
import {
  AI_SCOPE_SENDERS_MAX,
  inAiScope,
  senderExcluded,
  staleScopeFolders,
  type AccountScope,
  type AiScope,
  type ScopeRow,
} from "./ai-scope.ts";

function scope(accounts: [string, AccountScope][] = [], addresses: string[] = [], domains: string[] = []): AiScope {
  return { accounts: new Map(accounts), senders: { addresses: new Set(addresses), domains: new Set(domains) } };
}

function row(overrides: Partial<ScopeRow> = {}): ScopeRow {
  return {
    accountId: "acc_1",
    folder: "INBOX",
    folderRole: "inbox",
    fromAddress: "anna@example.org",
    to: ["owner@example.com"],
    cc: [],
    threadId: "t_1",
    ...overrides,
  };
}

const none = new Set<string>();

describe("inAiScope", () => {
  it("takes every folder of an account without a rule or in mode all", () => {
    expect(inAiScope(row(), scope(), none)).toBe(true);
    expect(inAiScope(row({ folder: "Projects", folderRole: null }), scope([["acc_1", { mode: "all" }]]), none)).toBe(true);
  });

  it("leaves Spam and Trash out in every mode", () => {
    const modes: AccountScope[] = [{ mode: "all" }, { mode: "folders", folders: ["Junk", "Trash"] }, { mode: "none" }];
    for (const mode of modes) {
      for (const [folder, role] of [["Junk", "junk"], ["Trash", "trash"]] as const) {
        expect(inAiScope(row({ folder, folderRole: role }), scope([["acc_1", mode]]), none), `${mode.mode} ${folder}`).toBe(false);
      }
    }
    expect(inAiScope(row({ folder: "Junk", folderRole: "junk" }), scope(), none)).toBe(false);
  });

  it("mode none leaves the account out; chosen folders take only their paths", () => {
    expect(inAiScope(row(), scope([["acc_1", { mode: "none" }]]), none)).toBe(false);
    expect(inAiScope(row({ accountId: "acc_2" }), scope([["acc_1", { mode: "none" }]]), none)).toBe(true);
    const chosen = scope([["acc_1", { mode: "folders", folders: ["Projects"] }]]);
    expect(inAiScope(row({ folder: "Projects", folderRole: null }), chosen, none)).toBe(true);
    expect(inAiScope(row(), chosen, none)).toBe(false);
    expect(inAiScope(row({ folder: "projects", folderRole: null }), chosen, none)).toBe(false);
  });

  it("leaves out mail from, to or cc an excluded sender, and the whole conversation", () => {
    const excluded = scope([], ["boss@example.org"], ["secret.example.com"]);
    expect(inAiScope(row({ fromAddress: "Boss@Example.org" }), excluded, none)).toBe(false);
    expect(inAiScope(row({ fromAddress: "owner@example.com", to: ["boss@example.org"] }), excluded, none)).toBe(false);
    expect(inAiScope(row({ cc: ["x@secret.example.com"] }), excluded, none)).toBe(false);
    expect(inAiScope(row({ fromAddress: "x@deep.secret.example.com" }), excluded, none)).toBe(false);
    expect(inAiScope(row(), excluded, none)).toBe(true);
    expect(inAiScope(row(), excluded, new Set(["t_1"]))).toBe(false);
    expect(inAiScope(row({ threadId: null }), excluded, new Set(["t_1"]))).toBe(true);
  });
});

describe("senderExcluded", () => {
  const rules = scope([], ["anna@example.org"], ["example.com"]);
  it("matches addresses exactly and domains label-wise", () => {
    expect(senderExcluded(["anna@example.org"], rules)).toBe(true);
    expect(senderExcluded(["anna2@example.org"], rules)).toBe(false);
    expect(senderExcluded(["a@example.com"], rules)).toBe(true);
    expect(senderExcluded(["a@mail.example.com"], rules)).toBe(true);
    expect(senderExcluded(["a@badexample.com"], rules)).toBe(false);
    expect(senderExcluded(["a@example.com.evil.org"], rules)).toBe(false);
    expect(senderExcluded([], rules)).toBe(false);
    expect(senderExcluded(["not an address"], rules)).toBe(false);
  });

  it("compares domains in ASCII", () => {
    const idn = scope([], [], ["xn--e1afmkfd.xn--p1ai"]);
    expect(senderExcluded(["a@\u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444"], idn)).toBe(true);
  });
});

describe("staleScopeFolders", () => {
  it("lists chosen paths a listing no longer has; an unlisted account is all stale", () => {
    const s = scope([
      ["acc_1", { mode: "folders", folders: ["Projects", "Old"] }],
      ["acc_2", { mode: "folders", folders: ["Work"] }],
      ["acc_3", { mode: "all" }],
    ]);
    expect(staleScopeFolders(s, new Map([["acc_1", ["INBOX", "Projects"]]]))).toEqual([
      { accountId: "acc_1", path: "Old" },
      { accountId: "acc_2", path: "Work" },
    ]);
  });

  it("caps the sender list", () => {
    expect(AI_SCOPE_SENDERS_MAX).toBe(1_000);
  });
});
