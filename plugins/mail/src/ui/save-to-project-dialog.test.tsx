// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaveResult } from "../core/contract.ts";
import { mergeResults, SaveToProjectDialog, type SaveRequest } from "./save-to-project-dialog.tsx";
import { fakeCall, type BbHandlers } from "./testing/bb-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const SHA = "a".repeat(64);

function mount(request: Partial<SaveRequest> = {}, handlers: BbHandlers = {}) {
  const fake = fakeCall({ project_folders: () => ({ folders: [{ name: "docs", path: "docs" }], truncated: false }), ...handlers });
  const props = { onSaved: vi.fn(), onClose: vi.fn() };
  render(
    <SaveToProjectDialog
      request={{ messageId: "m-1", parts: [{ partId: "2", name: "report.pdf" }, { partId: "3", name: "notes.txt" }], projectId: "p-api", ...request }}
      call={fake.call}
      defaultFolder="mail-attachments"
      {...props}
    />,
  );
  return { ...fake, ...props };
}

const exists = (partId: string, path: string): SaveResult => ({ partId, outcome: "exists", path, currentSha: SHA });

describe("SaveToProjectDialog", () => {
  it("asks first, then Keep both saves the existing names numbered", async () => {
    const { to, onSaved } = mount(
      {},
      {
        attachment_save: (input) =>
          input.onConflict === "ask"
            ? { results: [{ partId: "2", outcome: "saved", path: "mail-attachments/notes-a.pdf", sizeBytes: 3 }, exists("3", "mail-attachments/notes.txt")] }
            : { results: [{ partId: "3", outcome: "saved", path: "mail-attachments/notes (2).txt", sizeBytes: 4 }] },
      },
    );
    await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("mail-attachments/notes.txt")).toBeTruthy();
    expect(to("attachment_save")[0]).toEqual({ messageId: "m-1", projectId: "p-api", folder: "mail-attachments", partIds: ["2", "3"], onConflict: "ask" });
    fireEvent.click(screen.getByRole("button", { name: "Keep both" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(to("attachment_save")[1]).toMatchObject({ partIds: ["3"], onConflict: "keep_both" });
    expect(onSaved.mock.calls[0]![0]).toHaveLength(2);
    expect(screen.getByText("Saved as mail-attachments/notes (2).txt")).toBeTruthy();
  });

  it("Replace needs a second click and sends the sha the dialog showed", async () => {
    const { to } = mount(
      { parts: [{ partId: "2", name: "report.pdf" }] },
      {
        attachment_save: (input) =>
          input.onConflict === "ask"
            ? { results: [exists("2", "mail-attachments/report.pdf")] }
            : { results: [{ partId: "2", outcome: "saved", path: "mail-attachments/report.pdf", sizeBytes: 3 }] },
      },
    );
    await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace\u2026" }));
    expect(to("attachment_save")).toHaveLength(1);
    expect(screen.getByText("Replace mail-attachments/report.pdf? The file in the project is overwritten.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(to("attachment_save")).toHaveLength(2));
    expect(to("attachment_save")[1]).toMatchObject({ partIds: ["2"], onConflict: "replace", replaceSha: SHA });
  });

  it("Cancel on the conflict saves nothing more", async () => {
    const { to, onSaved } = mount(
      { parts: [{ partId: "2", name: "report.pdf" }] },
      { attachment_save: () => ({ results: [exists("2", "mail-attachments/report.pdf")] }) },
    );
    await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(to("attachment_save")).toHaveLength(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("a project without a checkout cannot be picked", async () => {
    mount({ projectId: "p-docs" });
    const option = (await screen.findByRole("option", { name: "docs (no local checkout)" })) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's folder refusal", async () => {
    mount({}, { attachment_save: () => Promise.reject(new Error("Mail does not write into .git")) });
    await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Folder in the project"), { target: { value: ".git/hooks" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Mail does not write into .git");
  });

  it("mergeResults keeps the latest answer per part", () => {
    const merged = mergeResults([exists("2", "a"), exists("3", "b")], [{ partId: "2", outcome: "failed", reason: "x" }]);
    expect(merged.map((r) => r.outcome)).toEqual(["failed", "exists"]);
  });
});
