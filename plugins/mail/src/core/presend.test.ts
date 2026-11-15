import { describe, expect, it } from "vitest";
import { docFromLines, type ComposeDoc, type ComposeParagraph } from "./compose-doc.ts";
import type { ComposeKind } from "./model.ts";
import { attachmentMention, cardChecks, ownText, presendIssues, type PresendIssue } from "./presend.ts";

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
