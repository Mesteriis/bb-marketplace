import { describe, expect, it } from "vitest";
import type { Folder, SpecialUse } from "./model.ts";
import { parseQuery } from "./search.ts";
import {
  SERVER_SEARCH_CAPS,
  filenameMatches,
  gmailRawOf,
  localOnlyText,
  planServerSearch,
  postFilter,
} from "./server-search.ts";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const q = (raw: string) => parseQuery(raw, NOW);

function folder(path: string, specialUse: SpecialUse | null = null, selectable = true): Folder {
  return { accountId: "a1", path, name: path.split("/").pop()!, specialUse, selectable, unreadCount: 0, totalCount: 0, subscribed: true };
}

const GMAIL = [
  folder("INBOX", "inbox"),
  folder("[Gmail]/All Mail", "all"),
  folder("[Gmail]/Sent Mail", "sent"),
  folder("[Gmail]/Trash", "trash"),
  folder("[Gmail]/Spam", "junk"),
  folder("[Gmail]/Drafts", "drafts"),
  folder("Receipts"),
  folder("[Gmail]", null, false),
];

const IMAP = [
  folder("INBOX", "inbox"),
  folder("Sent", "sent"),
  folder("Archive", "archive"),
  folder("Trash", "trash"),
  folder("Junk", "junk"),
  folder("Drafts", "drafts"),
  folder("Work"),
  folder("Work/Plans"),
  folder("Group", null, false),
];

describe("gmailRawOf", () => {
  it("quotes values after removing quotes and control characters", () => {
    expect(gmailRawOf([{ field: "from", value: 'a\u0000"b@example.org', negated: false }], "")).toBe('from:"ab@example.org"');
    expect(gmailRawOf([{ field: "subject", value: "x", negated: false }], 'invoice "march"\u0007')).toBe(
      'subject:"x" "invoice march"',
    );
  });

  it("writes each operator, negated with a minus", () => {
    expect(
      gmailRawOf(
        q(
          "from:a@example.org -to:b@example.org cc:c@example.org has:attachment -filename:pdf larger:10K smaller:2M " +
            "after:2026-01-02 before:2026-02-03 is:unread -is:starred label:Receipts -in:inbox",
        ).conditions,
        "",
      ),
    ).toBe(
      'from:"a@example.org" -to:"b@example.org" cc:"c@example.org" has:attachment -filename:"pdf" larger:10240 ' +
        'smaller:2097152 after:2026/01/02 before:2026/02/03 is:unread -is:starred label:"Receipts" -in:inbox',
    );
  });

  it("maps in: roles and folder names", () => {
    expect(gmailRawOf(q("in:sent in:Receipts in:drafts").conditions, "")).toBe('{in:sent label:"Receipts" in:drafts}');
    expect(gmailRawOf(q("in:archive").conditions, "")).toBe("-in:inbox");
  });

  it("leaves out account, list and category", () => {
    expect(gmailRawOf(q("account:me@example.org list:x category:bills").conditions, "")).toBe("");
  });
});

describe("planServerSearch: Gmail", () => {
  it("searches All Mail with a raw query", () => {
    expect(planServerSearch(q("from:a@example.org invoice"), { gmail: true }, GMAIL)).toEqual({
      kind: "gmail",
      runs: [{ folder: "[Gmail]/All Mail", raw: 'from:"a@example.org" "invoice"' }],
      localOnly: [],
    });
  });

  it("runs in:trash and in:spam in those folders", () => {
    expect(planServerSearch(q("in:trash invoice"), { gmail: true }, GMAIL)).toEqual({
      kind: "gmail",
      runs: [{ folder: "[Gmail]/Trash", raw: 'in:trash "invoice"' }],
      localOnly: [],
    });
    expect(planServerSearch(q("in:trash in:spam in:inbox x"), { gmail: true }, GMAIL)).toEqual({
      kind: "gmail",
      runs: [
        { folder: "[Gmail]/Trash", raw: 'in:trash "x"' },
        { folder: "[Gmail]/Spam", raw: 'in:spam "x"' },
        { folder: "[Gmail]/All Mail", raw: 'in:inbox "x"' },
      ],
      localOnly: [],
    });
  });

  it("notes list: and category: as local only and keeps label:", () => {
    expect(planServerSearch(q("list:dev.example.org category:bills label:Receipts"), { gmail: true }, GMAIL)).toEqual({
      kind: "gmail",
      runs: [{ folder: "[Gmail]/All Mail", raw: 'label:"Receipts"' }],
      localOnly: ["list", "category"],
    });
  });

  it("keeps the operators only Mail knows off the server and says so", () => {
    expect(planServerSearch(q("from:vip is:dev -is:automated has:invite subject:report"), { gmail: true }, GMAIL)).toEqual({
      kind: "gmail",
      runs: [{ folder: "[Gmail]/All Mail", raw: 'subject:"report"' }],
      localOnly: ["sender", "is", "has"],
    });
    expect(planServerSearch(q("is:dev"), { gmail: true }, GMAIL)).toEqual({ kind: "refused", refused: "nothing_to_search", localOnly: ["is"] });
    expect(planServerSearch(q("is:newsletter"), { gmail: true }, GMAIL)).toEqual({ kind: "refused", refused: "nothing_to_search", localOnly: ["is"] });
    const plain = planServerSearch(q("is:automated -is:dev from:known has:invite report"), { gmail: false }, [
      { accountId: "acc_1", path: "INBOX", name: "Inbox", specialUse: "inbox", selectable: true, unreadCount: 0, totalCount: 1, subscribed: true },
    ] as never);
    expect(plain).toMatchObject({ kind: "folders", runs: [{ path: "INBOX", criteria: { text: "report" } }], localOnly: ["is", "sender", "has"] });
    expect(localOnlyText("sender")).toBe("from:vip, from:team and from:known are not used on the server");
    expect(localOnlyText("is")).toBe("is:dev, is:automated and is:newsletter are not used on the server");
    expect(localOnlyText("has")).toBe("has:invite is not used on the server");
    expect(localOnlyText("list")).toBe("list: is not used on the server");
  });

  it("falls back to the folder list with gmailRaw when there is no All Mail", () => {
    const noAll = GMAIL.filter((f) => f.specialUse !== "all");
    const plan = planServerSearch(q("from:a@example.org"), { gmail: true }, noAll);
    expect(plan).toEqual({
      kind: "folders",
      runs: [
        { path: "INBOX", criteria: { from: "a@example.org", gmailRaw: 'from:"a@example.org"' } },
        { path: "[Gmail]/Sent Mail", criteria: { from: "a@example.org", gmailRaw: 'from:"a@example.org"' } },
        { path: "Receipts", criteria: { from: "a@example.org", gmailRaw: 'from:"a@example.org"' } },
      ],
      skipped: 0,
      localOnly: [],
    });
  });

  it("refuses a query the server cannot use", () => {
    expect(planServerSearch(q("list:x"), { gmail: true }, GMAIL)).toEqual({
      kind: "refused",
      refused: "nothing_to_search",
      localOnly: ["list"],
    });
    expect(planServerSearch(q(""), { gmail: true }, GMAIL)).toMatchObject({ kind: "refused" });
  });
});

describe("planServerSearch: other servers", () => {
  it("translates each operator into criteria", () => {
    const plan = planServerSearch(
      q(
        "plan from:a@example.org to:b@example.org cc:c@example.org subject:s after:2026-01-10 before:2026-01-20 " +
          "larger:1K smaller:1M is:unread is:flagged -from:x@example.org -larger:5M",
      ),
      { gmail: false },
      IMAP,
    );
    expect(plan.kind).toBe("folders");
    if (plan.kind !== "folders") return;
    expect(plan.runs[0]!.criteria).toEqual({
      text: "plan",
      from: "a@example.org",
      to: "b@example.org",
      cc: "c@example.org",
      subject: "s",
      since: "2026-01-09",
      before: "2026-01-21",
      larger: 1024,
      smaller: 1048576,
      seen: false,
      flagged: true,
      not: [{ from: "x@example.org" }, { larger: 5242880 }],
    });
  });

  it("reads -is:unread and -is:flagged as seen and unflagged", () => {
    const plan = planServerSearch(q("is:read -is:starred"), { gmail: false }, IMAP);
    expect(plan.kind === "folders" && plan.runs[0]!.criteria).toEqual({ seen: true, flagged: false });
  });

  it("searches Inbox, Sent, Archive and plain folders, never Trash, Junk or Drafts unless named", () => {
    const plan = planServerSearch(q("x"), { gmail: false }, IMAP);
    expect(plan.kind === "folders" && plan.runs.map((r) => r.path)).toEqual(["INBOX", "Sent", "Archive", "Work", "Work/Plans"]);
    const named = planServerSearch(q("x in:trash in:junk in:Drafts"), { gmail: false }, IMAP);
    expect(named.kind === "folders" && named.runs.map((r) => r.path)).toEqual(["Trash", "Junk", "Drafts"]);
    const byName = planServerSearch(q("x in:work/plans"), { gmail: false }, IMAP);
    expect(byName.kind === "folders" && byName.runs.map((r) => r.path)).toEqual(["Work/Plans"]);
  });

  it("leaves negated folders out", () => {
    const plan = planServerSearch(q("x -in:sent -in:Work"), { gmail: false }, IMAP);
    expect(plan.kind === "folders" && plan.runs.map((r) => r.path)).toEqual(["INBOX", "Archive", "Work/Plans"]);
  });

  it("caps the folders at 30 and reports the rest as skipped", () => {
    const many = [folder("INBOX", "inbox"), ...Array.from({ length: 40 }, (_, i) => folder(`F${String(i).padStart(2, "0")}`))];
    const plan = planServerSearch(q("x"), { gmail: false }, many);
    expect(plan.kind === "folders" && plan.runs.length).toBe(SERVER_SEARCH_CAPS.folders);
    expect(plan.kind === "folders" && plan.skipped).toBe(11);
  });

  it("notes list:, category: and label: as local only", () => {
    const plan = planServerSearch(q("x list:a category:bills label:Work"), { gmail: false }, IMAP);
    expect(plan.localOnly).toEqual(["list", "category", "label"]);
    expect(localOnlyText("list")).toBe("list: is not used on the server");
  });

  it("refuses nothing to search: only local-only operators or only has:", () => {
    expect(planServerSearch(q("list:a"), { gmail: false }, IMAP)).toMatchObject({ kind: "refused" });
    expect(planServerSearch(q("has:attachment"), { gmail: false }, IMAP)).toMatchObject({ kind: "refused" });
    expect(planServerSearch(q("x in:Nowhere"), { gmail: false }, IMAP)).toMatchObject({ kind: "refused" });
  });
});

describe("postFilter", () => {
  const row = (extra: Partial<Parameters<typeof postFilter>[0]> = {}) => ({
    hasAttachments: true,
    filenames: ["Invoice-March.PDF"],
    date: "2026-01-10T23:30:00.000Z",
    ...extra,
  });

  it("applies has:attachment and its negation", () => {
    // has:invite is Mail's own: a server hit is not judged by it.
    expect(postFilter(row({ hasAttachments: false, filenames: [] }), q("has:invite"))).toBe(true);
    expect(postFilter(row(), q("-has:invite"))).toBe(true);
    expect(postFilter(row(), q("has:attachment"))).toBe(true);
    expect(postFilter(row({ hasAttachments: false, filenames: [] }), q("has:attachment"))).toBe(false);
    expect(postFilter(row({ hasAttachments: false, filenames: [] }), q("-has:attachment"))).toBe(true);
  });

  it("applies filename: as an extension or a fragment", () => {
    expect(postFilter(row(), q("filename:pdf"))).toBe(true);
    // No dot: an extension (spec "Search operators"), so a bare word is not a fragment.
    expect(postFilter(row(), q("filename:march"))).toBe(false);
    expect(postFilter(row(), q("filename:march.pdf"))).toBe(true);
    expect(postFilter(row(), q("filename:doc"))).toBe(false);
    expect(postFilter(row(), q("-filename:pdf"))).toBe(false);
    expect(filenameMatches("a.tar.gz", "gz")).toBe(true);
    expect(filenameMatches("pdf-notes.txt", "pdf")).toBe(false);
    expect(filenameMatches("report.v2.txt", "t.v2")).toBe(true);
  });

  it("rechecks the header date the server matched with a day of slack", () => {
    expect(postFilter(row(), q("after:2026-01-10"))).toBe(true);
    expect(postFilter(row(), q("after:2026-01-11"))).toBe(false);
    expect(postFilter(row(), q("before:2026-01-10"))).toBe(false);
    expect(postFilter(row(), q("before:2026-01-11"))).toBe(true);
    expect(postFilter(row({ date: null }), q("after:2026-01-11"))).toBe(true);
  });
});

describe("SERVER_SEARCH_CAPS", () => {
  it("are the spec's", () => {
    expect(SERVER_SEARCH_CAPS).toEqual({ folders: 30, uidsPerFolder: 2000, batch: 50, accountMs: 60_000 });
  });
});
