// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransfer, type PagePort, type TransferSession } from "../src/core/transfer.ts";
import { evaluateInDocument, mountFixture, PATH_A, PATH_B, URL_A, URL_B, type EditorKind, type Fixture } from "./fixture.ts";

const MARKER = "SYNTHETIC-MARKER-7f3c";
const TEXT = 'line one\n  "quoted" «ёлочки» 日本語 🙂\n```ts\nconst a = `b`;\n```';

let fixture: Fixture | null = null;
let session: TransferSession | null = null;

afterEach(() => {
  session?.dispose();
  session = null;
  fixture?.dispose();
  fixture = null;
  vi.restoreAllMocks();
});

interface Rig {
  fixture: Fixture;
  session: TransferSession;
  evaluations: string[];
  copied: string[];
  /** Runs right before each evaluation reaches the document. */
  beforeEvaluate: { run: (() => void) | null };
}

function rig(kind: EditorKind, drafts: Record<string, string> = {}, page?: PagePort | null): Rig {
  const mounted = mountFixture(kind, drafts);
  fixture = mounted;
  const evaluations: string[] = [];
  const copied: string[] = [];
  const beforeEvaluate: Rig["beforeEvaluate"] = { run: null };
  const livePage: PagePort = {
    async evaluate(expression) {
      evaluations.push(expression);
      beforeEvaluate.run?.();
      return evaluateInDocument(expression);
    },
  };
  let counter = 0;
  const created = createTransfer({
    page: page === undefined ? livePage : page,
    clipboard: {
      async writeText(text) {
        copied.push(text);
        return true;
      },
    },
    newNonce: () => "nonce-" + String((counter += 1)),
    timeoutMs: 30,
  });
  session = created;
  return { fixture: mounted, session: created, evaluations, copied, beforeEvaluate };
}

describe.each<EditorKind>(["textarea", "contenteditable"])("transfer into a %s editor", (kind) => {
  it("appends the exact text once to conversation A and sends nothing", async () => {
    const { fixture, session, copied } = rig(kind, { [PATH_A]: "old draft", [PATH_B]: "other draft" });

    await session.bind(URL_A);
    expect(session.getState()).toEqual({ kind: "ready", target: { origin: "https://chatgpt.com", path: PATH_A } });
    await session.confirm(TEXT);

    expect(session.getState().kind).toBe("handed-off");
    expect(fixture.draft(PATH_A)).toBe("old draft" + TEXT);
    expect(fixture.draft(PATH_B)).toBe("other draft");
    expect(fixture.sent()).toBe(0);
    expect(copied).toEqual([]);
  });

  it("writes nothing when the conversation changes before the confirmation", async () => {
    const { fixture, session, copied, evaluations } = rig(kind, { [PATH_A]: "draft A", [PATH_B]: "draft B" });

    await session.bind(URL_A);
    fixture.go(PATH_B);
    session.hostUrlChanged(URL_B);
    expect(session.getState()).toEqual({ kind: "unbound", refusal: "conversation-changed" });
    await session.confirm(TEXT);

    // The bind, then the withdrawal of its permission; no write was sent.
    expect(evaluations).toHaveLength(2);
    expect(evaluations.filter((expression) => expression.includes("line one"))).toEqual([]);
    expect(fixture.draft(PATH_A)).toBe("draft A");
    expect(fixture.draft(PATH_B)).toBe("draft B");
    expect(copied).toEqual([]);
    expect(fixture.sent()).toBe(0);
  });

  it("writes nothing when the conversation changes between the confirmation and the write", async () => {
    const { fixture, session, copied, beforeEvaluate } = rig(kind, { [PATH_A]: "draft A", [PATH_B]: "draft B" });

    await session.bind(URL_A);
    // The host has not reported the change yet: only the page knows.
    beforeEvaluate.run = () => fixture.go(PATH_B);
    await session.confirm(TEXT);

    expect(session.getState()).toEqual({ kind: "unbound", refusal: "conversation-changed" });
    expect(fixture.draft(PATH_A)).toBe("draft A");
    expect(fixture.draft(PATH_B)).toBe("draft B");
    expect(copied).toEqual([]);
    expect(fixture.sent()).toBe(0);
  });

  it("writes once when the confirmation is clicked twice", async () => {
    const { fixture, session, evaluations } = rig(kind, { [PATH_A]: "draft" });

    await session.bind(URL_A);
    expect(await Promise.all([session.confirm(MARKER), session.confirm(MARKER)])).toEqual(["handed-off", "ignored"]);
    expect(await session.confirm(MARKER)).toBe("ignored");

    expect(fixture.draft(PATH_A)).toBe("draft" + MARKER);
    expect(evaluations).toHaveLength(2);
  });

  it("refuses after a reload, even on the same address", async () => {
    const { fixture, session } = rig(kind, { [PATH_A]: "draft" });

    await session.bind(URL_A);
    fixture.reload();
    await session.confirm(TEXT);

    expect(session.getState()).toEqual({ kind: "unbound", refusal: "binding-lost" });
    expect(fixture.draft(PATH_A)).toBe("draft");
  });

  it("refuses when the editor is gone", async () => {
    const { fixture, session } = rig(kind, { [PATH_A]: "draft" });

    await session.bind(URL_A);
    fixture.removeEditor();
    await session.confirm(TEXT);

    expect(session.getState()).toEqual({ kind: "unbound", refusal: "editor-unknown" });
    expect(fixture.sent()).toBe(0);
  });

  it("keeps the marker out of the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const { fixture, session } = rig(kind, { [PATH_A]: "" });

    await session.bind(URL_A);
    await session.confirm(MARKER);
    fixture.go(PATH_B);
    await session.bind(URL_B);
    fixture.removeEditor();
    await session.confirm(MARKER);

    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(MARKER);
  });
});

describe("the draft's own selection", () => {
  it("is deselected, not replaced", async () => {
    const { fixture, session } = rig("textarea", { [PATH_A]: "keep this part" });
    const editor = fixture.editor() as HTMLTextAreaElement;
    editor.setSelectionRange(5, 9);

    await session.bind(URL_A);
    await session.confirm(" + added");

    expect(editor.value).toBe("keep this part + added");
  });
});

describe("choosing a conversation", () => {
  it.each([
    ["https://chatgpt.com/", "no-conversation"],
    ["https://chatgpt.com/auth/login", "no-conversation"],
    ["https://chatgpt.com.evil.example/c/aaaaaaaa-0000-4000-8000-00000000000a", "not-chatgpt"],
    ["http://chatgpt.com/c/aaaaaaaa-0000-4000-8000-00000000000a", "not-chatgpt"],
    ["https://user@chatgpt.com/c/aaaaaaaa-0000-4000-8000-00000000000a", "not-chatgpt"],
    ["not a url", "invalid-url"],
  ])("refuses %s without touching the page", async (url, refusal) => {
    const { session, evaluations } = rig("textarea");

    await session.bind(url);

    expect(session.getState()).toEqual({ kind: "unbound", refusal });
    expect(evaluations).toEqual([]);
  });

  it("refuses when the document is not at the address the host reports", async () => {
    const { fixture, session } = rig("textarea", { [PATH_B]: "draft B" });
    fixture.go(PATH_B);

    await session.bind(URL_A);
    await session.confirm(TEXT);

    expect(session.getState()).toEqual({ kind: "unbound", refusal: "address-mismatch" });
    expect(fixture.draft(PATH_B)).toBe("draft B");
  });

  it("refuses on a client that cannot script the tab", async () => {
    const { session } = rig("textarea", {}, null);

    await session.bind(URL_A);

    expect(session.getState()).toEqual({ kind: "unbound", refusal: "page-unavailable" });
  });

  it("drops a choice still in flight when the conversation changes", async () => {
    let answer: (value: unknown) => void = () => {};
    const page: PagePort = { evaluate: () => new Promise((resolve) => (answer = resolve)) };
    const { session } = rig("textarea", {}, page);

    const binding = session.bind(URL_A);
    session.hostUrlChanged(URL_A + "#same-conversation");
    expect(session.getState()).toEqual({ kind: "binding" });
    session.hostUrlChanged(URL_B);
    answer({ top: true, origin: "https://chatgpt.com", path: PATH_A, tracked: true });
    await binding;

    expect(session.getState()).toEqual({ kind: "unbound", refusal: "conversation-changed" });
  });
});

describe("an unknown result", () => {
  it("is reported as unknown and never retried", async () => {
    const calls: string[] = [];
    const page: PagePort = {
      evaluate(expression) {
        calls.push(expression);
        if (calls.length === 1) return Promise.resolve({ top: true, origin: "https://chatgpt.com", path: PATH_A, tracked: true });
        return new Promise(() => {});
      },
    };
    const { session, copied } = rig("textarea", {}, page);

    await session.bind(URL_A);
    await session.confirm(TEXT);
    expect(session.getState().kind).toBe("unknown");
    await session.confirm(TEXT);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(calls).toHaveLength(2);
    expect(copied).toEqual([]);
  });

  it("treats a malformed answer as unknown, not as success", async () => {
    const answers: unknown[] = [{ top: true, origin: "https://chatgpt.com", path: PATH_A, tracked: true }, { status: "inserted" }];
    const page: PagePort = { evaluate: async () => answers.shift() };
    const { session } = rig("textarea", {}, page);

    await session.bind(URL_A);
    await session.confirm(TEXT);

    expect(session.getState().kind).toBe("unknown");
  });
});

describe("cancelling and copying", () => {
  it("reaches neither the page nor the clipboard when the session is dropped", async () => {
    const { fixture, session, evaluations, copied } = rig("textarea", { [PATH_A]: "draft" });

    await session.bind(URL_A);
    session.dispose();
    await session.confirm(TEXT);
    await session.copy(TEXT);

    expect(evaluations).toHaveLength(2);
    expect(evaluations.filter((expression) => expression.includes("line one"))).toEqual([]);
    expect(copied).toEqual([]);
    expect(fixture.draft(PATH_A)).toBe("draft");
  });

  it("copies only when asked, and exactly the given text", async () => {
    const { fixture, session, copied } = rig("textarea", { [PATH_A]: "draft" });

    await session.bind(URL_A);
    fixture.go(PATH_B);
    session.hostUrlChanged(URL_B);
    expect(copied).toEqual([]);
    expect(await session.copy(TEXT)).toBe(true);

    expect(copied).toEqual([TEXT]);
  });

  it("refuses an empty or oversized text without writing", async () => {
    const { fixture, session } = rig("textarea", { [PATH_A]: "draft" });

    await session.bind(URL_A);
    await session.confirm("");
    expect(session.getState()).toEqual({ kind: "unbound", refusal: "empty-text" });
    await session.bind(URL_A);
    await session.confirm("x".repeat(100_001));

    expect(session.getState()).toEqual({ kind: "unbound", refusal: "text-too-long" });
    expect(fixture.draft(PATH_A)).toBe("draft");
  });
});

describe("a session dropped while the page is answering", () => {
  it("still reports that the editor took the text", async () => {
    let answer: (value: unknown) => void = () => {};
    const answers: Array<Promise<unknown>> = [
      Promise.resolve({ top: true, origin: "https://chatgpt.com", path: PATH_A, tracked: true }),
      new Promise((resolve) => (answer = resolve)),
    ];
    const page: PagePort = { evaluate: () => answers.shift() ?? Promise.reject(new Error("extra call")) };
    const { session } = rig("textarea", {}, page);

    await session.bind(URL_A);
    const writing = session.confirm(TEXT);
    session.dispose();
    answer({ status: "handed-off" });

    expect(await writing).toBe("handed-off");
  });

  it("reports an unknown result when no answer comes", async () => {
    const answers: Array<Promise<unknown>> = [
      Promise.resolve({ top: true, origin: "https://chatgpt.com", path: PATH_A, tracked: true }),
      new Promise(() => {}),
    ];
    const page: PagePort = { evaluate: () => answers.shift() ?? Promise.reject(new Error("extra call")) };
    const { session } = rig("textarea", {}, page);

    await session.bind(URL_A);
    const writing = session.confirm(TEXT);
    session.dispose();

    expect(await writing).toBe("unknown");
  });
});

describe("review findings", () => {
  it("refuses when the page switches the conversation from its own focus handler", async () => {
    const { fixture, session } = rig("contenteditable", { [PATH_A]: "draft A", [PATH_B]: "draft B" });
    fixture.editor().tabIndex = 0;
    fixture.editor().addEventListener("focus", () => fixture.go(PATH_B));

    await session.bind(URL_A);
    expect(await session.confirm(MARKER)).toBe("refused");

    expect(session.getState()).toEqual({ kind: "unbound", refusal: "conversation-changed" });
    expect(fixture.draft(PATH_A)).toBe("draft A");
    expect(fixture.draft(PATH_B)).toBe("draft B");
  });

  it("refuses after the tab went to another conversation and came back", async () => {
    const { fixture, session, beforeEvaluate } = rig("textarea", { [PATH_A]: "draft A", [PATH_B]: "draft B" });

    await session.bind(URL_A);
    beforeEvaluate.run = () => {
      fixture.go(PATH_B);
      fixture.go(PATH_A);
    };
    expect(await session.confirm(MARKER)).toBe("refused");

    expect(session.getState()).toEqual({ kind: "unbound", refusal: "conversation-changed" });
    expect(fixture.draft(PATH_A)).toBe("draft A");
    expect(fixture.draft(PATH_B)).toBe("draft B");
  });

  it("withdraws the page's permission when the session is dropped", async () => {
    const { fixture, session, evaluations } = rig("textarea", { [PATH_A]: "draft" });

    await session.bind(URL_A);
    session.dispose();
    await Promise.resolve();

    expect((globalThis as unknown as { __bbChatDock?: unknown }).__bbChatDock).toBeUndefined();
    expect(evaluations).toHaveLength(2);
    expect(fixture.draft(PATH_A)).toBe("draft");
  });

  it("refuses to choose a conversation on a page that cannot report navigations", async () => {
    const { session } = rig("textarea", { [PATH_A]: "draft" });
    delete (globalThis as unknown as { navigation?: unknown }).navigation;

    await session.bind(URL_A);

    expect(session.getState()).toEqual({ kind: "unbound", refusal: "navigation-untracked" });
  });
});

describe("an editor that answers unclearly", () => {
  it("is reported as unknown and gets no second attempt", async () => {
    const { fixture, session } = rig("contenteditable", { [PATH_A]: "draft" });
    const commands: string[] = [];
    let pastes = 0;
    fixture.editor().addEventListener("paste", () => (pastes += 1));
    (document as unknown as { execCommand?: unknown }).execCommand = (command: string) => {
      commands.push(command);
      return false;
    };

    try {
      await session.bind(URL_A);
      expect(await session.confirm(MARKER)).toBe("unknown");
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    }

    expect(session.getState().kind).toBe("unknown");
    expect(commands).toEqual(["insertText"]);
    expect(pastes).toBe(0);
  });
});
