// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProposalView } from "../core/model.ts";
import { RECIPIENT_ROW_COLLAPSE } from "../core/agent-propose.ts";
import { AgentSendCard, ROW_COLLAPSE, SEND_DWELL_MS, type AgentSendCardProps, type ProposalViewResult } from "./agent-send-card.tsx";

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
    expect(within(to).getAllByRole("listitem")).toHaveLength(10);
    expect(within(to).queryByRole("button", { name: "I know this address" })).toBeNull();
    fireEvent.click(within(to).getByRole("button", { name: "and 4 more" }));
    expect(within(to).getAllByRole("listitem")).toHaveLength(14);
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(within(to).getByRole("button", { name: "I know these 7 addresses" }));
    expect(sendButton().disabled).toBe(false);
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

  it("presses Send from the host's submit shortcut only when Send is enabled", async () => {
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
    expect(submit).not.toHaveBeenCalled();
    await passDwell();
    await act(async () => {
      expect(handler!("submit")).toBe(true);
    });
    expect(submit).toHaveBeenCalledWith("send", TOKEN);
    expect(handler!("cancel")).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });
});
