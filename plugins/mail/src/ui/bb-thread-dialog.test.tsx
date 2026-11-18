// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BB_REFUSAL_TEXT } from "../core/contract.ts";
import { BB_TEXT, permissionText } from "./bb-ports.ts";
import { BbThreadDialog, previewNotes, type BbThreadRequest } from "./bb-thread-dialog.tsx";
import { fakeCall, type BbHandlers } from "./testing/bb-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const PROMPT = "Untrusted email content follows.\n<b>bold</b> stays text";

function mount(request: Partial<BbThreadRequest> = {}, handlers: BbHandlers = {}) {
  const fake = fakeCall({
    bb_thread_prepare: () => ({ prompt: PROMPT, title: "Fix login", hidden: 2, leftOut: 1, permissionMode: "full" }),
    bb_thread_start: () => ({ bbThreadId: "bbt-1" }),
    ...handlers,
  });
  const props = { onStarted: vi.fn(), onEditInComposer: vi.fn(), onClose: vi.fn() };
  render(
    <BbThreadDialog
      request={{ messageId: "m-1", projectId: "p-api", inAiScope: true, hasAttachments: true, ...request }}
      call={fake.call}
      {...props}
    />,
  );
  return { ...fake, ...props };
}

describe("bb-ports", () => {
  it("repeats the contract's refusal texts", () => {
    expect(BB_TEXT.out_of_scope).toBe(BB_REFUSAL_TEXT.out_of_scope);
    expect(BB_TEXT.no_tree).toBe(BB_REFUSAL_TEXT.no_tree);
    expect(BB_TEXT.confirm_needed).toBe(BB_REFUSAL_TEXT.confirm_needed);
  });

  it("names the permission mode, and warns for full", () => {
    expect(permissionText(null)).toEqual(["Runs with the project's default permissions"]);
    expect(permissionText("accept-edits")).toEqual(["Runs with accept-edits permissions"]);
    expect(permissionText("full")[1]).toBe("The agent can run commands without asking");
  });
});

describe("BbThreadDialog", () => {
  it("shows the server's prompt as text, the permission mode and the notes", async () => {
    mount();
    const prompt = await screen.findByTestId("bb-thread-prompt");
    expect(prompt.textContent).toBe(PROMPT);
    expect(prompt.querySelector("b")).toBeNull();
    expect(screen.getByText("Runs with full permissions")).toBeTruthy();
    expect(screen.getByText("The agent can run commands without asking")).toBeTruthy();
    expect(screen.getByText(previewNotes({ hidden: 2, leftOut: 1 })[0]!)).toBeTruthy();
    expect(screen.getByText("Thread title: Fix login")).toBeTruthy();
  });

  it("starts with exactly the choices the preview was built from", async () => {
    const { to, onStarted } = mount({ instruction: "Draft a fix" });
    await screen.findByTestId("bb-thread-prompt");
    fireEvent.click(screen.getByLabelText("The whole conversation"));
    await waitFor(() => expect(to("bb_thread_prepare").at(-1)).toMatchObject({ include: "conversation" }));
    fireEvent.change(screen.getByLabelText("Your instruction (optional)"), { target: { value: "Something else" } });
    // The preview no longer matches: Start waits for Update the preview.
    expect((screen.getByRole("button", { name: "Start thread" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Update the preview" }));
    await waitFor(() => expect(to("bb_thread_prepare").at(-1)).toMatchObject({ instruction: "Something else" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Start thread" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(to("bb_thread_start")[0]).toEqual({
      messageId: "m-1",
      include: "conversation",
      projectId: "p-api",
      instruction: "Something else",
    });
    expect(onStarted.mock.calls[0]![0]).toMatchObject({ bbThreadId: "bbt-1", projectId: "p-api" });
  });

  it("passes a rule run and Also save the attachments", async () => {
    const { to } = mount({ ruleRunId: "run-1" });
    await screen.findByTestId("bb-thread-prompt");
    fireEvent.click(screen.getByRole("checkbox"));
    // The preview is asked again with the files Start would save.
    await waitFor(() => expect(to("bb_thread_prepare").at(-1)).toMatchObject({ saveAttachments: true }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Start thread" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    await waitFor(() => expect(to("bb_thread_start")).toHaveLength(1));
    expect(to("bb_thread_start")[0]).toMatchObject({ ruleRunId: "run-1", saveAttachments: true });
  });

  it("Edit in composer hands the shown prompt", async () => {
    const { onEditInComposer } = mount();
    await screen.findByTestId("bb-thread-prompt");
    fireEvent.click(screen.getByRole("button", { name: "Edit in composer" }));
    expect(onEditInComposer).toHaveBeenCalledWith("p-api", PROMPT);
  });

  it("out of AI access: no preview is asked and Start is off", async () => {
    const { to } = mount({ inAiScope: false });
    expect(await screen.findByText(BB_TEXT.out_of_scope)).toBeTruthy();
    expect(to("bb_thread_prepare")).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Start thread" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Edit in composer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a project without a checkout cannot also save the attachments", async () => {
    mount({ projectId: "p-docs" });
    await screen.findByTestId("bb-thread-prompt");
    await waitFor(() => expect((screen.getByRole("checkbox") as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(BB_TEXT.no_tree)).toBeTruthy();
  });

  it("shows a refused start", async () => {
    mount({}, { bb_thread_start: () => Promise.reject(new Error(BB_REFUSAL_TEXT.in_flight)) });
    await screen.findByTestId("bb-thread-prompt");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect((await screen.findByRole("alert")).textContent).toBe(BB_REFUSAL_TEXT.in_flight);
  });
});
