// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { AiTransferButton, TelegramAiTransfer, type AiDestination } from "../src/ui/ai-transfer.tsx";
import { QueueDownloadAction } from "../src/ui/download-queue.tsx";
import { FileInspector } from "../src/ui/file-inspector.tsx";
import { MarkdownDocumentLoader } from "../src/ui/markdown-document.tsx";

test("previews a text file in the shared media viewer and returns focus to the inspector", async () => {
  const load = vi.fn(async () => "<img src=fixture>\nSecond line");
  const document = { name: "Fixture.txt", downloadable: true };
  const { container } = render(<MarkdownDocumentLoader.Provider value={load}>
    <FileInspector chatId="42" message={{ id: "12", author: "Fixture", text: "", time: "", document }}
      document={document} date={null} shareable close={() => {}} />
  </MarkdownDocumentLoader.Provider>);
  const dialog = container.querySelector("dialog")!;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; fireEvent(dialog, new Event("close")); };
  const button = screen.getByRole("button", { name: "Preview file" });
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(button);
  const viewer = screen.getByRole("dialog", { name: "Fixture.txt" });
  await within(viewer).findByText(/Second line/);
  expect(viewer.classList.contains("mtg-media-viewer")).toBe(true);
  expect(viewer.querySelector("pre img")).toBeNull();
  expect(load).toHaveBeenCalledExactlyOnceWith("42", "12", undefined, "text");
  fireEvent.click(within(viewer).getByRole("button", { name: "Close preview" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(button.ownerDocument.activeElement).toBe(button);
});

test("sends selected Telegram files and chat excerpts to existing and new AI chats, retrying only the failed destination", async () => {
  const files = [{ id: "11", chatId: "42", name: "Notes.md" }, { id: "12", chatId: "42", name: "Map.pdf" }];
  const chats = [{ id: "42", name: "Source North" }, { id: "43", name: "Source South" }];
  const threads = [{ id: "a", name: "Review A", projectId: "project" }, { id: "b", name: "Review B", projectId: "project" }];
  let rejected = false;
  const deliver = vi.fn(async (destination: AiDestination) => {
    if (destination.kind === "existing" && destination.thread.id === "b" && !rejected) {
      rejected = true;
      throw new Error("Fixture rejection");
    }
  });
  const prepare = vi.fn(async () => deliver);
  const prototype = HTMLDialogElement.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", {
    configurable: true, value(this: HTMLDialogElement) { this.open = true; },
  });
  try {
    render(<TelegramAiTransfer.Provider value={{ threads, chats, findChats: async () => [], projects: async () => [{ id: "project", name: "Fixture project" }], prepare }}>
      <AiTransferButton files={files} />
    </TelegramAiTransfer.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Send to AI" }));
    const dialog = screen.getByRole("dialog", { name: "Send to AI" });
    const view = within(dialog);
    const sources = view.getByText("Include Telegram chat history").parentElement as HTMLDetailsElement;
    sources.open = true;
    for (const name of ["Source North", "Source South", "Review A", "Review B", "New AI chat"]) {
      fireEvent.click(view.getByRole("checkbox", { name }));
    }
    await view.findByRole("option", { name: "Fixture project" });
    fireEvent.change(view.getByRole("textbox", { name: "Optional instruction" }), { target: { value: "Summarize the sources." } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    await view.findByText("Sent to 2 AI chats.");
    expect(prepare).toHaveBeenCalledExactlyOnceWith(files, chats, "Summarize the sources.");
    expect(deliver.mock.calls).toEqual([
      [{ kind: "existing", thread: threads[0] }], [{ kind: "existing", thread: threads[1] }], [{ kind: "new", projectId: "project" }],
    ]);
    await waitFor(() => expect(view.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(false));
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    await view.findByText("Sent to 3 AI chats.");
    expect(deliver).toHaveBeenCalledTimes(4);
    expect(deliver).toHaveBeenLastCalledWith({ kind: "existing", thread: threads[1] });
    expect(prepare).toHaveBeenCalledOnce();
  } finally {
    if (original) Object.defineProperty(prototype, "showModal", original);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("keeps the full filename available and closes file actions from a nested control", () => {
  const name = "A_very_long_synthetic_file_name_ending_in_a_visible_extension.pdf";
  const document = { name, downloadable: true };
  render(<QueueDownloadAction.Provider value={async () => true}>
    <FileInspector chatId="42" message={{ id: "12", author: "Fixture", text: "", time: "", document }}
      document={document} date={null} shareable close={() => {}} />
  </QueueDownloadAction.Provider>);
  const heading = screen.getByRole("heading", { name });
  expect(heading.title).toBe(name);
  expect(heading.querySelector("span:last-child")?.textContent).toBe(".pdf");
  const menu = screen.getByText((_, node) => node?.tagName === "SUMMARY" && node.getAttribute("aria-label") === "More file actions");
  const details = menu.parentElement as HTMLDetailsElement;
  expect(details.open).toBe(false);
  details.open = true;
  fireEvent.keyDown(screen.getByRole("button", { name: "Add to downloads" }), { key: "Escape" });
  expect(details.open).toBe(false);
  expect(heading.ownerDocument.activeElement).toBe(menu);
});
