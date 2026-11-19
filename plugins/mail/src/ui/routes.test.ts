import { describe, expect, it } from "vitest";
import { draftSubPath, parseDraftSubPath, parseThreadSubPath, parseViewSubPath, parseViewTab, threadSubPath, viewSubPath, viewTabSubPath } from "./routes.ts";

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

describe("draft subPath", () => {
  it("formats a plain id as it is", () => {
    expect(draftSubPath("draft-1")).toBe("d/draft-1");
    expect(parseDraftSubPath("d/draft-1")).toBe("draft-1");
  });

  it.each(["a/b", "100%", "with spaces", "%2F", "ü?#&="])("round-trips %j through the host's encoding", (draftId) => {
    const subPath = draftSubPath(draftId);
    expect(subPath.split("/")).toHaveLength(2);
    expect(parseDraftSubPath(hostEncode(subPath))).toBe(draftId);
  });

  it.each(["", "d", "d/", "x/draft-1", "d/draft-1/extra", "d/%E0%A4%A", "t/acc-1/t_42", "v/all/inbox"])(
    "rejects %j",
    (subPath) => {
      expect(parseDraftSubPath(subPath)).toBeNull();
    },
  );

  it("is not a thread or a view", () => {
    expect(parseThreadSubPath(draftSubPath("draft-1"))).toBeNull();
    expect(parseViewSubPath(draftSubPath("draft-1"))).toBeNull();
  });
});

describe("Today and Tasks pages (slice 3f)", () => {
  it("parse and build today and tasks, nothing else", async () => {
    const { pageSubPath, parsePageSubPath, parseViewSubPath, parseThreadSubPath } = await import("./routes.ts");
    expect(parsePageSubPath(pageSubPath("today"))).toBe("today");
    expect(parsePageSubPath(pageSubPath("tasks"))).toBe("tasks");
    for (const other of ["", "today/x", "Tasks", "v/all/inbox", "t/a/b"]) expect(parsePageSubPath(other)).toBeNull();
  });

  it("parses and builds Dev and Projects (slice 3g)", async () => {
    const { pageSubPath, parsePageSubPath, projectSubPath, parseProjectSubPath } = await import("./routes.ts");
    expect(pageSubPath("dev")).toBe("dev");
    expect(parsePageSubPath("dev")).toBe("dev");
    expect(pageSubPath("projects")).toBe("p");
    expect(parsePageSubPath("p")).toBe("projects");
    const host = (path: string) => path.split("/").map(encodeURIComponent).join("/");
    expect(projectSubPath("proj/1")).toBe("p/proj%2F1");
    expect(parseProjectSubPath(host(projectSubPath("proj/1")))).toBe("proj/1");
    expect(parsePageSubPath(host(projectSubPath("p-api")))).toBe("projects");
    expect(parseProjectSubPath("p")).toBeNull();
    for (const other of ["p/a/b", "dev/x", "Dev"]) {
      expect(parseProjectSubPath(other)).toBeNull();
      expect(parsePageSubPath(other)).toBeNull();
    }
    expect(parseViewSubPath("today")).toBeNull();
    expect(parseThreadSubPath("tasks")).toBeNull();
  });
});

describe("Files and saved searches (slice 3h)", () => {
  it("parses and builds files", async () => {
    const { pageSubPath, parsePageSubPath } = await import("./routes.ts");
    expect(pageSubPath("files")).toBe("files");
    expect(parsePageSubPath("files")).toBe("files");
    for (const other of ["files/x", "Files", "file"]) expect(parsePageSubPath(other)).toBeNull();
  });

  it("parses and builds s/<id> through the host's encoding", async () => {
    const { parsePageSubPath, parseSavedSearchSubPath, parseViewSubPath, savedSearchSubPath } = await import("./routes.ts");
    expect(savedSearchSubPath("ss-1")).toBe("s/ss-1");
    expect(parseSavedSearchSubPath("s/ss-1")).toBe("ss-1");
    expect(parseSavedSearchSubPath(hostEncode(savedSearchSubPath("a/b c")))).toBe("a/b c");
    for (const other of ["", "s", "s/", "s/a/b", "x/ss-1", "files"]) expect(parseSavedSearchSubPath(other)).toBeNull();
    expect(parsePageSubPath("s/ss-1")).toBeNull();
    expect(parseViewSubPath("s/ss-1")).toBeNull();
  });
});

describe("settings addresses", () => {
  it("name the page and its section, and fall back to the first section", async () => {
    const { parsePageSubPath, parseSettingsSubPath, settingsSubPath } = await import("./routes.ts");
    expect(settingsSubPath()).toBe("settings");
    expect(settingsSubPath("ai")).toBe("settings/ai");
    expect(parseSettingsSubPath("settings")).toBe("accounts");
    expect(parseSettingsSubPath("settings/ai")).toBe("ai");
    expect(parseSettingsSubPath("settings/nope")).toBe("accounts");
    expect(parseSettingsSubPath("settings/search")).toBe("reading");
    expect(parseSettingsSubPath("settings/ai/extra")).toBeNull();
    expect(parseSettingsSubPath("today")).toBeNull();
    expect(parseSettingsSubPath("")).toBeNull();
    expect(parsePageSubPath("settings/ai")).toBe("settings");
    expect(parsePageSubPath("settings")).toBe("settings");
  });
});


describe("view subPath with an Inbox tab", () => {
  it("adds the tab after the view", () => {
    expect(viewTabSubPath({ kind: "role", role: "inbox" }, "tab-1")).toBe("v/all/inbox/s/tab-1");
    expect(viewTabSubPath({ kind: "folder", accountId: "acc-1", path: "INBOX" }, "tab-1")).toBe("v/acc-1/INBOX/s/tab-1");
    expect(viewTabSubPath({ kind: "role", role: "inbox" }, null)).toBe("v/all/inbox");
  });

  it("round-trips the view and the tab, an id with reserved characters too", () => {
    const view = { kind: "folder", accountId: "acc-1", path: "[Gmail]/Spam" } as const;
    const subPath = hostEncode(viewTabSubPath(view, "a/b c"));
    expect(subPath.split("/")).toHaveLength(5);
    expect(parseViewSubPath(subPath)).toEqual(view);
    expect(parseViewTab(subPath)).toBe("a/b c");
  });

  it("a view without a tab names none", () => {
    expect(parseViewTab("v/all/inbox")).toBeNull();
    expect(parseViewTab("t/acc-1/th-a")).toBeNull();
    expect(parseViewTab("")).toBeNull();
  });

  it("refuses another word in the tab's place, and an empty tab", () => {
    expect(parseViewSubPath("v/all/inbox/x/tab-1")).toBeNull();
    expect(parseViewTab("v/all/inbox/x/tab-1")).toBeNull();
    expect(parseViewSubPath("v/all/inbox/s/")).toBeNull();
    expect(parseViewSubPath("v/all/inbox/s/tab-1/more")).toBeNull();
  });
});
