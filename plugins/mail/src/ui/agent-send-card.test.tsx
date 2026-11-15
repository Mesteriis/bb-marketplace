// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProposalView } from "../core/model.ts";
import { RECIPIENT_ROW_COLLAPSE, revealHidden } from "../core/agent-propose.ts";
import { AgentSendCard, ROW_COLLAPSE, SEND_DWELL_MS, shownText, type AgentSendCardProps, type ProposalViewResult } from "./agent-send-card.tsx";

installTestPluginRuntime();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const TOKEN = "A".repeat(43);

function view(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    proposalId: "prop-1",
    draftId: "draft-9",
    kind: "reply",
    account: { id: "acc-1", name: "Owner Example", address: "owner@example.org" },
    fromName: "Owner Example",
    source: { fromAddress: "ada@example.org", subject: "Quarterly plan" },
    to: [{ address: "ada@example.org", name: "Ada Example", flags: [] }],
    cc: [],
    bcc: [],
    subject: "Re: Quarterly plan",
    hiddenChars: 0,
    bodyText: "Tuesday works for me.",
    quoteText: "On Monday, Ada wrote:\nShall we meet?",
    links: [],
    attachments: [],
    leftOut: 0,
    expiresAt: "2026-11-16T10:00:00.000Z",
    fromAlias: false,
    signatureText: null,
    templateName: null,
    checks: [],
    ...overrides,
  };
}

function mount(result: ProposalViewResult | (() => Promise<ProposalViewResult>), props: Partial<AgentSendCardProps> = {}) {
  const submit = vi.fn(async (_action: "send" | "open", _token: string) => undefined);
  const cancel = vi.fn(async () => undefined);
  const openDraft = vi.fn();
  const load = typeof result === "function" ? result : async () => result;
  const utils = render(<AgentSendCard load={load} submit={submit} cancel={cancel} openDraft={openDraft} {...props} />);
  return { ...utils, submit, cancel, openDraft };
}

const ready = (v: ProposalView = view()): ProposalViewResult => ({ state: "ready", view: v, viewToken: TOKEN });
const sendButton = () => screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement;

/** Mount with fake timers and let the load settle. */
async function mountReady(v: ProposalView = view(), props: Partial<AgentSendCardProps> = {}) {
  vi.useFakeTimers();
  const mounted = mount(ready(v), props);
  await act(async () => {
    await Promise.resolve();
  });
  return mounted;
}

async function passDwell() {
  await act(async () => {
    vi.advanceTimersByTime(SEND_DWELL_MS);
  });
}

describe("AgentSendCard", () => {
  it("renders every field of the frozen message", async () => {
    await mountReady(
      view({
        cc: [{ address: "bo@example.org", name: null, flags: [] }],
        links: [{ url: "https://docs.example.com/plan", host: "docs.example.com" }],
        attachments: [{ fileName: "plan.pdf", mimeType: "application/pdf", size: 2048 }],
        leftOut: 1,
      }),
    );
    expect(screen.getByText("An agent proposes an email")).toBeTruthy();
    expect(screen.getByText("Reply")).toBeTruthy();
    expect(screen.getByText(/Replies to/).textContent).toContain("Quarterly plan");
    expect(screen.getByText("<owner@example.org>")).toBeTruthy();
    expect(within(screen.getByLabelText("To")).getByText("ada@example.org")).toBeTruthy();
    expect(within(screen.getByLabelText("To")).getByText("Ada Example")).toBeTruthy();
    expect(within(screen.getByLabelText("Cc")).getByText("bo@example.org")).toBeTruthy();
    expect(within(screen.getByLabelText("Bcc")).getByText("none")).toBeTruthy();
    expect(screen.getByText("Re: Quarterly plan")).toBeTruthy();
    expect(screen.getByText("Tuesday works for me.")).toBeTruthy();
    const links = screen.getByRole("region", { name: "Links" });
    expect(within(links).getByText("docs.example.com").className).toContain("font-semibold");
    expect(within(links).getByText("https://docs.example.com/plan")).toBeTruthy();
    const attachments = screen.getByRole("region", { name: "Attachments" });
    expect(within(attachments).getByText("plan.pdf")).toBeTruthy();
    expect(within(attachments).getByText("From the forwarded message")).toBeTruthy();
    expect(within(attachments).getByText(/Left out: too large/)).toBeTruthy();
  });

  it("shows an attachment's full name, wrapped, and its extension on its own", async () => {
    const long = `${"quarterly-report-".repeat(8)}final.pdf          .exe`;
    await mountReady(
      view({
        attachments: [
          { fileName: long, mimeType: "application/octet-stream", size: 10 },
          { fileName: "README", mimeType: "text/plain", size: 5 },
        ],
      }),
    );
    const attachments = screen.getByRole("region", { name: "Attachments" });
    const name = within(attachments).getByText((_, el) => el?.tagName === "SPAN" && el.textContent === long);
    expect(name.className).not.toContain("truncate");
    expect(name.className).toContain("break-all");
    expect(within(attachments).getByText(".exe")).toBeTruthy();
    expect(within(attachments).getByText("no extension")).toBeTruthy();
  });

  it("renders the body as text, never as markup or a link", async () => {
    const { container } = await mountReady(
      view({ bodyText: '<img src=x onerror="alert(1)"> <a href="javascript:alert(1)">click</a> **bold**' }),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText(/<img src=x onerror/)).toBeTruthy();
  });

  it("shows the real address, never an agent's display name in its place", async () => {
    await mountReady(view({ kind: "new", source: null, to: [{ address: "attacker@evil.example", name: null, flags: ["new", "outside"] }] }));
    const to = screen.getByLabelText("To");
    expect(within(to).getByText("attacker@evil.example")).toBeTruthy();
    expect(within(to).getByText("New address")).toBeTruthy();
    expect(within(to).getByText("Outside your domains")).toBeTruthy();
  });

  it("reveals hidden characters with a count and strips them from what is shown", async () => {
    await mountReady(view({ subject: "Inv‮oice", hiddenChars: 2, bodyText: "Pay​ now" }));
    expect(screen.getByRole("note").textContent).toContain("2 hidden characters removed");
    expect(screen.getByText("Invoice")).toBeTruthy();
    expect(screen.getByText("Pay now")).toBeTruthy();
  });

  it("strips exactly the characters the server reveals, over every code point", () => {
    const all: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      all.push(String.fromCodePoint(cp));
    }
    const text = all.join("");
    const core = revealHidden(text);
    expect(shownText(text)).toBe(core.shown);
    expect([...text].length - [...shownText(text)].length).toBe(core.hidden);
  });

  it("shows an IDN domain in its punycode form as the server sends it", async () => {
    await mountReady(view({ to: [{ address: "anna@xn--80ak6aa92e.com", name: null, flags: ["new"] }] }));
    expect(screen.getByText("anna@xn--80ak6aa92e.com")).toBeTruthy();
  });

  it("warns on a Bcc row that is not empty", async () => {
    await mountReady(view({ bcc: [{ address: "hidden@example.org", name: null, flags: ["added"] }] }));
    const bcc = screen.getByLabelText("Bcc");
    expect(within(bcc).getByText("Hidden recipients — the others will not see them")).toBeTruthy();
    expect(within(bcc).getByText("Added by the agent")).toBeTruthy();
  });

  it("lists scheme-less links the server found", async () => {
    await mountReady(view({ links: [{ url: "evil.example/login", host: "evil.example" }] }));
    expect(within(screen.getByRole("region", { name: "Links" })).getByText("evil.example/login")).toBeTruthy();
  });

  it("keeps the quote collapsed until asked", async () => {
    await mountReady();
    expect(screen.queryByText(/Shall we meet/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Quoted message/ }));
    expect(screen.getByText(/Shall we meet/)).toBeTruthy();
  });

  it("keeps Send disabled for the dwell after the content renders", async () => {
    const { submit } = await mountReady();
    expect(sendButton().disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(SEND_DWELL_MS - 1);
    });
    expect(sendButton().disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(submit).toHaveBeenCalledWith("send", TOKEN);
  });

  it("needs each new address acknowledged before Send", async () => {
    await mountReady(
      view({
        to: [
          { address: "new1@example.com", name: null, flags: ["new"] },
          { address: "known@example.org", name: null, flags: [] },
        ],
        cc: [{ address: "new2@example.com", name: null, flags: ["new"] }],
      }),
    );
    await passDwell();
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText("Confirm each new address to enable Send.")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "I know this address" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "I know this address" }));
    expect(sendButton().disabled).toBe(false);
  });

  it("collapses a long row with a count and one bulk acknowledgement", async () => {
    expect(ROW_COLLAPSE).toBe(RECIPIENT_ROW_COLLAPSE);
    const many = Array.from({ length: 14 }, (_, i) => ({
      address: `person${i}@example.com`,
      name: null,
      flags: i % 2 === 0 ? (["new"] as const) : ([] as const),
    }));
    await mountReady(view({ kind: "new", source: null, to: many.map((r) => ({ ...r, flags: [...r.flags] })) }));
    await passDwell();
    const to = screen.getByLabelText("To");
    const collapsed = within(to).getAllByRole("listitem");
    expect(collapsed).toHaveLength(10);
    // The 7 new ones lead the row, then 3 of the 7 unflagged.
    expect(collapsed.slice(0, 7).every((li) => li.textContent?.includes("New address"))).toBe(true);
    expect(within(to).queryByRole("button", { name: "I know this address" })).toBeNull();
    fireEvent.click(within(to).getByRole("button", { name: "and 4 more" }));
    expect(within(to).getAllByRole("listitem")).toHaveLength(14);
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(within(to).getByRole("button", { name: "I know these 7 addresses" }));
    expect(sendButton().disabled).toBe(false);
  });

  it.each(["to", "bcc"] as const)(
    "shows a new address among 10 known ones in %s before the bulk acknowledgement can count it",
    async (row) => {
      const known = Array.from({ length: 10 }, (_, i) => ({ address: `known${i}@example.org`, name: null, flags: [] }));
      const attacker = { address: "attacker@evil.example", name: null, flags: ["new", "outside"] as ("new" | "outside")[] };
      await mountReady(view({ kind: "new", source: null, to: [], [row]: [...known, attacker] }));
      await passDwell();
      const list = screen.getByLabelText(row === "to" ? "To" : "Bcc");
      const items = within(list).getAllByRole("listitem");
      // Flagged first, and never behind the collapse.
      expect(items[0]!.textContent).toContain("attacker@evil.example");
      expect(items).toHaveLength(10);
      expect(within(list).getByRole("button", { name: "and 1 more" })).toBeTruthy();
      fireEvent.click(within(list).getByRole("button", { name: "I know this address" }));
      expect(sendButton().disabled).toBe(false);
    },
  );

  it("never collapses flagged recipients, only unflagged ones", async () => {
    const known = Array.from({ length: 12 }, (_, i) => ({ address: `known${i}@example.org`, name: null, flags: [] }));
    const flagged = Array.from({ length: 11 }, (_, i) => ({
      address: `agent${i}@example.org`,
      name: null,
      flags: (i === 0 ? ["added"] : i === 1 ? ["outside"] : ["new"]) as ("new" | "added" | "outside")[],
    }));
    await mountReady(view({ kind: "new", source: null, to: [...known, ...flagged] }));
    await passDwell();
    const to = screen.getByLabelText("To");
    const shown = within(to).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(shown).toHaveLength(11);
    for (const r of flagged) expect(shown.some((t) => t.includes(r.address))).toBe(true);
    expect(within(to).getByRole("button", { name: "and 12 more" })).toBeTruthy();
    expect(within(to).getByRole("button", { name: "I know these 9 addresses" })).toBeTruthy();
  });

  it("asks for a scroll to the end only when the body is taller than its box", async () => {
    const sizes = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    try {
      await mountReady(view({ bodyText: "Long\n".repeat(200) }));
      await passDwell();
      expect(sendButton().disabled).toBe(true);
      expect(screen.getByText("Scroll to the end of the message to enable Send.")).toBeTruthy();
      const body = screen.getByTestId("agent-send-body");
      body.scrollTop = 600;
      fireEvent.scroll(body);
      expect(sendButton().disabled).toBe(false);
    } finally {
      sizes.mockRestore();
      client.mockRestore();
    }
  });

  it("does not ask for a scroll when the body fits", async () => {
    await mountReady();
    await passDwell();
    expect(sendButton().disabled).toBe(false);
  });

  it.each([
    ["changed", "This proposal changed after it was made and cannot be sent."],
    ["gone", "This proposal is no longer available. Nothing was sent."],
    ["opened_elsewhere", "This card was opened elsewhere; reopen it."],
  ] as const)("offers Cancel only when the proposal is %s", async (state, text) => {
    const { cancel } = mount({ state });
    expect((await screen.findByRole("alert")).textContent).toBe(text);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalled();
  });

  it("offers Cancel only when the load fails", async () => {
    mount(async () => {
      throw new Error("boom");
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load this email");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel"]);
  });

  it("Open in Mail submits, then opens the draft", async () => {
    const { submit, openDraft } = await mountReady();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open in Mail" }));
    });
    expect(submit).toHaveBeenCalledWith("open", TOKEN);
    expect(openDraft).toHaveBeenCalledWith("draft-9");
  });

  it("never presses Send from the host's submit shortcut; Cancel still works", async () => {
    let handler: ((action: string) => boolean) | null = null;
    const { submit, cancel } = await mountReady(view(), {
      registerAction: (h) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
    });
    expect(handler!("submit")).toBe(false);
    await passDwell();
    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      expect(handler!("submit")).toBe(false);
    });
    expect(submit).not.toHaveBeenCalled();
    // Only a click (or Enter on the focused button, which the browser turns into a click) sends.
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(submit).toHaveBeenCalledWith("send", TOKEN);
    expect(handler!("cancel")).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });
});

describe("AgentSendCard: identity, template, signature and checks (slice 3d)", () => {
  it("marks an alias From with a badge and names the template", async () => {
    await mountReady(view({ fromAlias: true, account: { id: "acc-1", name: "Owner", address: "team@example.org" }, templateName: "Follow-up" }));
    expect(screen.getByText("<team@example.org>")).toBeTruthy();
    expect(screen.getByText("alias")).toBeTruthy();
    expect(screen.getByText(/Includes the template/).textContent).toBe("Includes the template «Follow-up»");
    cleanup();
    await mountReady(view());
    expect(screen.queryByText("alias")).toBeNull();
    expect(screen.queryByText(/Includes the template/)).toBeNull();
  });

  it("shows the signature under -- only when it is last; above a quote it has no delimiter", async () => {
    await mountReady(view({ kind: "new", source: null, quoteText: null, signatureText: "Made-up Name\nExample Ltd" }));
    expect(screen.getByTestId("agent-send-signature").textContent).toBe("-- Made-up Name\nExample Ltd");
    cleanup();
    await mountReady(view({ signatureText: "Made-up Name" }));
    expect(screen.getByTestId("agent-send-signature").textContent).toBe("Made-up Name");
    // Above the quote.
    const body = screen.getByTestId("agent-send-body");
    const text = body.textContent ?? "";
    expect(text.indexOf("Made-up Name")).toBeLessThan(text.indexOf("Quoted message"));
  });

  it("lists the checks under Before sending as warnings; Send still works", async () => {
    const { submit } = await mountReady(
      view({
        checks: [
          { kind: "attachment_mentioned", phrase: "attached" },
          { kind: "empty_subject" },
          { kind: "outside_conversation", addresses: ["bo@example.org"] },
        ],
      }),
    );
    const list = screen.getByRole("region", { name: "Before sending" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "You wrote “attached”, but nothing is attached.",
      "The subject is empty.",
      "Not in this conversation: bo@example.org",
    ]);
    await passDwell();
    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(submit).toHaveBeenCalledWith("send", TOKEN);
  });
});
