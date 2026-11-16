// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, DraftView } from "../core/model.ts";
import {
  AUTOSAVE_MS,
  Composer,
  type ComposerPorts,
  type ComposerProps,
  type ComposerSaveInput,
  type ComposerSaveResult,
} from "./composer.tsx";

installTestPluginRuntime();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const account: Account = {
  id: "acc-1",
  email: "owner@example.org",
  displayName: null,
  preset: "other",
  host: "imap.example.org",
  port: 993,
  username: "owner@example.org",
  createdAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: "2026-11-14T09:00:00.000Z",
  lastError: null,
  authFailed: false,
  smtpConfigured: true,
};

function draft(overrides: Partial<DraftView> = {}): DraftView {
  return {
    id: "draft-1",
    accountId: "acc-1",
    kind: "new",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    doc: { type: "doc", content: [{ type: "paragraph" }] },
    attachments: [],
    revision: 1,
    serverCopy: "none",
    queued: false,
    continues: false,
    import: null,
    origin: "owner",
    fromAddress: null,
    ...overrides,
  };
}

function fakePorts() {
  let revision = 1;
  const ports = {
    save: vi.fn(async (_input: ComposerSaveInput): Promise<ComposerSaveResult> => ({ revision: ++revision })),
    send: vi.fn(async (_input: { draftId: string; baseRevision: number; requestId: string }) => ({
      outboxId: "out-1",
      sendAfter: "2026-11-15T10:00:10.000Z",
    })),
    discard: vi.fn(async () => undefined),
    upload: {
      begin: vi.fn(async () => ({ uploadId: "up-1" })),
      chunk: vi.fn(async () => ({ received: 0 })),
      finish: vi.fn(async () => ({ id: "att-9", fileName: "shot.png", mimeType: "image/png", size: 4, origin: null })),
    },
    removeAttachment: vi.fn(async () => undefined),
    suggest: vi.fn(async () => []),
    reload: vi.fn(async () => draft({ subject: "From the other window", revision: 7 })),
  };
  return ports satisfies ComposerPorts;
}

function mount(props: Partial<ComposerProps> = {}, ports = fakePorts()) {
  const onClose = vi.fn();
  const onSent = vi.fn();
  const onOpenSmtpSettings = vi.fn();
  let ids = 0;
  const view = render(
    <Composer
      draft={draft()}
      accounts={[account]}
      ports={ports}
      onClose={onClose}
      onSent={onSent}
      onOpenSmtpSettings={onOpenSmtpSettings}
      newRequestId={() => `00000000-0000-4000-8000-00000000000${++ids}`}
      {...props}
    />,
  );
  return { view, ports, onClose, onSent, onOpenSmtpSettings };
}

const subject = () => screen.getByLabelText("Subject") as HTMLInputElement;
const to = () => screen.getByRole("combobox", { name: "To" }) as HTMLInputElement;
const root = () => screen.getByRole("region", { name: /New message|Reply|Forward/ });

function addRecipient(address = "ada@example.org") {
  fireEvent.change(to(), { target: { value: `${address},` } });
}

describe("Composer", () => {
  it("autosaves once typing rests for 1.5 s, building on the last revision", async () => {
    vi.useFakeTimers();
    const { ports } = mount();
    fireEvent.change(subject(), { target: { value: "Pla" } });
    fireEvent.change(subject(), { target: { value: "Plan" } });
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_MS - 1);
    });
    expect(ports.save).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(ports.save).toHaveBeenCalledTimes(1);
    expect(ports.save.mock.calls[0]![0]).toMatchObject({
      draftId: "draft-1",
      baseRevision: 1,
      accountId: "acc-1",
      subject: "Plan",
      to: [],
      doc: { type: "doc" },
    });
    expect(ports.save.mock.calls[0]![0]).not.toHaveProperty("saveToServer");
    expect(screen.getByText("Saved")).toBeTruthy();

    addRecipient();
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_MS);
    });
    expect(ports.save.mock.calls[1]![0]).toMatchObject({ baseRevision: 2, to: ["ada@example.org"] });
  });

  it("never saves a chip under three characters; it stays typed", async () => {
    vi.useFakeTimers();
    const { ports } = mount();
    fireEvent.change(to(), { target: { value: "ab," } });
    expect(to().value).toBe("ab");
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_MS);
    });
    expect(ports.save.mock.calls.at(-1)![0]).toMatchObject({ to: [] });
  });

  it("saves at once when focus leaves the composer or the page is hidden", async () => {
    const { ports } = mount();
    fireEvent.change(subject(), { target: { value: "Plan" } });
    fireEvent.blur(subject(), { relatedTarget: document.body });
    await waitFor(() => expect(ports.save).toHaveBeenCalledTimes(1));
    fireEvent.change(subject(), { target: { value: "Plan B" } });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(ports.save).toHaveBeenCalledTimes(2));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("marks a draft an agent started, and only that one", () => {
    mount({ draft: draft({ origin: "agent" }) });
    expect(screen.getByText("Started by an agent")).toBeTruthy();
    cleanup();
    mount();
    expect(screen.queryByText("Started by an agent")).toBeNull();
  });

  it("disables Send without recipients", () => {
    mount();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    addRecipient();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("refuses to send with an invalid address", async () => {
    const { ports } = mount();
    addRecipient("not-an-address");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/marked in red/);
    expect(ports.send).not.toHaveBeenCalled();
  });

  it("saves, then sends with one request id per Send, reused when the call is retried", async () => {
    const ports = fakePorts();
    ports.send.mockRejectedValueOnce(new Error("Network down"));
    const { onSent } = mount({}, ports);
    addRecipient();
    const button = screen.getByRole("button", { name: "Send" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(ports.save).toHaveBeenCalledTimes(1);
    expect(ports.send).toHaveBeenCalledTimes(2);
    const [first, second] = ports.send.mock.calls.map((call) => call[0]);
    expect(first!.requestId).toBe(second!.requestId);
    expect(first!.baseRevision).toBe(2);
    expect(onSent).toHaveBeenCalledWith({ outboxId: "out-1", sendAfter: "2026-11-15T10:00:10.000Z" });
  });

  it("reuses the request id when Send is clicked again after a failure, and takes a new one after an edit", async () => {
    const ports = fakePorts();
    ports.send.mockRejectedValueOnce(new Error("Network down")).mockRejectedValueOnce(new Error("Network down"));
    mount({}, ports);
    addRecipient();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Network down");
    ports.send.mockRejectedValueOnce(new Error("Network down")).mockRejectedValueOnce(new Error("Network down"));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(ports.send).toHaveBeenCalledTimes(4));
    fireEvent.change(subject(), { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(ports.send).toHaveBeenCalledTimes(5));
    const ids = ports.send.mock.calls.map((call) => call[0].requestId);
    expect(new Set(ids.slice(0, 4)).size).toBe(1);
    expect(ids[4]).not.toBe(ids[0]);
  });

  it("sends on Cmd/Ctrl+Enter from any field", async () => {
    const { ports, onSent } = mount();
    addRecipient();
    fireEvent.keyDown(subject(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(ports.send).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape when nothing changed, dropping an untouched new draft", async () => {
    const outer = vi.fn();
    const ports = fakePorts();
    const { onClose } = mount({}, ports);
    document.body.addEventListener("keydown", outer);
    fireEvent.keyDown(subject(), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ports.discard).toHaveBeenCalledWith("draft-1");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener("keydown", outer);
  });

  it("asks Save draft · Discard · Keep editing on Escape with unsaved changes", async () => {
    const ports = fakePorts();
    const { onClose } = mount({}, ports);
    fireEvent.change(subject(), { target: { value: "Plan" } });
    fireEvent.keyDown(subject(), { key: "Escape" });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Close this draft/);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.change(subject(), { target: { value: "Plan" + "!" } });
    fireEvent.keyDown(subject(), { key: "Escape" });
    fireEvent.click(await screen.findByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ports.save.mock.calls.at(-1)![0]).toMatchObject({ subject: "Plan!", saveToServer: true });
    expect(ports.discard).not.toHaveBeenCalled();
  });

  it("discards from the Escape dialog", async () => {
    const { ports, onClose } = mount();
    fireEvent.change(subject(), { target: { value: "Plan" } });
    fireEvent.keyDown(subject(), { key: "Escape" });
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ports.discard).toHaveBeenCalledWith("draft-1");
  });

  it("shows the conflict banner; Reload loads the stored draft, Keep mine saves over it", async () => {
    const ports = fakePorts();
    ports.save.mockResolvedValueOnce({ conflict: true, revision: 5 });
    mount({}, ports);
    fireEvent.change(subject(), { target: { value: "Mine" } });
    fireEvent.blur(subject(), { relatedTarget: document.body });
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed in another window/);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(ports.save).toHaveBeenCalledTimes(2));
    expect(ports.save.mock.calls[1]![0]).toMatchObject({ baseRevision: 5, subject: "Mine" });

    ports.save.mockResolvedValueOnce({ conflict: true, revision: 7 });
    fireEvent.change(subject(), { target: { value: "Mine again" } });
    fireEvent.blur(subject(), { relatedTarget: document.body });
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(subject().value).toBe("From the other window"));
    expect(screen.queryByText(/changed in another window/)).toBeNull();
  });

  it("starts with the queued banner while a send of the draft is queued", () => {
    mount({ draft: draft({ queued: true }) });
    expect(screen.getByRole("alert").textContent).toMatch(/send of this draft is queued/);
    expect(screen.queryByRole("button", { name: "Keep mine" })).toBeNull();
  });

  it("imports the quoted original once and saves it at once", async () => {
    const ports = fakePorts();
    mount(
      {
        draft: draft({
          kind: "reply",
          to: [{ name: "Ada Example", address: "ada@example.org" }],
          subject: "Re: Plan",
          import: { html: '<p>Original <img src="https://tracker.example.com/p.gif"></p>', into: "quote", stripSignature: false },
        }),
      },
      ports,
    );
    await waitFor(() => expect(ports.save).toHaveBeenCalledTimes(1));
    const saved = ports.save.mock.calls[0]![0];
    expect(JSON.stringify(saved.doc)).toContain("blockquote");
    expect(JSON.stringify(saved.doc)).toContain("Original");
    expect(JSON.stringify(saved.doc)).not.toContain("tracker.example.com");
    expect(saved.to).toEqual(["Ada Example <ada@example.org>"]);
  });

  it("saves a continued draft's import as a load, not an edit: closing untouched writes no server copy", async () => {
    const ports = fakePorts();
    const { onClose } = mount(
      { draft: draft({ subject: "Half written", serverCopy: "saved", import: { html: "<p>Draft body</p>", into: "body", stripSignature: false } }) },
      ports,
    );
    await waitFor(() => expect(ports.save).toHaveBeenCalledTimes(1));
    expect(ports.save.mock.calls[0]![0]).toMatchObject({ imported: true });
    expect(ports.save.mock.calls[0]![0].saveToServer).toBeUndefined();
    fireEvent.keyDown(subject(), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ports.save).toHaveBeenCalledTimes(1);
    expect(ports.discard).not.toHaveBeenCalled();
  });

  it("drops an untouched continuation of a kept original on close", async () => {
    const ports = fakePorts();
    const { onClose } = mount(
      { draft: draft({ subject: "Half written", to: [{ name: null, address: "bob@example.com" }], continues: true }) },
      ports,
    );
    fireEvent.keyDown(subject(), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ports.discard).toHaveBeenCalledWith("draft-1");
  });

  it("drops an untouched continuation whose import let the original go", async () => {
    const ports = fakePorts();
    ports.save.mockResolvedValueOnce({ revision: 1, originalKept: true });
    const { onClose } = mount(
      { draft: draft({ subject: "Half written", serverCopy: "saved", continues: true, import: { html: "<h1>Body</h1>", into: "body", stripSignature: false } }) },
      ports,
    );
    await screen.findByText(/The original draft stays on the server/);
    fireEvent.keyDown(subject(), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ports.discard).toHaveBeenCalledWith("draft-1");
  });

  it("keeps a continuation that still points at the original, or that was edited", async () => {
    let ports = fakePorts();
    let mounted = mount({ draft: draft({ subject: "Half written", serverCopy: "saved", continues: true }) }, ports);
    fireEvent.keyDown(subject(), { key: "Escape" });
    await waitFor(() => expect(mounted.onClose).toHaveBeenCalled());
    expect(ports.discard).not.toHaveBeenCalled();
    cleanup();

    ports = fakePorts();
    mounted = mount({ draft: draft({ subject: "Half written", continues: true, revision: 3 }) }, ports);
    fireEvent.keyDown(subject(), { key: "Escape" });
    await waitFor(() => expect(mounted.onClose).toHaveBeenCalled());
    expect(ports.discard).not.toHaveBeenCalled();
    cleanup();

    ports = fakePorts();
    mounted = mount({ draft: draft({ subject: "Half written", continues: true }) }, ports);
    fireEvent.change(subject(), { target: { value: "Half written, more" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(mounted.onClose).toHaveBeenCalled());
    expect(ports.discard).not.toHaveBeenCalled();
  });

  it("says the original draft stays on the server", async () => {
    const ports = fakePorts();
    ports.save.mockResolvedValueOnce({ revision: 1, originalKept: true });
    mount({ draft: draft({ import: { html: "<p>Draft body</p>", into: "body", stripSignature: false } }) }, ports);
    expect(await screen.findByText(/The original draft stays on the server/)).toBeTruthy();
    cleanup();
    mount({ warning: "original_kept" });
    expect(screen.getByText(/The original draft stays on the server/)).toBeTruthy();
  });

  it("uploads files dropped on the composer as attachments", async () => {
    const { ports } = mount();
    const file = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });
    fireEvent.drop(root(), { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeTruthy());
    expect(ports.upload.begin).toHaveBeenCalledWith({ draftId: "draft-1", fileName: "shot.png", mimeType: "image/png", size: 4 });
    expect(ports.upload.finish).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeTruthy();
  });

  it("asks for SMTP settings when the account cannot send", () => {
    const { onOpenSmtpSettings } = mount({ accounts: [{ ...account, smtpConfigured: false }] });
    expect(screen.getByText("SMTP is not set for this account.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up SMTP" }));
    expect(onOpenSmtpSettings).toHaveBeenCalledWith("acc-1");
    addRecipient();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists what compose_prepare left out", () => {
    mount({ draft: draft({ kind: "reply_all" }), dropped: ["Ünïcode <ü@example.org>"], warning: "attachments_left_out" });
    expect(screen.getByText("Left out: Ünïcode <ü@example.org>")).toBeTruthy();
    expect(screen.getByText(/attachments of the original were too large/)).toBeTruthy();
  });

  it("collapses Cc and Bcc until asked for, or used", () => {
    mount();
    expect(screen.queryByRole("combobox", { name: "Cc" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cc Bcc" }));
    expect(screen.getByRole("combobox", { name: "Cc" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Bcc" })).toBeTruthy();
    cleanup();
    mount({ draft: draft({ bcc: [{ name: null, address: "bo@example.org" }] }) });
    expect(screen.getByRole("combobox", { name: "Bcc" })).toBeTruthy();
  });
});

describe("Composer: identities, signatures, checks and templates (slice 3d)", () => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  // ProseMirror scrolls the selection into view after focus(); jsdom has no layout.
  const range = Range.prototype as unknown as Record<string, unknown>;
  range.getClientRects ??= () => [];
  range.getBoundingClientRect ??= () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  proto.getClientRects ??= () => [];

  const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const sigDoc = (text: string) => ({ type: "doc", content: [p(text)] });
  const second: Account = { ...account, id: "acc-2", email: "second@example.net", username: "second@example.net", displayName: "Second" };
  const identities = [
    { accountId: "acc-1", address: "owner@example.org", displayName: "Owner", primary: true, signature: sigDoc("Owner sig"), sendCheck: "confirmed" as const },
    { accountId: "acc-1", address: "team@example.org", displayName: "Team", primary: false, signature: sigDoc("Team sig"), sendCheck: "rewritten" as const },
    { accountId: "acc-2", address: "second@example.net", displayName: "Second", primary: true, signature: null, sendCheck: "unknown" as const },
  ];
  const withSignature = (text: string | null) =>
    draft({ doc: { type: "doc", content: [{ type: "paragraph" }, { type: "signature", content: text === null ? [] : [p(text)] }] } });

  const theEditor = () =>
    (screen.getByRole("textbox", { name: "Message" }) as unknown as { editor: import("@tiptap/react").Editor }).editor;
  const signatureText = () => {
    const json = theEditor().getJSON();
    const block = json.content?.find((node) => node.type === "signature");
    return block === undefined ? null : JSON.stringify(block.content ?? []);
  };

  async function chooseFrom(name: RegExp) {
    const trigger = screen.getByRole("combobox", { name: "From" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(await screen.findByRole("option", { name }), { key: "Enter", code: "Enter" });
  }

  it("From lists every identity across accounts, grouped, with the alias mark and a warning", async () => {
    mount({ accounts: [account, second], identities, draft: withSignature("Owner sig") });
    const trigger = screen.getByRole("combobox", { name: "From" });
    expect(trigger.textContent).toContain("Owner <owner@example.org>");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Owner <owner@example.org>",
      "Team <team@example.org>alias",
      "Second <second@example.net>",
    ]);
    expect(screen.getByText("owner@example.org")).toBeTruthy(); // the group label
    expect(screen.getByText("Second", { selector: "[role=group] *" })).toBeTruthy();
    expect(options[1]!.querySelector('[aria-label="Check this address"]')).not.toBeNull();
  });

  it("swapping From replaces an unedited signature and saves the alias", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { ports } = mount({ identities, draft: withSignature("Owner sig") });
    await chooseFrom(/Team/);
    expect(signatureText()).toBe(JSON.stringify([p("Team sig")]));
    expect(screen.getByText(/does not let this account send as it/)).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_MS);
    });
    await waitFor(() => expect(ports.save).toHaveBeenCalled());
    expect(ports.save.mock.calls.at(-1)![0]).toMatchObject({ accountId: "acc-1", fromAddress: "team@example.org" });
    // Back to the own address: null, and its signature again.
    await chooseFrom(/Owner/);
    expect(signatureText()).toBe(JSON.stringify([p("Owner sig")]));
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_MS);
    });
    await waitFor(() => expect(ports.save.mock.calls.at(-1)![0]).toMatchObject({ fromAddress: null }));
  });

  it("omits fromAddress from a save while From is unchanged (a removed alias still saves)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { ports } = mount({ identities, draft: draft({ fromAddress: "gone@example.org" }) });
    fireEvent.change(subject(), { target: { value: "Plan" } });
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_MS);
    });
    await waitFor(() => expect(ports.save).toHaveBeenCalledTimes(1));
    expect(ports.save.mock.calls[0]![0]).not.toHaveProperty("fromAddress");
    await chooseFrom(/Team/);
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_MS);
    });
    await waitFor(() => expect(ports.save).toHaveBeenCalledTimes(2));
    expect(ports.save.mock.calls[1]![0]).toMatchObject({ fromAddress: "team@example.org" });
    fireEvent.change(subject(), { target: { value: "Plan B" } });
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_MS);
    });
    await waitFor(() => expect(ports.save).toHaveBeenCalledTimes(3));
    expect(ports.save.mock.calls[2]![0]).not.toHaveProperty("fromAddress");
  });

  it("an empty signature block takes the new identity's; an edited one stays with the note", async () => {
    mount({ identities, draft: withSignature("My own edit") });
    await chooseFrom(/Team/);
    expect(signatureText()).toBe(JSON.stringify([p("My own edit")]));
    expect(screen.getByText("Kept your edited signature")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use team@example.org's" }));
    expect(signatureText()).toBe(JSON.stringify([p("Team sig")]));
    expect(screen.queryByText("Kept your edited signature")).toBeNull();
    cleanup();

    mount({ identities, draft: withSignature(null) });
    await chooseFrom(/Team/);
    expect(signatureText()).toBe(JSON.stringify([p("Team sig")]));
  });

  it("a draft without a signature block is left alone by a From change", async () => {
    mount({ identities });
    await chooseFrom(/Team/);
    expect(signatureText()).toBeNull();
  });

  function checkPorts(issues: unknown[] | Error) {
    const ports = { ...fakePorts(), check: vi.fn(async () => (issues instanceof Error ? Promise.reject(issues) : { issues })) };
    return ports as ReturnType<typeof fakePorts> & { check: typeof ports.check };
  }

  it("issues open Before you send; Send anyway sends, Back to editing does not", async () => {
    const ports = checkPorts([{ kind: "empty_subject" }]);
    const { onSent } = mount({}, ports as never);
    addRecipient();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const dialog = await screen.findByRole("dialog", { name: "Before you send" });
    expect(ports.check).toHaveBeenCalledWith({ draftId: "draft-1", baseRevision: 2 });
    expect(ports.send).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain("The subject is empty.");
    expect(document.activeElement?.textContent).toBe("Back to editing");
    // Cmd/Ctrl+Enter does nothing here.
    fireEvent.keyDown(document.activeElement!, { key: "Enter", metaKey: true });
    fireEvent.keyDown(document.activeElement!, { key: "Enter", ctrlKey: true });
    expect(ports.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Before you send" })).toBeNull());
    expect(ports.send).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("dialog", { name: "Before you send" });
    fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(ports.send).toHaveBeenCalledTimes(1);
  });

  it("no issues, or a failing check, sends at once", async () => {
    for (const result of [[], new Error("conflict")]) {
      const ports = checkPorts(result);
      const { onSent } = mount({}, ports as never);
      addRecipient();
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
      expect(ports.check).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog", { name: "Before you send" })).toBeNull();
      cleanup();
    }
  });

  it("each Fix takes the owner to the issue", async () => {
    const ports = checkPorts([
      { kind: "attachment_mentioned", phrase: "attached" },
      { kind: "empty_subject" },
      { kind: "outside_conversation", addresses: ["ada@example.org"] },
    ]);
    mount({}, ports as never);
    addRecipient();
    const picker = screen.getByTestId("compose-file-input") as HTMLInputElement;
    const clicked = vi.fn();
    picker.addEventListener("click", clicked);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Attach a file" }));
    expect(clicked).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add a subject" }));
    await waitFor(() => expect(document.activeElement).toBe(subject()));

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check recipients" }));
    await waitFor(() => expect(document.activeElement).toBe(to()));
    const chip = screen.getByRole("list", { name: "To recipients" }).querySelector("li[data-marked]");
    expect(chip?.textContent).toContain("ada@example.org");
    expect(ports.send).not.toHaveBeenCalled();
  });

  it("slice 3i: Before you send lists a Reply-To that goes elsewhere", async () => {
    const ports = checkPorts([{ kind: "reply_to_elsewhere", addresses: ["help@example.net"] }]);
    mount({}, ports as never);
    addRecipient();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const dialog = await screen.findByRole("dialog", { name: "Before you send" });
    expect(dialog.textContent).toContain("Reply-To differs from the sender: help@example.net");
    expect(ports.send).not.toHaveBeenCalled();
  });

  const TEMPLATES = [
    { id: "tpl-1", name: "Thanks", doc: { type: "doc", content: [p("Thank you, made-up text.")] }, updatedAt: "2026-11-10T09:00:00.000Z" },
    { id: "tpl-2", name: "Follow-up", doc: { type: "doc", content: [p("Following up, invented.")] }, updatedAt: "2026-11-10T09:00:00.000Z" },
  ];

  it("Templates inserts the chosen template at the cursor; Manage templates… opens settings", async () => {
    const onManageTemplates = vi.fn();
    mount({ templates: TEMPLATES, onManageTemplates, draft: draft({ doc: { type: "doc", content: [p("Hello"), p("Bye")] } }) });
    const ed = theEditor();
    act(() => {
      ed.commands.setTextSelection(6); // the end of "Hello"
    });
    fireEvent.click(screen.getByRole("button", { name: /^Templates/ }));
    const find = await screen.findByRole("combobox", { name: "Find a template" });
    fireEvent.change(find, { target: { value: "foll" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Follow-upFollowing up, invented."]);
    fireEvent.keyDown(find, { key: "Enter" });
    const text = ed.getText();
    expect(text.indexOf("Hello")).toBeLessThan(text.indexOf("Following up"));
    expect(text.indexOf("Following up")).toBeLessThan(text.indexOf("Bye"));
    expect(screen.queryByRole("combobox", { name: "Find a template" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Templates/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Manage templates…" }));
    expect(onManageTemplates).toHaveBeenCalled();
  });

  it("Mod+Alt+T opens the picker only with focus in the composer", async () => {
    mount({ templates: TEMPLATES });
    fireEvent.keyDown(document.body, { key: "†", code: "KeyT", metaKey: true, altKey: true });
    expect(screen.queryByRole("combobox", { name: "Find a template" })).toBeNull();
    // Alt+T alone is BB's model picker, not ours.
    fireEvent.keyDown(subject(), { key: "†", code: "KeyT", altKey: true });
    expect(screen.queryByRole("combobox", { name: "Find a template" })).toBeNull();
    fireEvent.keyDown(subject(), { key: "†", code: "KeyT", metaKey: true, altKey: true });
    expect(await screen.findByRole("combobox", { name: "Find a template" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Find a template" }), { key: "Escape" });
    expect(screen.queryByRole("combobox", { name: "Find a template" })).toBeNull();
    fireEvent.keyDown(subject(), { key: "t", code: "KeyT", ctrlKey: true, altKey: true });
    expect(await screen.findByRole("combobox", { name: "Find a template" })).toBeTruthy();
  });
});

describe("Composer: Improve and reply reminders (slice 3f)", () => {
  const text = (value: string) => ({ type: "text", text: value });
  const DOC = {
    type: "doc",
    content: [
      { type: "paragraph", content: [text("Hello Ada,")] },
      { type: "paragraph", content: [text("I would like to send the plan today.")] },
      { type: "blockquote", content: [{ type: "paragraph", content: [text("Made-up original")] }] },
    ],
  };
  const DRAFT_RESULT = {
    kind: "draft" as const,
    provider: "provider-x",
    model: "model-y",
    cached: false,
    stale: false,
    notes: { hidden: 0, leftOut: 0, truncated: 0, unreadItems: 0 },
    citations: [],
    createdAt: "2026-11-16T08:00:00.000Z",
    paragraphs: ["Hi Ada,", "Sending the plan today."],
    unknown: 0,
    missing: 0,
  };
  function improvePorts() {
    return {
      start: vi.fn(async () => ({ jobId: "job-1" })),
      poll: vi.fn(async () => ({ state: "done" as const, result: DRAFT_RESULT })),
      cancel: vi.fn(async () => ({ cancelled: true })),
    };
  }
  type EditorLike = { getJSON: () => { content?: unknown[] }; commands: { insertContentAt: (at: number, text: string) => boolean } };
  const editorOf = () => (document.querySelector(".ProseMirror") as unknown as { editor: EditorLike }).editor;

  it("the reminder checkbox starts unticked and sends remindAfterDays when ticked", async () => {
    const ports = fakePorts();
    mount({ reminderDays: 4 }, ports);
    addRecipient();
    const box = screen.getByRole("checkbox", { name: "Remind me if no reply in 4 days" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(ports.send).toHaveBeenCalledTimes(1));
    expect(ports.send.mock.calls[0]![0]).not.toHaveProperty("remindAfterDays");
    cleanup();
    const again = fakePorts();
    mount({ reminderDays: 4 }, again);
    addRecipient();
    fireEvent.click(screen.getByRole("checkbox", { name: "Remind me if no reply in 4 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(again.send).toHaveBeenCalledTimes(1));
    expect(again.send.mock.calls[0]![0]).toMatchObject({ remindAfterDays: 4 });
  });

  it("no reminder checkbox and no Improve without the slice 3f props", () => {
    mount();
    expect(screen.queryByRole("checkbox", { name: /Remind me/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Improve/ })).toBeNull();
  });

  it("Improve sends the owner's range of the saved revision; Apply replaces it and keeps the quote", async () => {
    const jobs = improvePorts();
    mount({ draft: draft({ doc: DOC }), improve: { jobs, disabledReason: null } });
    fireEvent.click(screen.getByRole("button", { name: /Improve/ }));
    fireEvent.click(screen.getByRole("button", { name: "Shorter" }));
    await waitFor(() => expect(jobs.start).toHaveBeenCalledTimes(1));
    expect(jobs.start.mock.calls[0]).toEqual([
      { kind: "draft", draftId: "draft-1", revision: 1, mode: "shorter", paragraphs: ["Hello Ada,", "I would like to send the plan today."] },
    ]);
    await screen.findByLabelText("Changes");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByLabelText("Changes")).toBeNull());
    const content = editorOf().getJSON().content!;
    expect(content.slice(0, 2)).toEqual([
      { type: "paragraph", content: [text("Hi Ada,")] },
      { type: "paragraph", content: [text("Sending the plan today.")] },
    ]);
    expect(content[2]).toEqual(DOC.content[2]);
  });

  it("an edit while the AI worked refuses Apply", async () => {
    const jobs = improvePorts();
    mount({ draft: draft({ doc: DOC }), improve: { jobs, disabledReason: null } });
    fireEvent.click(screen.getByRole("button", { name: /Improve/ }));
    fireEvent.click(screen.getByRole("button", { name: "Fix mistakes" }));
    await screen.findByLabelText("Changes");
    act(() => {
      editorOf().commands.insertContentAt(1, "Dear ");
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The draft changed while the AI worked. Improve it again.");
    expect(JSON.stringify(editorOf().getJSON())).toContain("Dear Hello Ada,");
  });

  it("Improve is off with the reason without Makosh AI", () => {
    mount({ improve: { jobs: improvePorts(), disabledReason: "AI features need the Makosh AI plugin" } });
    const button = screen.getByRole("button", { name: /Improve/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.closest("span")?.getAttribute("title")).toBe("AI features need the Makosh AI plugin");
  });
});

describe("Composer: files from BB (slice 3g)", () => {
  it("Attach from BB opens the project picker and adds what it attached", async () => {
    const calls: { method: string; input: unknown }[] = [];
    const call = (async (method: string, input: unknown) => {
      calls.push({ method, input });
      if (method === "projects_list") return { projects: [{ id: "p-api", name: "api", kind: "local", hasTree: true, repo: null }] };
      if (method === "project_files") return { files: [{ name: "a.txt", path: "a.txt" }], truncated: false };
      if (method === "compose_attach_bb") return { id: "att-9", fileName: "a.txt", mimeType: "text/plain", size: 5, origin: "bb:project:p-api" };
      throw new Error(method);
    }) as never;
    mount({ bbFiles: { call, projectId: "p-api", threadId: null } });
    fireEvent.click(screen.getByRole("button", { name: "Attach from BB \u25be" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "From a project\u2026" }));
    fireEvent.click(await screen.findByLabelText("a.txt"));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByText("from a BB project")).toBeTruthy();
    expect(calls.find((c) => c.method === "compose_attach_bb")?.input).toMatchObject({ source: { kind: "project", projectId: "p-api", path: "a.txt" } });
  });

  it("offers no BB attach without the integration", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Attach from BB \u25be" })).toBeNull();
  });
});
