import { describe, expect, it } from "vitest";
import { parseThreadSubPath, parseViewSubPath, threadSubPath, viewSubPath } from "./routes.ts";

/** What the host does to a subPath before the panel receives it. */
const hostEncode = (subPath: string) => subPath.split("/").map(encodeURIComponent).join("/");

describe("thread subPath", () => {
  it("formats plain ids as they are", () => {
    expect(threadSubPath("acc-1", "t_42")).toBe("t/acc-1/t_42");
    expect(parseThreadSubPath("t/acc-1/t_42")).toEqual({ accountId: "acc-1", threadId: "t_42" });
  });

  it.each([
    ["a/b", "t/1"],
    ["100%", "50% off"],
    ["my account", "thread with spaces"],
    ["%2F", "ü?#&="],
  ])("round-trips %j / %j through the host's encoding", (accountId, threadId) => {
    const subPath = threadSubPath(accountId, threadId);
    expect(subPath.split("/")).toHaveLength(3);
    expect(parseThreadSubPath(hostEncode(subPath))).toEqual({ accountId, threadId });
  });

  it.each([
    "",
    "t",
    "t/acc-1",
    "t/acc-1/",
    "t//t_42",
    "x/acc-1/t_42",
    "t/acc-1/t_42/extra",
    "t/%E0%A4%A/t_42",
    "t/acc-1/%",
  ])("rejects %j", (subPath) => {
    expect(parseThreadSubPath(subPath)).toBeNull();
  });
});

describe("view subPath", () => {
  it("formats a merged role and an account's folder", () => {
    expect(viewSubPath({ kind: "role", role: "inbox" })).toBe("v/all/inbox");
    expect(viewSubPath({ kind: "role", role: "junk" })).toBe("v/all/junk");
    expect(viewSubPath({ kind: "folder", accountId: "acc-1", path: "INBOX" })).toBe("v/acc-1/INBOX");
  });

  it.each(["inbox", "sent", "drafts", "junk", "trash", "archive"] as const)(
    "round-trips the merged %s",
    (role) => {
      const view = { kind: "role", role } as const;
      expect(parseViewSubPath(hostEncode(viewSubPath(view)))).toEqual(view);
    },
  );

  it.each([
    ["acc-1", "INBOX"],
    ["acc-1", "[Gmail]/Spam"],
    ["acc-1", "Projects.Alpha.Notes"],
    ["acc-1", "100% done"],
    ["acc-1", "%2F literally"],
    ["my account", "Old mail/2025 Q1"],
    ["acc-1", "Входящие/Работа"],
    ["a/b", "ü?#&="],
  ])("round-trips %j / %j through the host's encoding as two segments", (accountId, path) => {
    const view = { kind: "folder", accountId, path } as const;
    const subPath = viewSubPath(view);
    expect(subPath.split("/")).toHaveLength(3);
    expect(parseViewSubPath(hostEncode(subPath))).toEqual(view);
  });

  it.each([
    "",
    "v",
    "v/all",
    "v/all/",
    "v/all/all",
    "v/all/Inbox",
    "v/acc-1",
    "v/acc-1/",
    "v//INBOX",
    "v/acc-1/INBOX/extra",
    "x/acc-1/INBOX",
    "t/acc-1/th-a",
    "v/acc-1/%E0%A4%A",
    "v/%/INBOX",
  ])("rejects %j", (subPath) => {
    expect(parseViewSubPath(subPath)).toBeNull();
  });

  it("does not take a view for a conversation link or the reverse", () => {
    expect(parseThreadSubPath(viewSubPath({ kind: "role", role: "inbox" }))).toBeNull();
    expect(parseViewSubPath(threadSubPath("acc-1", "th-a"))).toBeNull();
  });
});
