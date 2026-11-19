import { describe, expect, it } from "vitest";
import { docFromLines, type ComposeDoc, type ComposeParagraph } from "./compose-doc.ts";
import type { ComposeKind } from "./model.ts";
import { attachmentMention, bbOriginLabels, cardChecks, inheritedSubject, ownText, presendIssues, type PresendIssue } from "./presend.ts";

const para = (value: string): ComposeParagraph =>
  value === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text: value }] };

function withSig(doc: ComposeDoc, at: number, line: string): ComposeDoc {
  const content = [...doc.content];
  content.splice(at, 0, { type: "signature", content: [para(line)] });
  return { type: "doc", content };
}

describe("ownText", () => {
  it("leaves out quotes and the signature", () => {
    const doc = withSig(docFromLines(["Hello", "On Mon, Bob wrote:"], ["See the attachment"]), 1, "Attachments welcome");
    expect(ownText(doc, "reply")).toBe("Hello\n\nOn Mon, Bob wrote:");
  });

  it("stops a forward at the forward header", () => {
    const doc = docFromLines(["Have a look", "---------- Forwarded message ----------", "From: Bob", "Subject: attached report"]);
    expect(ownText(doc, "forward")).toBe("Have a look");
    // Not a forward: the line is ordinary text.
    expect(ownText(doc, "new")).toContain("attached report");
  });
});

describe("attachmentMention", () => {
  const hit = (sentence: string) => attachmentMention("", sentence);

  it("finds the English words", () => {
    for (const sentence of [
      "I attach the plan",
      "Attached is the plan",
      "I am attaching it",
      "see the attachment",
      "two attachments",
      "Enclosed please find",
      "the enclosure",
      "please find the file below",
      "see the file",
      "here is the file",
    ]) {
      expect(hit(sentence), sentence).not.toBeNull();
    }
  });

  it("needs letter boundaries", () => {
    expect(hit("reattachable")).toBeNull();
    expect(hit("detached house")).toBeNull();
  });

  it("finds the Russian stems with every ending", () => {
    for (const sentence of [
      "прикрепляю файл",
      "прикрепляем",
      "прикреплю",
      "прикреплён договор",
      "прикреплено",
      "прикреплены",
      "прикрепил",
      "прикрепила",
      "прикрепили",
      "приложенный счёт",
      "приложенные файлы",
      "во вложении",
      "вложение",
      "вложения",
      "вложению",
      "вложением",
      "во вложениях",
      "аттач ниже",
      "аттачу",
      "прилагаю",
      "прилагаем",
      "прилагается",
      "прилагаются",
      "прикладываю",
      "прикладываем",
      "приложил",
      "приложила",
      "приложили",
      "приложено",
      "приложены",
      "приложена",
      "отправляю файл",
      "высылаю файл",
    ]) {
      expect(hit(sentence), sentence).not.toBeNull();
    }
  });

  it("treats ё as е and ignores case and width", () => {
    expect(hit("ПРИКРЕПЛЁН")).not.toBeNull();
    expect(hit("ＡＴＴＡＣＨＥＤ")).not.toBeNull();
  });

  it("counts в приложении and см. приложение only near a file word", () => {
    expect(hit("договор в приложении")).not.toBeNull();
    expect(hit("в приложении скан паспорта")).not.toBeNull();
    expect(hit("см. приложение, там pdf")).not.toBeNull();
    expect(hit("см приложение: таблица")).not.toBeNull();
    expect(hit("файл один два три четыре пять шесть в приложении")).toBeNull();
  });

  it("stays quiet for the app meaning", () => {
    expect(hit("ошибка в приложении")).toBeNull();
    expect(hit("приложение банка")).toBeNull();
    expect(hit("в мобильном приложении")).toBeNull();
    expect(hit("установите приложение")).toBeNull();
  });

  it("looks at the subject too and gives the matched words", () => {
    expect(attachmentMention("Report attached", "Hello")).toBe("attached");
    expect(attachmentMention("Hello", "Hi")).toBeNull();
  });
});

describe("presendIssues", () => {
  const base = {
    kind: "new" as ComposeKind,
    subject: "Plan",
    doc: docFromLines(["Hello"]),
    attachmentCount: 0,
    recipients: ["bob@example.org"],
    own: new Set(["anna@example.com", "sales@example.com"]),
    sentTo: new Set(["bob@example.org"]),
    conversation: null as ReadonlySet<string> | null,
    inheritedSubject: null as string | null,
  };

  it("finds nothing in an ordinary message", () => {
    expect(presendIssues(base)).toEqual([]);
  });

  it("flags a forgotten attachment, not when a file is attached", () => {
    const doc = docFromLines(["I attach the plan"]);
    expect(presendIssues({ ...base, doc })).toEqual([{ kind: "attachment_mentioned", phrase: "attach" }]);
    expect(presendIssues({ ...base, doc, attachmentCount: 1 })).toEqual([]);
  });

  it("ignores attachment words in a quote, the signature and below a forward header", () => {
    const reply = withSig(docFromLines(["Thanks", "On Mon, Bob wrote:"], ["see attachments"]), 1, "Attachments to sales@");
    expect(presendIssues({ ...base, kind: "reply", doc: reply, conversation: new Set(["bob@example.org"]) })).toEqual([]);
    const forward = docFromLines(["FYI", "---------- Forwarded message ----------", "Subject: attached"]);
    expect(presendIssues({ ...base, kind: "forward", subject: "Fwd: x", doc: forward })).toEqual([]);
  });

  it("checks a reply's or forward's subject only when the owner changed the inherited one", () => {
    const conversation = new Set(["bob@example.org"]);
    const reply = { ...base, kind: "reply" as ComposeKind, conversation, subject: "Re: Report attached", inheritedSubject: "Re: Report attached" };
    expect(presendIssues(reply)).toEqual([]);
    expect(presendIssues({ ...reply, kind: "reply_all" })).toEqual([]);
    expect(presendIssues({ ...reply, subject: "Re: Report attached, v2" })).toEqual([
      { kind: "attachment_mentioned", phrase: "attached" },
    ]);
    const forward = { ...base, kind: "forward" as ComposeKind, subject: "Fwd: Enclosed plan", inheritedSubject: "Fwd: Enclosed plan" };
    expect(presendIssues(forward)).toEqual([]);
    // The body still counts.
    expect(presendIssues({ ...reply, doc: docFromLines(["I attach it"]) })).toEqual([
      { kind: "attachment_mentioned", phrase: "attach" },
    ]);
    // A new message is checked as before, whatever is passed.
    expect(presendIssues({ ...base, subject: "Report attached", inheritedSubject: "Report attached" })).toEqual([
      { kind: "attachment_mentioned", phrase: "attached" },
    ]);
    // No source to compare with: the subject is checked.
    expect(presendIssues({ ...reply, inheritedSubject: null })).toEqual([{ kind: "attachment_mentioned", phrase: "attached" }]);
  });

  it("inheritedSubject computes Re:/Fwd: from the source subject", () => {
    expect(inheritedSubject("reply", "Report attached")).toBe("Re: Report attached");
    expect(inheritedSubject("reply_all", "Re: Report attached")).toBe("Re: Report attached");
    expect(inheritedSubject("forward", "Report attached")).toBe("Fwd: Report attached");
    expect(inheritedSubject("new", "Report attached")).toBeNull();
    expect(inheritedSubject("reply", null)).toBeNull();
  });

  it("flags an empty subject", () => {
    expect(presendIssues({ ...base, subject: "  " })).toEqual([{ kind: "empty_subject" }]);
  });

  it("lists new recipients against what was sent to, never own addresses", () => {
    expect(
      presendIssues({ ...base, recipients: ["Carol@example.net", "bob@example.org", "sales@example.com", "carol@example.net"] }),
    ).toEqual([{ kind: "new_recipients", addresses: ["carol@example.net"] }]);
  });

  it("checks a reply against the conversation only", () => {
    const conversation = new Set(["bob@example.org", "dave@example.net"]);
    expect(
      presendIssues({
        ...base,
        kind: "reply_all",
        recipients: ["dave@example.net", "eve@example.net", "anna@example.com"],
        sentTo: new Set(),
        conversation,
      }),
    ).toEqual([{ kind: "outside_conversation", addresses: ["eve@example.net"] }]);
  });

  it("uses new recipients for a reply whose source is gone, and never outside for a forward", () => {
    expect(presendIssues({ ...base, kind: "reply", recipients: ["eve@example.net"], conversation: null })).toEqual([
      { kind: "new_recipients", addresses: ["eve@example.net"] },
    ]);
    expect(
      presendIssues({ ...base, kind: "forward", recipients: ["eve@example.net"], conversation: new Set(["bob@example.org"]) }),
    ).toEqual([{ kind: "new_recipients", addresses: ["eve@example.net"] }]);
  });

  it("keeps the order attachment, subject, outside", () => {
    const issues = presendIssues({
      ...base,
      kind: "reply",
      subject: "",
      doc: docFromLines(["прилагаю"]),
      recipients: ["eve@example.net"],
      conversation: new Set(["bob@example.org"]),
    });
    expect(issues.map((i) => i.kind)).toEqual(["attachment_mentioned", "empty_subject", "outside_conversation"]);
  });

  it("keeps the order attachment, subject, new", () => {
    const issues = presendIssues({ ...base, subject: "", doc: docFromLines(["attached"]), recipients: ["eve@example.net"] });
    expect(issues.map((i) => i.kind)).toEqual(["attachment_mentioned", "empty_subject", "new_recipients"]);
  });
});

describe("cardChecks", () => {
  it("drops new recipients", () => {
    const issues: PresendIssue[] = [
      { kind: "attachment_mentioned", phrase: "attached" },
      { kind: "empty_subject" },
      { kind: "outside_conversation", addresses: ["eve@example.net"] },
      { kind: "new_recipients", addresses: ["carol@example.net"] },
    ];
    expect(cardChecks(issues).map((i) => i.kind)).toEqual(["attachment_mentioned", "empty_subject", "outside_conversation"]);
  });
});

describe("presendIssues: slice 3g kinds", () => {
  const base = {
    kind: "new" as ComposeKind,
    subject: "Plan",
    doc: docFromLines(["Hello"]),
    attachmentCount: 0,
    recipients: ["bob@example.org"],
    own: new Set(["anna@example.com"]),
    sentTo: new Set(["bob@example.org"]),
    conversation: null as ReadonlySet<string> | null,
    inheritedSubject: null as string | null,
  };
  // Made up, joined at run time.
  const TOKEN = ["ghp", "InventedToken0123456789abcdefXYZ"].join("_");

  it("lists files from BB by origin only when there are any", () => {
    expect(presendIssues({ ...base, attachmentCount: 3, bbOrigins: [] })).toEqual([]);
    expect(presendIssues({ ...base, attachmentCount: 3, bbOrigins: ["project api", "thread Fix", "project api"] })).toEqual([
      { kind: "bb_files", count: 3, origins: ["project api", "thread Fix"] },
    ]);
  });

  it("warns when the owner's text holds something redaction would hide, not the quote", () => {
    expect(presendIssues({ ...base, doc: docFromLines([`Here is my token ${TOKEN}`, "and the code 482913"]) })).toEqual([
      { kind: "looks_secret", count: 2 },
    ]);
    expect(presendIssues({ ...base, kind: "reply", doc: docFromLines(["Thanks"], [`token ${TOKEN}`]) })).toEqual([]);
  });

  it("says when a template's {first_name} was left in the text or the subject, not in a quote", () => {
    expect(presendIssues({ ...base, doc: docFromLines(["Hi {first_name},"]) })).toEqual([{ kind: "placeholder_left" }]);
    expect(presendIssues({ ...base, subject: "For {First_Name}" })).toEqual([{ kind: "placeholder_left" }]);
    expect(presendIssues({ ...base, kind: "reply", doc: docFromLines(["Thanks"], ["Hi {first_name},"]) })).toEqual([]);
  });

  it("puts the new kinds after the 3d ones", () => {
    const issues = presendIssues({ ...base, subject: "", doc: docFromLines([`attached ${TOKEN}`]), bbOrigins: ["project api"] });
    expect(issues.map((i) => i.kind)).toEqual(["attachment_mentioned", "empty_subject", "bb_files", "looks_secret"]);
  });
});

describe("bbOriginLabels (slice 3g)", () => {
  it("labels BB attachments by project name or as a thread, and leaves uploads out", () => {
    const names = new Map([["p1", "Invented api"]]);
    expect(
      bbOriginLabels(
        [{ origin: "bb:project:p1" }, { origin: "bb:project:gone" }, { origin: "bb:thread:t1" }, { origin: null }, {}],
        names,
      ),
    ).toEqual(["project Invented api", "a BB project", "a BB thread"]);
    expect(bbOriginLabels([{ origin: "bb:project:p1" }])).toEqual(["a BB project"]);
  });
});

describe("presendIssues: reply_to_elsewhere (slice 3i)", () => {
  const reply = {
    kind: "reply" as ComposeKind,
    subject: "Re: Invoice",
    doc: docFromLines(["Paid."]),
    attachmentCount: 0,
    recipients: ["help@example-support.net"],
    own: new Set(["anna@example.com"]),
    sentTo: new Set<string>(),
    conversation: new Set(["billing@example.com", "help@example-support.net"]) as ReadonlySet<string>,
    inheritedSubject: "Re: Invoice" as string | null,
    replyToElsewhere: ["help@example-support.net"],
  };

  it("is raised for a reply that still goes to the flagged Reply-To", () => {
    expect(presendIssues(reply)).toEqual([{ kind: "reply_to_elsewhere", addresses: ["help@example-support.net"] }]);
    expect(presendIssues({ ...reply, kind: "reply_all", recipients: ["Help@Example-Support.net", "billing@example.com"] })).toEqual([
      { kind: "reply_to_elsewhere", addresses: ["help@example-support.net"] },
    ]);
  });

  it("clears when the owner edits the address out, and never for other kinds", () => {
    expect(presendIssues({ ...reply, recipients: ["billing@example.com"] })).toEqual([]);
    expect(presendIssues({ ...reply, replyToElsewhere: [] })).toEqual([]);
    const { replyToElsewhere: _unused, ...withoutField } = reply;
    expect(presendIssues(withoutField)).toEqual([]);
    expect(presendIssues({ ...reply, kind: "forward", conversation: null, sentTo: new Set(["help@example-support.net"]) })).toEqual([]);
  });

  it("comes after the conversation check and before BB files", () => {
    const issues = presendIssues({ ...reply, recipients: ["help@example-support.net", "eve@example.net"], bbOrigins: ["a BB thread"] });
    expect(issues.map((issue) => issue.kind)).toEqual(["outside_conversation", "reply_to_elsewhere", "bb_files"]);
  });
});
