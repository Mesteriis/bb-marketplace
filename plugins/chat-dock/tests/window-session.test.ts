// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { PanelView } from "../src/core/window-protocol.ts";
import { createWindowSession, type WindowPort, type WindowSession } from "../src/core/window-session.ts";
import { evaluateInDocument, mountFixture, PATH_A, PATH_B, URL_A, URL_B, type Fixture } from "./fixture.ts";

const MARK = "SYNTHETIC-MARKER-window-2b7e";
let fixture: Fixture | null = null;
let session: WindowSession | null = null;

afterEach(() => {
  session?.dispose();
  session = null;
  fixture?.dispose();
  fixture = null;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function rig(drafts: Record<string, string>, page?: (expression: string) => Promise<unknown>) {
  fixture = mountFixture("textarea", drafts);
  const panels: PanelView[] = [];
  let changes = 0;
  let id = 0;
  const port: WindowPort = {
    evaluate: page ?? (async (expression) => evaluateInDocument(expression)),
    showPanel: (view) => void panels.push(view),
  };
  const created = createWindowSession({ port, newId: () => "id-" + String((id += 1)), onChange: () => void (changes += 1), timeoutMs: 30 });
  session = created;
  return { session: created, panels, fixture, last: () => panels[panels.length - 1]!, changes: () => changes };
}

describe("a proposal in the window", () => {
  it("shows the exact text and the addressee, writes once on the user's press, and reports no text", async () => {
    const { session, last, fixture } = rig({ [PATH_A]: "old draft", [PATH_B]: "draft B" });
    session.urlChanged(URL_A);

    const proposed = session.propose(MARK, "message-selection");
    await settle();

    expect(proposed).toEqual({ ok: true, proposalId: "id-1" });
    expect(last()).toMatchObject({ visible: true, text: MARK, canInsert: true, canCopy: true, busy: false });
    expect(last().status).toContain("Адресат: беседа …0000000a");
    expect(last().status).toContain("Источник: фрагмент сообщения из BB, знаков: 28");
    expect(session.status()).toEqual({ proposal: "waiting", last: null });

    await session.pressed("insert");

    expect(fixture.draft(PATH_A)).toBe("old draft" + MARK);
    expect(fixture.draft(PATH_B)).toBe("draft B");
    expect(fixture.sent()).toBe(0);
    expect(last()).toMatchObject({ visible: true, text: "", canInsert: false, canCopy: false, dismissLabel: "Закрыть" });
    expect(session.status()).toEqual({ proposal: "none", last: { proposalId: "id-1", outcome: "handed-off" } });
    expect(JSON.stringify(session.status())).not.toContain(MARK);

    await session.pressed("insert");
    expect(fixture.draft(PATH_A)).toBe("old draft" + MARK);
  });

  it("writes nothing when the window moves to another conversation before the press", async () => {
    const { session, last, fixture } = rig({ [PATH_A]: "draft A", [PATH_B]: "draft B" });
    session.urlChanged(URL_A);
    session.propose(MARK, "manual");
    await settle();

    fixture.go(PATH_B);
    session.urlChanged(URL_B);
    await session.pressed("insert");

    expect(fixture.draft(PATH_A)).toBe("draft A");
    expect(fixture.draft(PATH_B)).toBe("draft B");
    expect(last()).toMatchObject({ canInsert: false, canRebind: true, canCopy: true, text: MARK });
    expect(last().status).toContain("Беседа во вкладке сменилась после выбора");
  });

  it("lets the user choose the open conversation again, then writes there", async () => {
    const { session, fixture } = rig({ [PATH_A]: "draft A", [PATH_B]: "draft B" });
    session.urlChanged(URL_A);
    session.propose(MARK, "manual");
    await settle();
    fixture.go(PATH_B);
    session.urlChanged(URL_B);

    await session.pressed("rebind");
    await settle();
    await session.pressed("insert");

    expect(fixture.draft(PATH_B)).toBe("draft B" + MARK);
    expect(fixture.draft(PATH_A)).toBe("draft A");
  });

  it("refuses a second proposal while a write is unanswered, and keeps the outcome after dismiss", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { session, fixture } = rig({ [PATH_A]: "draft" }, async (expression) => {
      const value = evaluateInDocument(expression);
      if (expression.includes("writeInPage")) await held;
      return value;
    });
    session.urlChanged(URL_A);
    session.propose(MARK, "manual");
    await settle();

    const writing = session.pressed("insert");
    expect(session.status().proposal).toBe("writing");
    expect(session.propose("another", "manual")).toEqual({ ok: false, reason: "busy" });
    await session.pressed("dismiss");
    release();
    await writing;

    expect(fixture.draft(PATH_A)).toBe("draft" + MARK);
    expect(session.status()).toEqual({ proposal: "none", last: { proposalId: "id-1", outcome: "handed-off" } });
  });

  it("records a copy made in the window and keeps it through a dismiss", async () => {
    const { session, last } = rig({ [PATH_A]: "draft" });
    session.urlChanged(URL_A);
    session.propose(MARK, "manual");
    await settle();

    session.copied(true);
    expect(last().status).toContain("Текст скопирован");
    await session.pressed("dismiss");

    expect(session.status()).toEqual({ proposal: "none", last: { proposalId: "id-1", outcome: "copied" } });
    expect(last().visible).toBe(false);
  });

  it("marks a replaced or closed proposal as cancelled", async () => {
    const { session } = rig({ [PATH_A]: "draft" });
    session.urlChanged(URL_A);
    session.propose("first", "manual");
    session.propose("second", "manual");
    expect(session.status().last).toEqual({ proposalId: "id-1", outcome: "cancelled" });

    session.closed();
    expect(session.status()).toEqual({ proposal: "none", last: { proposalId: "id-3", outcome: "cancelled" } });
  });

  it("refuses an empty or oversized text without showing anything", () => {
    const { session, panels } = rig({ [PATH_A]: "draft" });

    expect(session.propose("", "manual")).toEqual({ ok: false, reason: "empty-text" });
    expect(session.propose("x".repeat(100_001), "manual")).toEqual({ ok: false, reason: "text-too-long" });
    expect(panels).toEqual([]);
  });

  it("offers only copying on a page that is not an existing conversation", async () => {
    const { session, last } = rig({ [PATH_A]: "draft" });
    session.urlChanged("https://chatgpt.com/");
    session.propose(MARK, "manual");
    await settle();

    expect(last()).toMatchObject({ canInsert: false, canCopy: true, text: MARK });
    expect(last().status).toContain("нет существующей беседы");
  });
});
