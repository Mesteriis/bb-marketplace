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
      finish: vi.fn(async () => ({ id: "att-9", fileName: "shot.png", mimeType: "image/png", size: 4 })),
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
          import: { html: '<p>Original <img src="https://tracker.example.com/p.gif"></p>', into: "quote" },
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
      { draft: draft({ subject: "Half written", serverCopy: "saved", import: { html: "<p>Draft body</p>", into: "body" } }) },
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
      { draft: draft({ subject: "Half written", serverCopy: "saved", continues: true, import: { html: "<h1>Body</h1>", into: "body" } }) },
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
    mount({ draft: draft({ import: { html: "<p>Draft body</p>", into: "body" } }) }, ports);
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
