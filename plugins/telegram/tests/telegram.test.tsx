// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MessagesDeleted } from "../src/core/contract.ts";
import { TelegramPage } from "../src/ui/telegram-page.tsx";
import { ConversationSearch } from "../src/ui/conversation-search.tsx";
import { AgentReadApproval } from "../src/ui/agent-read-approval.tsx";
import { PollComposer } from "../src/ui/poll-composer.tsx";
import { Avatar } from "../src/ui/avatar.tsx";
import { MessageContent } from "../src/ui/message-content.tsx";
import { ChatDetails } from "../src/ui/chat-details.tsx";
import { CacheSettings } from "../src/ui/cache-settings.tsx";

afterEach(cleanup);

test("shows cache size, saves a valid limit, and refreshes usage after clearing", async () => {
  const read = vi.fn(async () => ({ bytes: 200 * 1024 * 1024, limitMiB: 512 }));
  const setLimit = vi.fn(async (limitMiB: number) => ({ bytes: 100 * 1024 * 1024, limitMiB }));
  const clear = vi.fn(async () => ({ bytes: 0, limitMiB: 128 }));
  const { container } = render(<CacheSettings read={read} setLimit={setLimit} clear={clear} />);
  const dialog = container.querySelector("dialog")!;
  dialog.showModal = () => { dialog.open = true; };
  fireEvent.click(screen.getByRole("button", { name: "Telegram settings" }));
  expect(await screen.findByText("200 MiB")).toBeTruthy();
  expect(clear).not.toHaveBeenCalled();
  const input = screen.getByRole("spinbutton", { name: "Cache limit (MiB)" });
  const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save limit" });
  fireEvent.change(input, { target: { value: "63" } });
  expect(save.disabled).toBe(true);
  fireEvent.change(input, { target: { value: "128" } });
  fireEvent.click(save);
  expect(await screen.findByText("100 MiB")).toBeTruthy();
  expect(setLimit).toHaveBeenCalledExactlyOnceWith(128);
  fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));
  expect(await screen.findByText("0 B")).toBeTruthy();
  expect((input as HTMLInputElement).value).toBe("128");
  expect(clear).toHaveBeenCalledTimes(1);
});

test("changes AI access only for the chat whose properties are open", async () => {
  const load = vi.fn(async (_id: string) => false);
  const change = vi.fn(async (_id: string, enabled: boolean) => enabled);
  const view = render(<ChatDetails chatId="-42" name="Fixture group" load={load} change={change} />);
  const dialog = view.container.querySelector("dialog")!;
  dialog.showModal = () => { dialog.open = true; };
  fireEvent.click(screen.getByRole("button", { name: "Chat details" }));
  const checkbox = await screen.findByRole("checkbox", { name: "Allow AI to search and read this chat" }) as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  expect(load).toHaveBeenCalledExactlyOnceWith("-42");
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.checked).toBe(true));
  expect(change).toHaveBeenCalledExactlyOnceWith("-42", true);
});

test("searches history, opens a chat, and filters work chats", () => {
  render(<TelegramPage />);
  const search = screen.getByRole("searchbox");
  fireEvent.change(search, { target: { value: "14:00" } });
  fireEvent.click(screen.getByRole("button", { name: /Mia Chen/ }));
  expect(screen.getByRole("heading", { name: "Mia Chen" })).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Messages" })).getByText(/14:00/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Work" }));
  expect(screen.getByText("No matching chats")).toBeTruthy();
  fireEvent.change(search, { target: { value: "" } });
  expect(screen.getByRole("button", { name: /Design Forum/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Mia Chen/ })).toBeNull();
});

test("keeps demo messages in the selected conversation", () => {
  render(<TelegramPage />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Test the prototype" } });
  fireEvent.click(screen.getByRole("button", { name: "Send demo message" }));
  const messages = within(screen.getByRole("list", { name: "Messages" }));
  expect(messages.getByText("Test the prototype")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /Mia Chen/ }));
  expect(messages.queryByText("Test the prototype")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Product Discussion/ }));
  expect(messages.getByText("Test the prototype")).toBeTruthy();
});

test("sends the owner’s message directly to the selected chat", async () => {
  const sendText = vi.fn(async () => ({ state: "sent" as const, message: {
    id: "reply", text: "Example only", author: "You", time: "10:45", outgoing: true,
  } }));
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Fixture", initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadHistory: async () => ({ messages: [], before: null }), findChats: async () => [], sendText,
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Example only" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(sendText).toHaveBeenCalledExactlyOnceWith("42", "Example only");
  await within(screen.getByRole("list", { name: "Messages" })).findByText("Example only");
});

test("live refresh preserves earlier pages and a draft while deduplicating overlapping messages", async () => {
  const message = (id: string) => ({ id, text: `Fixture ${id}`, author: "Fixture", time: "" });
  const loadHistory = vi.fn()
    .mockResolvedValueOnce({ messages: [message("20")], before: "20" })
    .mockResolvedValueOnce({ messages: [message("10")], before: "10" })
    .mockResolvedValueOnce({ messages: [message("20"), message("30")], before: "20" });
  const live = {
    chats: [{ id: "42", name: "Fixture", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main" as const, selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadHistory, findChats: async () => [],
    sendText: async () => ({ state: "failed" as const }),
  };
  const page = render(<TelegramPage live={live} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
  const history = within(screen.getByRole("list", { name: "Messages" }));
  await history.findByText("Fixture 20");
  fireEvent.click(history.getByRole("button", { name: "Load earlier messages" }));
  await history.findByText("Fixture 10");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Draft fixture" } });
  page.rerender(<TelegramPage live={{ ...live, liveRevision: 1 }} />);
  await history.findByText("Fixture 30");
  expect(history.getAllByText(/^Fixture (10|20|30)$/).map((node) => node.textContent))
    .toEqual(["Fixture 10", "Fixture 20", "Fixture 30"]);
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Draft fixture");
});

test("loads older history only after scrolling toward the start", async () => {
  const loadHistory = vi.fn()
    .mockResolvedValueOnce({ messages: [{ id: "20", text: "Recent fixture", author: "Fixture", time: "" }], before: "20" })
    .mockResolvedValueOnce({ messages: [{ id: "10", text: "Earlier fixture", author: "Fixture", time: "" }], before: null });
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Fixture", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadHistory, findChats: async () => [],
    sendText: async () => ({ state: "failed" }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
  const list = screen.getByRole("list", { name: "Messages" });
  const history = within(list);
  await history.findByText("Recent fixture");
  fireEvent.scroll(list);
  expect(loadHistory).toHaveBeenCalledOnce();
  list.scrollTop = 300;
  fireEvent.scroll(list);
  expect(loadHistory).toHaveBeenCalledOnce();
  list.scrollTop = 40;
  fireEvent.scroll(list);
  await history.findByText("Earlier fixture");
  expect(loadHistory).toHaveBeenLastCalledWith("42", "20");
  expect(history.getAllByText(/^(Earlier|Recent) fixture$/).map((node) => node.textContent))
    .toEqual(["Earlier fixture", "Recent fixture"]);
});

test("shows only the Telegram caption below an available photo", async () => {
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Fixture", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "",
    loadHistory: async () => ({ before: null, messages: [
      { id: "10", text: "Photo", author: "Fixture", time: "", hasPhoto: true },
      { id: "20", text: "Caption fixture", author: "Fixture", time: "", hasPhoto: true, photoCaption: "Caption fixture" },
    ] }),
    findChats: async () => [], sendText: async () => ({ state: "failed" }),
    loadPhoto: async () => ({ mime: "image/png", base64: "fixture" }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
  const history = within(screen.getByRole("list", { name: "Messages" }));
  await history.findByText("Caption fixture");
  expect(history.queryByText("Photo", { exact: true })).toBeNull();
});

test("displays the chat pin and removes the banner when Telegram reports no pin", async () => {
  const loadPinned = vi.fn().mockResolvedValueOnce({
    id: "10", text: "Pinned fixture", author: "Fixture", time: "",
  }).mockResolvedValueOnce(null);
  const live = {
    chats: [{ id: "42", name: "Fixture", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main" as const, selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadPinned,
    loadHistory: async () => ({ before: null, messages: [] }),
    findChats: async () => [], sendText: async () => ({ state: "failed" as const }),
  };
  const page = render(<TelegramPage live={live} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
  await screen.findByText("Pinned fixture");
  page.rerender(<TelegramPage live={{ ...live, liveRevision: 1 }} />);
  await waitFor(() => expect(screen.queryByText("Pinned fixture")).toBeNull());
  expect(loadPinned).toHaveBeenNthCalledWith(2, "42");
});

test("removes deleted messages only in their chat, even if an in-flight refresh returns them", async () => {
  let notify: ((event: MessagesDeleted) => void) | undefined;
  const message = { id: "10", text: "Deletion fixture", author: "Fixture", time: "" };
  const live = {
    chats: [{ id: "42", name: "Fixture", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main" as const, selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "",
    loadHistory: vi.fn(async () => ({ before: null, messages: [message] })),
    subscribeToDeletions: (listener: (event: MessagesDeleted) => void) => {
      notify = listener;
      return () => { notify = undefined; };
    },
    findChats: async () => [], sendText: async () => ({ state: "failed" as const }),
  };
  const page = render(<TelegramPage live={live} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
  await screen.findByText("Deletion fixture");
  act(() => notify?.({ id: "99", messageIds: ["10"] }));
  expect(screen.getByText("Deletion fixture")).toBeTruthy();
  page.rerender(<TelegramPage live={{ ...live, liveRevision: 1 }} />);
  await act(async () => notify?.({ id: "42", messageIds: ["10"] }));
  expect(live.loadHistory).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("Deletion fixture")).toBeNull();
});

test("keeps photo attachment available when a group forbids text messages", async () => {
  const postingPermissions = vi.fn().mockResolvedValue({ text: false, photo: true });
  const sendText = vi.fn();
  render(<TelegramPage live={{
    chats: [{ id: "-42", name: "Photo fixture", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", postingPermissions,
    loadHistory: async () => ({ before: null, messages: [] }),
    findChats: async () => [], sendText, sendPhoto: async () => ({ state: "failed" }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Photo fixture/ }));
  expect((await screen.findByRole("button", { name: "Attach photo" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText("Only photos can be sent in this chat.")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Write a message" })).toBeNull();
  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
  expect(sendText).not.toHaveBeenCalled();
});

test("shows the full destination before opening a link hidden behind message text", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    render(<TelegramPage live={{
      chats: [{ id: "42", name: "Link fixture", initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [] }],
      folders: [], list: "main", selectList: () => {}, refresh: () => {},
      loading: false, liveRevision: 0, error: "",
      loadHistory: async () => ({ before: null, messages: [{
        id: "1", text: "😀 Details example.org", author: "Fixture", time: "",
        links: [{ offset: 3, length: 7, url: "https://example.com/path", hidden: true },
          { offset: 11, length: 11, url: "https://example.org/" }],
      }] }),
      findChats: async () => [], sendText: async () => ({ state: "failed" }),
    }} />);
    fireEvent.click(screen.getByRole("button", { name: /Link fixture/ }));
    const details = await screen.findByRole("button", { name: "Details" });
    expect(screen.getByRole("link", { name: "example.org" }).getAttribute("href")).toBe("https://example.org/");
    fireEvent.click(details);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("https://example.com/path"));
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(details);
    expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/path", "_blank", "noopener,noreferrer");
  } finally {
    confirm.mockRestore();
    open.mockRestore();
  }
});

test("opens context from conversation search and can return to the existing results", async () => {
  const target = { id: "12", text: "Matched fixture", author: "Fixture", time: "" };
  const loadMessageContext = vi.fn(async () => [{ ...target, id: "2", text: "Nearby fixture" }, target]);
  const searchMessages = vi.fn(async () => ({ messages: [target], before: null }));
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Search fixture", initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", searchMessages, loadMessageContext,
    loadHistory: async () => ({ before: null, messages: [] }),
    findChats: async () => [], sendText: async () => ({ state: "failed" }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Search fixture/ }));
  fireEvent.click(screen.getByRole("button", { name: "Search conversation" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Find in this conversation" }), { target: { value: "matched" } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  fireEvent.click(await screen.findByRole("button", { name: "Show nearby messages" }));
  const list = await screen.findByRole("list", { name: "Nearby messages" });
  expect(within(list).getByText("Nearby fixture")).toBeTruthy();
  expect(within(list).getByText("Matched fixture").closest("li")?.getAttribute("aria-current")).toBe("true");
  expect(loadMessageContext).toHaveBeenCalledExactlyOnceWith("42", "12");
  fireEvent.click(screen.getByRole("button", { name: "Back to results" }));
  expect(screen.getByRole("list", { name: "Matching messages" })).toBeTruthy();
  expect(searchMessages).toHaveBeenCalledOnce();
});

test("opens old pinned message context without disturbing the loaded conversation", async () => {
  const pin = { id: "10", text: "Old pinned fixture", author: "Fixture", time: "" };
  const searchMessages = vi.fn(async () => ({ messages: [pin, { ...pin, id: "9", text: "Another pinned fixture" }], before: null }));
  const loadHistory = vi.fn(async () => ({ before: null, messages: [{ ...pin, id: "90", text: "Recent fixture" }] }));
  const loadMessageContext = vi.fn(async () => [pin]);
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Pin fixture", initials: "PF", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadMessageContext, loadPinned: async () => pin, searchMessages,
    loadHistory, findChats: async () => [], sendText: async () => ({ state: "failed" }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /^Pin fixture/ }));
  const history = await screen.findByRole("list", { name: "Messages" });
  await within(history).findByText("Recent fixture");
  fireEvent.click(await screen.findByRole("button", { name: /Pinned message Old pinned fixture/ }));
  const context = await screen.findByRole("list", { name: "Nearby messages" });
  expect(within(context).getByText("Old pinned fixture")).toBeTruthy();
  expect(loadMessageContext).toHaveBeenCalledExactlyOnceWith("42", "10");
  fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));
  expect(within(screen.getByRole("list", { name: "Messages" })).getByText("Recent fixture")).toBeTruthy();
  expect(loadHistory).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "All pinned messages" }));
  const pins = await screen.findByRole("list", { name: "Matching messages" });
  expect(within(pins).getByText("Another pinned fixture")).toBeTruthy();
  expect(searchMessages).toHaveBeenCalledExactlyOnceWith("42", "", "pinned");
});

test("opens a reply's original message outside the loaded conversation", async () => {
  const parent = { id: "8", text: "Original fixture", author: "Fixture", time: "" };
  const loadMessageContext = vi.fn(async () => [parent]);
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Reply fixture", initials: "RF", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadMessageContext,
    loadHistory: async () => ({ before: null, messages: [{ ...parent, id: "99", text: "Recent reply fixture", replyTo: "8" }] }),
    findChats: async () => [], sendText: async () => ({ state: "failed" }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /^Reply fixture/ }));
  const original = await screen.findByRole("button", { name: "Open original message" });
  expect(original.textContent).toBe("Earlier message");
  fireEvent.click(original);
  const context = await screen.findByRole("list", { name: "Nearby messages" });
  expect(within(context).getByText("Original fixture")).toBeTruthy();
  expect(loadMessageContext).toHaveBeenCalledExactlyOnceWith("42", "8");
  fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));
  expect(within(screen.getByRole("list", { name: "Messages" })).getByText("Recent reply fixture")).toBeTruthy();
});

test("updates outgoing read receipts from the conversation read cursor", async () => {
  const messages = [
    { id: "10", text: "Outgoing fixture", author: "You", time: "", outgoing: true },
    { id: "20", text: "Incoming fixture", author: "Fixture", time: "" },
    { id: "30", text: "Pending fixture", author: "You", time: "", outgoing: true, pendingDelivery: true },
  ];
  const loadHistory = vi.fn()
    .mockResolvedValueOnce({ before: null, messages, readOutbox: 0 })
    .mockResolvedValueOnce({ before: null, messages, readOutbox: 30 });
  const live = {
    chats: [{ id: "42", name: "Receipts fixture", initials: "RF", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main" as const, selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadHistory,
    findChats: async () => [], sendText: async () => ({ state: "failed" as const }),
  };
  const view = render(<TelegramPage live={live} />);
  fireEvent.click(screen.getByRole("button", { name: /^Receipts fixture/ }));
  expect(await screen.findByRole("img", { name: "Sent" })).toBeTruthy();
  view.rerender(<TelegramPage live={{ ...live, liveRevision: 1 }} />);
  expect(await screen.findByRole("img", { name: "Read" })).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Sent" })).toBeNull();
});

test("sends a manual document with a caption when the group permits documents only", async () => {
  const dispatched = { state: "sent" as const, message: {
    id: "12", author: "You", time: "", outgoing: true, text: "Caption fixture",
    document: { name: "Fixture.txt", downloadable: true, caption: "Caption fixture" },
  } };
  let finish!: (result: typeof dispatched) => void;
  const sendDocument = vi.fn((_id: string, _file: File, _caption: string, progress: (uploaded: number) => void) => {
    progress(3);
    return new Promise<typeof dispatched>((resolve) => { finish = resolve; });
  });
  const sendText = vi.fn();
  render(<TelegramPage live={{
    chats: [{ id: "-42", name: "File fixture", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "",
    postingPermissions: async () => ({ text: false, photo: false, document: true }),
    loadHistory: async () => ({ before: null, messages: [] }), findChats: async () => [], sendText, sendDocument,
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /^File fixture/ }));
  await screen.findByRole("button", { name: "Attach document" });
  const file = new File(["Fixture"], "Fixture.txt", { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("Choose document"), { target: { files: [file] } });
  const field = await screen.findByRole("textbox", { name: "Write an attachment caption" });
  fireEvent.change(field, { target: { value: "Caption fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(sendDocument).toHaveBeenCalledExactlyOnceWith("-42", file, "Caption fixture", expect.any(Function), expect.any(AbortSignal), undefined, undefined);
  expect(sendText).not.toHaveBeenCalled();
  expect(screen.getByRole("progressbar", { name: "Document upload to BB" }).getAttribute("value")).toBe("3");
  await act(async () => finish(dispatched));
  expect(screen.queryByRole("progressbar", { name: "Document upload to BB" })).toBeNull();
  await within(screen.getByRole("list", { name: "Messages" })).findByText("Caption fixture");
});

test("manual message deletion requires an explicit choice of scope", async () => {
  const deletionOptions = vi.fn(async () => ["everyone" as const]);
  const deleteMessage = vi.fn(async () => "deleted" as const);
  let onDeletion: ((event: MessagesDeleted) => void) | undefined;
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Fixture", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", findChats: async () => [], sendText: vi.fn(),
    loadHistory: async () => ({ messages: [{ id: "25", text: "Synthetic message", author: "Fixture", time: "10:45" }], before: null }),
    subscribeToDeletions: (listener) => { onDeletion = listener; return () => { onDeletion = undefined; }; },
    deletionOptions, deleteMessage,
  }} />);

  fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete message" }));
  const confirm = await screen.findByRole("button", { name: "Delete for everyone" });
  expect(deletionOptions).toHaveBeenCalledWith("42", "25");
  expect(screen.queryByRole("button", { name: "Delete for me" })).toBeNull();
  expect(deleteMessage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(confirm.isConnected).toBe(false);
  expect(deleteMessage).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete for everyone" }));
  await screen.findByText("Message deleted.");
  expect(deleteMessage).toHaveBeenCalledExactlyOnceWith("42", "25", "everyone");
  act(() => onDeletion?.({ id: "42", messageIds: ["25"] }));
  expect(screen.queryByText("Synthetic message")).toBeNull();
});

test("live history updates preserve the reading position and allow jumping to the latest message", async () => {
  let onDeletion: ((event: { id: string; messageIds: string[] }) => void) | undefined;
  const message = (id: string, text: string) => ({ id, text, author: "Fixture", time: "" });
  const loadHistory = vi.fn()
    .mockResolvedValueOnce({ messages: [message("20", "Original fixture"), message("20", "Original fixture")], before: null })
    .mockResolvedValueOnce({ messages: [message("20", "Edited fixture")], before: null })
    .mockResolvedValueOnce({ messages: [message("20", "Edited fixture"), message("30", "New fixture")], before: null });
  const live = {
    chats: [{ id: "42", name: "Fixture", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main" as const, selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadHistory, findChats: async () => [],
    subscribeToDeletions: (listener: NonNullable<typeof onDeletion>) => {
      onDeletion = listener;
      return () => { onDeletion = undefined; };
    },
    sendText: async () => ({ state: "failed" as const }),
  };
  const view = render(<TelegramPage live={live} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
  const history = screen.getByRole("list", { name: "Messages" });
  Object.defineProperties(history, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
  expect(await within(history).findAllByText("Original fixture")).toHaveLength(1);

  history.scrollTop = 300;
  fireEvent.scroll(history);
  expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
  act(() => onDeletion?.({ id: "42", messageIds: ["10"] }));
  expect(history.scrollTop).toBe(300);
  view.rerender(<TelegramPage live={{ ...live, liveRevision: 1 }} />);
  await within(history).findByText("Edited fixture");
  expect(history.scrollTop).toBe(300);

  history.scrollTop = 500;
  fireEvent.scroll(history);
  view.rerender(<TelegramPage live={{ ...live, liveRevision: 2 }} />);
  await within(history).findByText("New fixture");
  expect(history.scrollTop).toBe(500);

  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  expect(history.scrollTop).toBe(1000);
  expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
});

test("follows the bottom on media resize only while the user is at the latest messages", async () => {
  let resize!: ResizeObserverCallback;
  class Observer {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", Observer);
  try {
    const loadHistory = async () => ({
      messages: [{ id: "20", text: "Fixture message", author: "Fixture", time: "" }], before: null,
    });
    render(<TelegramPage live={{
      chats: [{ id: "42", name: "Fixture", initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [] }],
      folders: [], list: "saved", selectList: () => {}, refresh: () => {}, loading: false, error: "",
      liveRevision: 0, findChats: async () => [], loadHistory, sendText: async () => ({ state: "failed" }),
    }} />);
    fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
    const list = screen.getByRole("list", { name: "Messages" });
    await within(list).findByText("Fixture message");
    let height = 500;
    Object.defineProperties(list, { scrollHeight: { get: () => height }, clientHeight: { value: 200 } });
    act(() => resize([], {} as ResizeObserver));
    expect(list.scrollTop).toBe(500);

    height = 800;
    fireEvent.scroll(list);
    act(() => resize([], {} as ResizeObserver));
    expect(list.scrollTop).toBe(800);

    list.scrollTop = 100;
    fireEvent.scroll(list);
    height = 1000;
    act(() => resize([], {} as ResizeObserver));
    expect(list.scrollTop).toBe(100);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("live refresh fills the gap even if Telegram returns short pages", async () => {
  const message = (id: string) => ({ id, text: `Fixture ${id}`, author: "Fixture", time: "" });
  const loadHistory = vi.fn()
    .mockResolvedValueOnce({ messages: [message("20")], before: "20" })
    .mockResolvedValueOnce({ messages: [message("50")], before: "50" })
    .mockResolvedValueOnce({ messages: [message("40")], before: "40" })
    .mockResolvedValueOnce({ messages: [message("20"), message("30")], before: "20" });
  const live = {
    chats: [{ id: "42", name: "Fixture", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main" as const, selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadHistory, findChats: async () => [],
    sendText: async () => ({ state: "failed" as const }),
  };
  const view = render(<TelegramPage live={live} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
  const history = within(screen.getByRole("list", { name: "Messages" }));
  await history.findByText("Fixture 20");
  view.rerender(<TelegramPage live={{ ...live, liveRevision: 1 }} />);
  await history.findByText("Fixture 50");
  expect(history.getAllByText(/^Fixture \d+$/).map((node) => node.textContent))
    .toEqual(["Fixture 20", "Fixture 30", "Fixture 40", "Fixture 50"]);
  expect(loadHistory.mock.calls).toEqual([["42"], ["42"], ["42", "50"], ["42", "40"]]);
});

test("only updates the selected message after the user chooses the pin action", async () => {
  const pinStatus = vi.fn(async () => true);
  const setMessagePinned = vi.fn(async () => "updated" as const);
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Fixture", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", findChats: async () => [], sendText: vi.fn(),
    loadHistory: async () => ({ messages: [{ id: "25", text: "Synthetic message", author: "Fixture", time: "10:45" }], before: null }),
    pinStatus, setMessagePinned,
  }} />);

  fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Manage message pin" }));
  const unpin = await screen.findByRole("button", { name: "Unpin from chat" });
  expect(pinStatus).toHaveBeenCalledExactlyOnceWith("42", "25");
  expect(setMessagePinned).not.toHaveBeenCalled();
  fireEvent.click(unpin);
  await screen.findByText("Message unpinned.");
  expect(setMessagePinned).toHaveBeenCalledExactlyOnceWith("42", "25", false);
});

test("uses the Telegram avatar preview and falls back to initials if it fails", () => {
  const { container } = render(<TelegramPage live={{
    chats: [{ id: "42", name: "Fixture", initials: "FX", avatarJpeg: "/9j/AA==", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadHistory: async () => ({ messages: [], before: null }),
    findChats: async () => [], sendText: async () => ({ state: "failed" as const }),
  }} />);
  const photo = container.querySelector<HTMLImageElement>(".mtg-avatar img");
  expect(photo?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/AA==");
  fireEvent.error(photo!);
  expect(container.querySelector(".mtg-avatar img")).toBeNull();
  expect(screen.getByText("FX")).toBeTruthy();
});

test("keeps one download per message through live reaction updates and only downloads on click", async () => {
  const saveDocument = vi.fn(async () => true);
  const loadMedia = vi.fn(async () => new Blob());
  const props = {
    chatId: "42", saveDocument, loadMedia,
    reactionActions: { listReactions: async () => [], setReaction: async () => true },
  };
  const message = {
    id: "25", author: "Fixture", time: "", text: "Fixture video",
    document: { name: "Fixture.mp4", downloadable: true, playbackMime: "video/mp4" as const, sizeBytes: 167_000_000 },
  };
  const view = render(<MessageContent {...props} message={message} />);
  for (let count = 1; count <= 8; count++) {
    view.rerender(<MessageContent {...props} message={{ ...message, reactions: { tags: false, items: [{ type: { kind: "emoji", emoji: "👍" }, count, chosen: false }] } }} />);
    expect(screen.getAllByRole("button", { name: "Download Fixture.mp4" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Load video player" })).toHaveLength(1);
  }
  expect(saveDocument).not.toHaveBeenCalled();
  expect(loadMedia).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Download Fixture.mp4" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Download Fixture.mp4" })).toBeTruthy());
  expect(saveDocument).toHaveBeenCalledExactlyOnceWith("42", "25");
});

test("renders nested Telegram styles and links in a caption without changing its text", async () => {
  const { MessageContent } = await import("../src/ui/message-content.tsx");
  const { container } = render(<MessageContent chatId="42" message={{
    id: "25", author: "Fixture", time: "", text: "🌿 Caption item",
    document: { name: "Fixture.jpg", caption: "🌿 Caption item", downloadable: false },
    styles: [{ offset: 3, length: 12, style: "bold" }, { offset: 11, length: 4, style: "italic" }],
    links: [{ offset: 11, length: 4, url: "https://example.com/fixture" }],
  }} />);
  expect(container.querySelector("p:last-child")?.textContent).toBe("🌿 Caption item");
  const link = screen.getByRole("link", { name: "item" });
  expect(link.getAttribute("href")).toBe("https://example.com/fixture");
  expect(link.querySelector(".mtg-text-bold.mtg-text-italic")?.textContent).toBe("item");
});

test("conceals a spoiler and its link in the conversation until revealed", async () => {
  const { MessageText } = await import("../src/ui/message-text.tsx");
  const text = "🌿 Synthetic spoiler. End";
  const styles = [{ offset: 3, length: 17, style: "spoiler" as const }];
  const links = [{ offset: 13, length: 7, url: "https://example.com/fixture" }];
  const view = render(<MessageText text={text} styles={styles} links={links} />);
  expect(view.container.textContent).toBe("🌿 Show spoiler. End");
  expect(view.container.querySelector("a")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show spoiler" }));
  expect(view.container.textContent).toBe(text);
  expect(screen.getByRole("link", { name: "spoiler" }).getAttribute("href")).toBe("https://example.com/fixture");

  view.rerender(<MessageText text={text.replace("Synthetic", "Different")} styles={styles} links={links} />);
  expect(screen.getByRole("button", { name: "Show spoiler" })).toBeTruthy();
  expect(view.container.querySelector("a")).toBeNull();
});

test("redacts Telegram spoilers in the chat list preview", () => {
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Fixture", initials: "FX", color: "#246dbd", subtitle: "Group",
      messages: [{ id: "25", author: "Fixture", time: "", text: "Info: Synthetic", styles: [
        { offset: 6, length: 9, style: "spoiler" },
      ] }],
    }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadHistory: async () => ({ messages: [], before: null }),
    findChats: async () => [], sendText: async () => ({ state: "failed" as const }),
  }} />);
  expect(screen.getByText("Info: [Spoiler]")).toBeTruthy();
  expect(screen.queryByText(/Synthetic/)).toBeNull();
});

test("opens a forum topic, loads earlier pages and returns to the group history", async () => {
  const message = (id: string, text: string) => ({ id, text, author: "Fixture", time: "" });
  const loadTopicHistory = vi.fn()
    .mockResolvedValueOnce({ messages: [{ ...message("20", "Topic message"), editable: true, replyTo: "10", canQuote: true }], before: "20" })
    .mockResolvedValueOnce({ messages: [message("10", "Earlier topic message")], before: null });
  const sendTopicText = vi.fn()
    .mockResolvedValueOnce({ state: "sent", message: message("21", "New topic message") })
    .mockResolvedValueOnce({ state: "sent", message: message("23", "Topic reply sent") })
    .mockResolvedValueOnce({ state: "sent", message: message("24", "Scheduled topic fixture") });
  const chatNotificationState = vi.fn(async () => ({ mode: "default" as const, preview: "default" as const }));
  const setChatNotificationMode = vi.fn(async () => "updated" as const);
  const mediaComposer = vi.fn(() => ({ choices: vi.fn(async () => []), sendChoice: vi.fn(async () => "sent"),
    sendAlbum: vi.fn(async () => "sent"), sendVoice: vi.fn(async () => "sent") }));
  const scheduledMessages = vi.fn(async () => []);
  const sendDocument = vi.fn(async () => ({ state: "sent" as const, message: message("22", "New document") }));
  const loadForumTopics = vi.fn(async () => [{ id: 17, name: "Fixture topic", closed: false }]);
  const searchMessages = vi.fn(async () => ({ messages: [message("10", "Matching topic message")], before: null }));
  const loadMessageContext = vi.fn(async () => [message("10", "Original topic message")]);
  const editText = vi.fn()
    .mockResolvedValueOnce({ state: "failed" })
    .mockResolvedValueOnce({ state: "sent", message: { ...message("20", "Edited topic message"), editable: true } });
  const pinStatus = vi.fn(async () => false);
  const setMessagePinned = vi.fn(async () => "updated" as const);
  const deletionOptions = vi.fn(async () => ["everyone" as const]);
  const deleteMessage = vi.fn(async () => "deleted" as const);
  render(<TelegramPage live={{
    chats: [{ id: "-42", name: "Fixture group", initials: "FX", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", findChats: async () => [], sendText: vi.fn(),
    loadHistory: async () => ({ messages: [message("30", "Group message")], before: null }),
    loadForumTopics, loadTopicHistory, sendTopicText, sendDocument, pinStatus, setMessagePinned, deletionOptions, deleteMessage, editText, loadMessageContext, searchMessages,
    mediaComposer, chatNotificationState, setChatNotificationMode, scheduledMessages, cancelScheduledMessage: vi.fn(async () => true),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture group/ }));
  await screen.findByText("Group message");
  fireEvent.click(await screen.findByRole("button", { name: "Topics" }));
  expect(screen.queryByRole("list", { name: "Messages" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Fixture topic" }));
  expect(mediaComposer).toHaveBeenCalledWith("-42", { id: 17, name: "Fixture topic" });
  expect(screen.getByRole("button", { name: "GIFs" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Voice" })).toBeTruthy();
  const notifications = screen.getByRole("button", { name: "Topic notification settings" });
  fireEvent.click(notifications);
  const notificationPanel = within(await screen.findByRole("group", { name: "Topic notifications" }));
  await notificationPanel.findByText("Using group defaults.");
  fireEvent.change(notificationPanel.getByLabelText("Mute duration"), { target: { value: "28800" } });
  fireEvent.click(notificationPanel.getByRole("button", { name: "Mute for selected duration" }));
  await waitFor(() => expect(chatNotificationState).toHaveBeenCalledTimes(2));
  expect(chatNotificationState.mock.calls).toEqual([["-42", 17], ["-42", 17]]);
  expect(setChatNotificationMode).toHaveBeenCalledExactlyOnceWith("-42", "muted", 28800, 17);
  fireEvent.click(notifications);
  fireEvent.click(screen.getByRole("button", { name: "Copy topic reference" }));
  const topicReference = await screen.findByRole("textbox", { name: "Topic reference" }) as HTMLInputElement;
  expect(JSON.parse(topicReference.value)).toEqual({ recipientId: "-42", forumTopicId: 17 });
  const topic = within(await screen.findByRole("list", { name: "Topic messages" }));
  fireEvent.click(screen.getByRole("button", { name: "Search topic messages" }));
  const search = within(screen.getByRole("region", { name: "Topic search" }));
  fireEvent.change(search.getByRole("searchbox", { name: "Find in this topic" }), { target: { value: "Matching" } });
  fireEvent.click(search.getByRole("button", { name: "Find" }));
  expect(await search.findByText("Matching topic message")).toBeTruthy();
  expect(searchMessages).toHaveBeenCalledExactlyOnceWith("-42", "Matching", undefined, 17);
  fireEvent.click(search.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Pinned topic messages" }));
  const topicPins = within(await screen.findByRole("region", { name: "Topic search" }));
  await topicPins.findByText("Matching topic message");
  expect(searchMessages).toHaveBeenLastCalledWith("-42", "", "pinned", 17);
  fireEvent.click(topicPins.getByRole("button", { name: "Close" }));
  const first = within((await topic.findByText("Topic message")).closest("li")!);
  const original = first.getByRole("button", { name: "Open original message" });
  expect(original.textContent).toBe("Earlier message");
  fireEvent.click(original);
  expect(await screen.findByText("Original topic message")).toBeTruthy();
  expect(loadMessageContext).toHaveBeenCalledExactlyOnceWith("-42", "10", 17);
  fireEvent.click(screen.getByRole("button", { name: "Close original message" }));
  expect(document.activeElement).toBe(original);
  fireEvent.click(first.getByRole("button", { name: "Manage message pin" }));
  fireEvent.click(await first.findByRole("button", { name: "Pin in topic" }));
  await first.findByText("Message pinned.");
  expect(pinStatus).toHaveBeenCalledExactlyOnceWith("-42", "20");
  expect(setMessagePinned).toHaveBeenCalledExactlyOnceWith("-42", "20", true);
  fireEvent.click(screen.getByRole("button", { name: "Load earlier topic messages" }));
  await topic.findByText("Earlier topic message", { selector: "p" });
  expect(original.textContent).toBe("Earlier topic message");
  expect(loadTopicHistory).toHaveBeenLastCalledWith("-42", 17, "20");
  fireEvent.change(screen.getByRole("textbox", { name: "Write a topic message" }), { target: { value: "New topic message" } });
  fireEvent.click(screen.getByRole("button", { name: "Send to topic" }));
  await topic.findByText("New topic message");
  expect(sendTopicText).toHaveBeenCalledExactlyOnceWith("-42", { id: 17, name: "Fixture topic" }, "New topic message");
  const file = new File(["fixture"], "fixture.txt", { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("Choose a topic document"), { target: { files: [file] } });
  fireEvent.change(screen.getByRole("textbox", { name: "Write a topic attachment caption" }), { target: { value: "Fixture caption" } });
  fireEvent.click(screen.getByRole("button", { name: "Send to topic" }));
  await topic.findByText("New document");
  expect(sendDocument).toHaveBeenCalledExactlyOnceWith("-42", file, "Fixture caption", expect.any(Function),
    expect.any(AbortSignal), { id: 17, name: "Fixture topic" });
  fireEvent.click(within(topic.getByText("Topic message").closest("li")!).getByRole("button", { name: "Reply" }));
  expect(screen.getByText("Replying to Fixture")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Attach topic document" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Choose quote" }));
  const source = screen.getByRole("textbox", { name: "Select the passage to quote" }) as HTMLTextAreaElement;
  source.setSelectionRange(6, 13);
  fireEvent.select(source);
  fireEvent.click(screen.getByRole("button", { name: "Use selected quote" }));
  expect((screen.getByRole("button", { name: "Attach topic document" }) as HTMLButtonElement).disabled).toBe(true);
  const topicDraft = screen.getByRole("textbox", { name: "Write a topic message" }) as HTMLTextAreaElement;
  fireEvent.change(topicDraft, { target: { value: " Topic reply sent https://example.org " } });
  fireEvent.click(screen.getByRole("button", { name: "Format message" }));
  topicDraft.setSelectionRange(1, 6);
  fireEvent.select(topicDraft);
  fireEvent.click(within(screen.getByRole("group", { name: "Message formatting" })).getByRole("button", { name: "Italic" }));
  expect(screen.getByLabelText("Formatted message preview").querySelector(".mtg-text-italic")?.textContent).toBe("Topic");
  fireEvent.click(screen.getByRole("checkbox", { name: "Include Telegram link preview" }));
  fireEvent.click(screen.getByRole("button", { name: "Send to topic" }));
  await topic.findByText("Topic reply sent");
  expect(sendTopicText).toHaveBeenLastCalledWith("-42", { id: 17, name: "Fixture topic" }, "Topic reply sent https://example.org", "20",
    [{ offset: 0, length: 5, style: "italic" }], { text: "message", position: 6 }, { linkPreview: true });
  fireEvent.change(topicDraft, { target: { value: "Scheduled topic fixture https://example.org https://example.com" } });
  const topicPreview = screen.getByRole<HTMLInputElement>("checkbox", { name: "Include Telegram link preview" });
  expect(topicPreview.checked).toBe(false);
  fireEvent.click(topicPreview);
  fireEvent.change(screen.getByRole("combobox", { name: "Preview position" }), { target: { value: "above" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Preview link" }), { target: { value: "https://example.com/" } });
  fireEvent.click(screen.getByRole("button", { name: "Send options" }));
  await screen.findByText("No scheduled messages.");
  expect(scheduledMessages).toHaveBeenLastCalledWith("-42", 17);
  fireEvent.input(screen.getByLabelText("Send at"), { target: { value: "2037-01-02T12:30" } });
  fireEvent.click(screen.getByRole("button", { name: "Schedule message" }));
  await screen.findByText("Scheduled.");
  expect(sendTopicText).toHaveBeenLastCalledWith("-42", { id: 17, name: "Fixture topic" }, "Scheduled topic fixture https://example.org https://example.com",
    undefined, undefined, undefined, { silent: false, linkPreview: true, linkPreviewAbove: true, linkPreviewUrl: "https://example.com/", at: new Date("2037-01-02T12:30").getTime() / 1000 });
  expect(topic.queryByText("Scheduled topic fixture")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send options" }));
  fireEvent.click(first.getByRole("button", { name: "Edit message" }));
  const editor = screen.getByRole("textbox", { name: "Edit message" }) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: "Edited topic message" } });
  fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
  await screen.findByText("The message changed or Telegram rejected the edit.");
  expect(editor.value).toBe("Edited topic message");
  fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
  const edited = within((await topic.findByText("Edited topic message")).closest("li")!);
  expect(editText.mock.calls).toEqual(Array.from({ length: 2 }, () => ["-42", "20", "Edited topic message", "Topic message"]));
  fireEvent.click(edited.getByRole("button", { name: "Delete message" }));
  const remove = await edited.findByRole("button", { name: "Delete for everyone" });
  expect(deleteMessage).not.toHaveBeenCalled();
  fireEvent.click(remove);
  await edited.findByText("Message deleted.");
  expect(deletionOptions).toHaveBeenCalledExactlyOnceWith("-42", "20");
  expect(deleteMessage).toHaveBeenCalledExactlyOnceWith("-42", "20", "everyone");
  fireEvent.click(screen.getByRole("button", { name: "Back to topics" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));
  expect(within(screen.getByRole("list", { name: "Messages" })).getByText("Group message")).toBeTruthy();
});

test("prepends topic history after scrolling upward and fills gaps on a live refresh", async () => {
  const message = (id: string) => ({ id, text: `Topic fixture ${id}`, author: "Fixture", time: "" });
  const loadTopicHistory = vi.fn()
    .mockResolvedValueOnce({ messages: [message("20")], before: "20" })
    .mockResolvedValueOnce({ messages: [message("10")], before: null })
    .mockResolvedValueOnce({ messages: [message("40")], before: "40" })
    .mockResolvedValueOnce({ messages: [message("20"), message("30")], before: "20" });
  const live = {
    chats: [{ id: "-42", name: "Fixture group", initials: "FX", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main" as const, selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", findChats: async () => [], sendText: vi.fn(),
    loadHistory: async () => ({ messages: [], before: null }),
    loadForumTopics: async () => [{ id: 17, name: "Fixture topic", closed: false }],
    loadTopicHistory,
  };
  const view = render(<TelegramPage live={live} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture group/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Topics" }));
  fireEvent.click(screen.getByRole("button", { name: "Fixture topic" }));
  const list = screen.getByRole("list", { name: "Topic messages" });
  await within(list).findByText("Topic fixture 20");
  fireEvent.scroll(list);
  expect(loadTopicHistory).toHaveBeenCalledTimes(1);
  list.scrollTop = 300;
  fireEvent.scroll(list);
  expect(loadTopicHistory).toHaveBeenCalledTimes(1);
  list.scrollTop = 40;
  fireEvent.scroll(list);
  await within(list).findByText("Topic fixture 10");

  view.rerender(<TelegramPage live={{ ...live, liveRevision: 1 }} />);
  await within(list).findByText("Topic fixture 40");
  expect(within(list).getAllByText(/Topic fixture \d+/).map((node) => node.textContent))
    .toEqual(["Topic fixture 10", "Topic fixture 20", "Topic fixture 30", "Topic fixture 40"]);
  expect(loadTopicHistory).toHaveBeenLastCalledWith("-42", 17, "40");
});

test("allows a photo filter without a text query", async () => {
  const { ConversationSearch } = await import("../src/ui/conversation-search.tsx");
  const search = vi.fn(async () => ({ messages: [{ id: "12", text: "Photo fixture", author: "Fixture", time: "" }], before: null }));
  render(<ConversationSearch chatId="42" search={search} close={() => {}} />);
  const find = screen.getByRole("button", { name: "Find" }) as HTMLButtonElement;
  expect(find.disabled).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: "Search message type" }), { target: { value: "photo" } });
  expect(find.disabled).toBe(false);
  fireEvent.click(find);
  await screen.findByText("Photo fixture");
  expect(search).toHaveBeenCalledExactlyOnceWith("42", "", "photo");
});

test("loads more chats when the list footer becomes visible and offers a retry after failure", async () => {
  let visibility!: IntersectionObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();
  class Observer {
    constructor(callback: IntersectionObserverCallback) { visibility = callback; }
    observe = observe;
    disconnect = disconnect;
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  try {
    const loadMore = vi.fn(async () => {});
    const live = {
      chats: [{ id: "42", name: "Fixture", initials: "FX", color: "#246dbd", subtitle: "Group", messages: [] }],
      folders: [], list: "main" as const, selectList: () => {}, refresh: () => {},
      loading: false, liveRevision: 0, error: "", loadHistory: async () => ({ messages: [], before: null }),
      findChats: async () => [], sendText: async () => ({ state: "failed" as const }), loadMore,
    };
    const view = render(<TelegramPage live={live} />);
    expect(observe).toHaveBeenCalledOnce();
    expect(loadMore).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Load more chats" })).toBeNull();
    act(() => visibility([{ isIntersecting: true, intersectionRatio: 0.5 } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(loadMore).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalled();

    view.rerender(<TelegramPage live={{ ...live, error: "Could not load more chats." }} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry loading chats" }));
    expect(loadMore).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("replaces the chat minithumbnail only when its avatar becomes visible", async () => {
  let observe!: IntersectionObserverCallback;
  class Observer {
    constructor(callback: IntersectionObserverCallback) { observe = callback; }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  try {
    const loadAvatar = vi.fn(async () => ({ mime: "image/webp" as const, base64: "AAAA" }));
    const { container } = render(<TelegramPage live={{
      chats: [{ id: "42", name: "Fixture", initials: "FX", avatarJpeg: "/9j/AA==", avatarFileId: 7,
        color: "#246dbd", subtitle: "Group", messages: [] }],
      folders: [], list: "main", selectList: () => {}, refresh: () => {},
      loading: false, liveRevision: 0, error: "", loadHistory: async () => ({ messages: [], before: null }),
      findChats: async () => [], sendText: async () => ({ state: "failed" as const }), loadAvatar,
    }} />);
    const avatar = () => container.querySelector(".mtg-avatar img");
    expect(avatar()?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/AA==");
    expect(loadAvatar).not.toHaveBeenCalled();
    await act(async () => observe([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(loadAvatar).toHaveBeenCalledExactlyOnceWith("42", 7);
    expect(avatar()?.getAttribute("src")).toBe("data:image/webp;base64,AAAA");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("shows the sender avatar in conversation search results", async () => {
  const { ConversationSearch } = await import("../src/ui/conversation-search.tsx");
  const loadAvatar = vi.fn(async () => ({ mime: "image/png" as const, base64: "AAAA" }));
  const search = async () => ({ messages: [{ id: "12", text: "Search fixture", author: "Member fixture", time: "",
    authorAvatar: { id: "77", user: true, fileId: 8 } }], before: null });
  const { container } = render(<ConversationSearch chatId="42" search={search} loadAvatar={loadAvatar} close={() => {}} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Find in this conversation" }), { target: { value: "fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  await screen.findByText("Member fixture");
  await waitFor(() => expect(container.querySelector(".mtg-message-author img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA"));
  expect(loadAvatar).toHaveBeenCalledExactlyOnceWith("77", 8, true);
});

test("submits the selected poll options only after the user clicks Vote", async () => {
  const voteInPoll = vi.fn().mockResolvedValue(true);
  render(<MessageContent chatId="-42" voteInPoll={voteInPoll} message={{
    id: "9", author: "Fixture", time: "", text: "Choose two",
    poll: {
      question: "Choose two", closed: false, canVote: true, multiple: true, quiz: false,
      options: [{ index: 1, text: "Second", chosen: false }, { index: 0, text: "First", chosen: false }],
    },
  }} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Second" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "First" }));
  expect(voteInPoll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Vote" }));
  expect(voteInPoll).toHaveBeenCalledWith("-42", "9", [
    { index: 1, text: "Second" }, { index: 0, text: "First" },
  ]);
  await waitFor(() => expect((screen.getByRole("checkbox", { name: "Second" }) as HTMLInputElement).checked).toBe(false));
});

test("refreshes matching messages after voting in a poll from search", async () => {
  let chosen = false;
  const search = vi.fn(async () => ({ messages: [{
    id: "9", author: "Fixture", time: "", text: "Fixture poll",
    poll: {
      question: "Fixture poll", closed: false, canVote: true, multiple: false, quiz: false,
      options: [{ index: 0, text: "First", chosen, percentage: chosen ? 100 : undefined }],
    },
  }], before: null }));
  const voteInPoll = vi.fn(async () => { chosen = true; return true; });
  render(<ConversationSearch chatId="-42" close={() => {}} search={search} voteInPoll={voteInPoll} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  fireEvent.click(await screen.findByRole("radio", { name: "First" }));
  fireEvent.click(screen.getByRole("button", { name: "Vote" }));
  expect(await screen.findByText("100%")).toBeTruthy();
  expect(voteInPoll).toHaveBeenCalledWith("-42", "9", [{ index: 0, text: "First" }]);
  expect(search).toHaveBeenCalledTimes(2);
});

test("copies the exact forum message reference and Telegram link from search", async () => {
  const url = "https://t.me/c/123/9";
  const loadMessageLink = vi.fn(async () => url);
  const chat = { id: "-42", name: "Fixture group", subtitle: "Group", initials: "FG",
    color: "#000000", unread: 0, messages: [] };
  const search = async () => ({ messages: [{ id: "9", text: "Fixture message", author: "Fixture", time: "", forumTopicId: 17 }], before: null });
  render(<ConversationSearch chatId={chat.id} chat={chat} close={() => {}} search={search} loadMessageLink={loadMessageLink} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  fireEvent.click(await screen.findByRole("button", { name: "Copy message reference" }));
  const reference = await screen.findByRole("textbox", { name: "Message reference" }) as HTMLInputElement;
  expect(JSON.parse(reference.value)).toEqual({ chatId: "-42", forumTopicId: 17, messageId: "9" });
  fireEvent.click(screen.getByRole("button", { name: "Copy Telegram message link" }));
  const link = await screen.findByRole("textbox", { name: "Telegram message link" }) as HTMLInputElement;
  expect(link.value).toBe(url);
  expect(loadMessageLink).toHaveBeenCalledExactlyOnceWith("-42", "9");
});

test("pastes a PNG with a caption to the selected forum topic", async () => {
  const { ForumTopics } = await import("../src/ui/forum-topics.tsx");
  const photos = await import("../src/ui/prepare-photo.ts");
  const prepare = vi.spyOn(photos, "preparePhoto").mockResolvedValue("/9j/");
  const sendPhoto = vi.fn(async () => ({
    state: "sent" as const, message: { id: "9", text: "Photo fixture", author: "You", time: "" },
  }));
  try {
    render(<ForumTopics chatId="-42" topics={[{ id: 17, name: "Fixture topic", closed: false }]}
      loadForumTopics={async () => []} loadTopicHistory={async () => ({ messages: [{ id: "8", text: "Parent fixture", author: "Fixture", time: "" }], before: null })}
      loadPhoto={undefined} saveDocument={undefined} sendPhoto={sendPhoto} close={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Fixture topic" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    const file = new File(["fixture"], "clipboard.png", { type: "image/png" });
    fireEvent.paste(screen.getByRole("textbox", { name: "Paste a topic photo or write a caption" }),
      { clipboardData: { files: [file] } });
    expect(sendPhoto).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Write a topic attachment caption" }), { target: { value: "Fixture caption" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to topic" }));
    await screen.findByText("Photo fixture");
    expect(prepare).toHaveBeenCalledExactlyOnceWith(file);
    expect(sendPhoto).toHaveBeenCalledExactlyOnceWith("-42", "Fixture caption", "/9j/", { id: 17, name: "Fixture topic" }, "8");
  } finally {
    prepare.mockRestore();
  }
});

test("appends older search matches, deduplicates them, and resets on a new query", async () => {
  const item = (id: string, text: string) => ({ id, text, author: "Fixture", time: "" });
  const search = vi.fn(async (_id: string, query: string, _filter?: unknown, _topic?: number, before?: string) => {
    if (query === "Different") return { messages: [item("42", "Different match")], before: null };
    return before ? { messages: [item("8", "First match"), item("7", "Older match")], before: null }
      : { messages: [item("8", "First match")], before: "8" };
  });
  render(<ConversationSearch chatId="-42" close={() => {}} search={search} />);
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "Fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  fireEvent.click(await screen.findByRole("button", { name: "Load more matches" }));
  expect(await screen.findByText("Older match")).toBeTruthy();
  expect(screen.getAllByText("First match")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Load more matches" })).toBeNull();
  expect(search).toHaveBeenLastCalledWith("-42", "Fixture", undefined, undefined, "8");
  fireEvent.change(input, { target: { value: "Different" } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  expect(await screen.findByText("Different match")).toBeTruthy();
  expect(screen.queryByText("Older match")).toBeNull();
});

test("copies the open chat ID for an exact agent send request", async () => {
  const chats = ["42", "43"].map((id, i) => ({
    id, name: i === 0 ? "First fixture" : "Second fixture", subtitle: "Direct message",
    initials: "FX", color: "#246dbd", messages: [],
  }));
  render(<TelegramPage live={{
    chats, folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", findChats: async () => [], sendText: vi.fn(),
    loadHistory: async () => ({ messages: [], before: null }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /First fixture/ }));
  fireEvent.click(screen.getByRole("button", { name: "Copy chat reference" }));
  const first = await screen.findByRole("textbox", { name: "Chat reference" }) as HTMLInputElement;
  expect(JSON.parse(first.value)).toEqual({ recipientId: "42" });
  fireEvent.click(screen.getByRole("button", { name: /Second fixture/ }));
  expect(screen.queryByRole("textbox", { name: "Chat reference" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy chat reference" }));
  const next = await screen.findByRole("textbox", { name: "Chat reference" }) as HTMLInputElement;
  expect(JSON.parse(next.value)).toEqual({ recipientId: "43" });
});

test("renders reactions with counts below a Telegram attachment", () => {
  render(<MessageContent chatId="-42" message={{
    id: "9", author: "Fixture", time: "", text: "Fixture attachment",
    document: { name: "Fixture.txt", downloadable: false },
    reactions: { tags: false, items: [{ type: { kind: "emoji", emoji: "👍" }, count: 3, chosen: true }] },
  }} />);
  const reactions = within(screen.getByRole("list", { name: "Message reactions" }));
  expect(reactions.getByRole("listitem").textContent).toBe("👍 3 · You reacted");
  expect(screen.getByText("Fixture.txt")).toBeTruthy();
});

test("shows Telegram's allowed reactions and only changes a reaction on a click", async () => {
  const listReactions = vi.fn(async () => ["👍", "❤️"]);
  const setReaction = vi.fn(async () => true);
  render(<MessageContent chatId="-42" reactionActions={{ listReactions, setReaction }} message={{
    id: "9", author: "Fixture", time: "", text: "Fixture",
    reactions: { tags: false, items: [{ type: { kind: "emoji", emoji: "👍" }, count: 1, chosen: true }] },
  }} />);
  fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
  const choices = within(await screen.findByRole("group", { name: "Available reactions" }));
  expect(listReactions).toHaveBeenCalledExactlyOnceWith("-42", "9");
  expect(setReaction).not.toHaveBeenCalled();
  fireEvent.click(choices.getByRole("button", { name: "React ❤️" }));
  await waitFor(() => expect(screen.queryByRole("group", { name: "Available reactions" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "React 👍, 1" }));
  await waitFor(() => expect(setReaction.mock.calls).toEqual([["-42", "9", "❤️", true], ["-42", "9", "👍", false]]));
});

test("shows a pending join request without treating it as membership", async () => {
  const joinChat = vi.fn(async () => "requested" as const);
  const refresh = vi.fn();
  render(<TelegramPage live={{
    chats: [{ id: "-42", name: "Public fixture", initials: "FX", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh, loading: false, liveRevision: 0, error: "",
    loadHistory: async () => ({ messages: [], before: null }), findChats: async () => [], sendText: vi.fn(),
    joinChat, postingPermissions: async () => ({ text: false, photo: false, document: false, join: "request" }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Public fixture/ }));
  const join = await screen.findByRole("button", { name: "Request to join" });
  expect(joinChat).not.toHaveBeenCalled();
  fireEvent.click(join);
  expect(await screen.findByText("Join request sent.")).toBeTruthy();
  expect(joinChat).toHaveBeenCalledExactlyOnceWith("-42", "Public fixture");
  expect(screen.queryByRole("button", { name: "Request to join" })).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
});

test("pastes an image into a chat draft while leaving ordinary text paste alone", async () => {
  const photos = await import("../src/ui/prepare-photo.ts");
  const prepare = vi.spyOn(photos, "preparePhoto").mockResolvedValue("/9j/");
  const sendPhoto = vi.fn(async () => ({
    state: "sent" as const, message: { id: "9", text: "Photo fixture", author: "You", time: "" },
  }));
  try {
    render(<TelegramPage live={{
      chats: [{ id: "42", name: "Photo fixture chat", initials: "FX", color: "#246dbd", subtitle: "Direct message", messages: [] }],
      folders: [], list: "main", selectList: () => {}, refresh: () => {}, loading: false, liveRevision: 0, error: "",
      loadHistory: async () => ({ messages: [], before: null }), findChats: async () => [], sendText: vi.fn(), sendPhoto,
    }} />);
    fireEvent.click(screen.getByRole("button", { name: /Photo fixture chat/ }));
    const field = screen.getByRole("textbox", { name: "Write a message" });
    expect(fireEvent.paste(field, { clipboardData: { files: [], getData: () => "Fixture text" } })).toBe(true);
    fireEvent.change(field, { target: { value: "Photo caption fixture" } });
    const file = new File(["fixture"], "clipboard.png", { type: "image/png" });
    expect(fireEvent.paste(field, { clipboardData: { files: [file] } })).toBe(false);
    expect(await screen.findByRole("img", { name: "Selected photo" })).toBeTruthy();
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledExactlyOnceWith(file);
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide photo under a spoiler" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show caption above media" }));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendPhoto).toHaveBeenCalledExactlyOnceWith(
      "42", "Photo caption fixture", "/9j/", undefined, undefined, { spoiler: true, captionAbove: true },
    ));
  } finally {
    prepare.mockRestore();
  }
});

test("retries failed avatar downloads while visible and pauses them offscreen", async () => {
  let update!: IntersectionObserverCallback;
  class Observer {
    constructor(callback: IntersectionObserverCallback) { update = callback; }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.useFakeTimers();
  const load = vi.fn()
    .mockRejectedValueOnce(new Error("First transient failure"))
    .mockRejectedValueOnce(new Error("Second transient failure"))
    .mockResolvedValueOnce({ mime: "image/webp", base64: "AAAA" });
  const chat = { id: "42", initials: "FX", color: "#246dbd", avatarJpeg: "/9j/AA==", avatarFileId: 7 };
  try {
    const { container } = render(<Avatar chat={chat} load={load} />);
    const reveal = (isIntersecting: boolean) => act(async () => update(
      [{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver,
    ));
    const src = () => container.querySelector("img")?.getAttribute("src");
    expect(load).not.toHaveBeenCalled();
    await reveal(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(src()).toBe("data:image/jpeg;base64,/9j/AA==");
    await reveal(false);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(load).toHaveBeenCalledTimes(1);
    await reveal(true);
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(load).toHaveBeenCalledTimes(3);
    expect(src()).toBe("data:image/webp;base64,AAAA");
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

test("opens the exact linked message and keeps its forum topic when loading context", async () => {
  const chat = { id: "-42", name: "Linked fixture group", initials: "FG", color: "#246dbd", subtitle: "Group", messages: [] };
  const url = "https://t.me/c/123/17/9";
  const resolveMessageLink = vi.fn(async () => ({ chat, messageId: "9", topicId: 17 }));
  const findChats = vi.fn(async () => []);
  const loadMessageContext = vi.fn(async () => [{ id: "9", text: "Linked fixture message", author: "Fixture", time: "" }]);
  render(<TelegramPage live={{
    chats: [], folders: [], list: "main", selectList: () => {}, refresh: () => {}, loading: false, liveRevision: 0, error: "",
    loadHistory: async () => ({ messages: [], before: null }), findChats, sendText: vi.fn(), resolveMessageLink, loadMessageContext,
  }} />);
  fireEvent.click(screen.getByRole("button", { name: "People" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Telegram chats" }), { target: { value: url } });
  const target = await screen.findByRole("button", { name: /Linked fixture group.*Open linked message/ });
  expect(resolveMessageLink).toHaveBeenCalledExactlyOnceWith(url);
  expect(findChats).not.toHaveBeenCalled();
  expect(loadMessageContext).not.toHaveBeenCalled();
  fireEvent.click(target);
  const message = await screen.findByText("Linked fixture message");
  expect(message.closest("li")?.getAttribute("aria-current")).toBe("true");
  expect(loadMessageContext).toHaveBeenCalledExactlyOnceWith("-42", "9", 17);
});

test("previews a private Telegram invitation before the user requests to join", async () => {
  const url = "https://t.me/+fixture_invite";
  const invite = { title: "Private fixture", kind: "Group" as const, mode: "request" as const, memberCount: 12 };
  const previewInvite = vi.fn(async () => invite);
  const joinInvite = vi.fn(async () => "requested" as const);
  const findChats = vi.fn(async () => []);
  render(<TelegramPage live={{
    chats: [], folders: [], list: "main", selectList: () => {}, refresh: () => {}, loading: false, liveRevision: 0, error: "",
    loadHistory: async () => ({ messages: [], before: null }), findChats, sendText: vi.fn(), previewInvite, joinInvite,
  }} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Telegram chats" }), { target: { value: url } });
  const join = await screen.findByRole("button", { name: "Request to join" });
  expect(screen.getByText("Private fixture")).toBeTruthy();
  expect(previewInvite).toHaveBeenCalledExactlyOnceWith(url);
  expect(findChats).not.toHaveBeenCalled();
  expect(joinInvite).not.toHaveBeenCalled();
  fireEvent.click(join);
  expect(await screen.findByText("Join request sent.")).toBeTruthy();
  expect(joinInvite).toHaveBeenCalledExactlyOnceWith(url, { title: "Private fixture", kind: "Group", mode: "request" });
});

test("keeps one chat details trigger across chat changes and scopes keyboard shortcuts to the conversation", async () => {
  const chats = ["First", "Second"].map((name, index) => ({
    id: String(index + 42), name: name + " fixture", initials: "FX", color: "#246dbd",
    subtitle: "Group", archived: false, messages: [],
  }));
  const chatAgentAccess = vi.fn(async () => false);
  const { container } = render(<TelegramPage live={{
    chats, folders: [], list: "main", selectList: () => {}, refresh: () => {}, loading: false,
    liveRevision: 0, error: "", loadHistory: async () => ({ messages: [], before: null }),
    findChats: async () => [], sendText: vi.fn(), chatAgentAccess,
    setChatAgentAccess: vi.fn(async () => true), chatNotificationState: async () => ({ mode: "default" }),
    setChatNotificationMode: async () => "updated", searchMessages: async () => ({ messages: [], before: null }),
  }} />);
  for (const name of ["First", "Second", "First", "Second"]) {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(name + " fixture") }));
    expect(screen.getAllByRole("button", { name: "Chat details" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Chat notification settings" })).toBeNull();
  }
  const details = screen.getByRole("button", { name: "Chat details" });
  const dialog = container.querySelector("dialog")!;
  dialog.showModal = () => { dialog.open = true; };
  const shortcut = { code: "KeyI", altKey: true, shiftKey: true };
  fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search Telegram chats" }), shortcut);
  expect(dialog.open).toBe(false);
  fireEvent.keyDown(details, shortcut);
  const settings = screen.getByRole("dialog", { name: "Chat details" });
  expect(await within(settings).findByRole("checkbox")).toBeTruthy();
  expect(within(settings).getAllByRole("button", { name: "Chat notification settings" })).toHaveLength(1);
  expect(chatAgentAccess).toHaveBeenCalledExactlyOnceWith("43");
});

test("pins and unpins the selected chat in the selected folder", async () => {
  let pinned = false;
  const chatPinStatus = vi.fn(async (_id: string, _list: number | string) => pinned);
  const setChatPinned = vi.fn(async (_id: string, _list: number | string, next: boolean) => {
    pinned = next;
    return "updated" as const;
  });
  render(<TelegramPage live={{
    chats: [{ id: "-42", name: "Folder chat fixture", initials: "FX", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [{ id: 7, title: "Fixture folder" }], list: 7, selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadHistory: async () => ({ messages: [], before: null }),
    findChats: async () => [], sendText: vi.fn(), chatPinStatus, setChatPinned,
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Folder chat fixture/ }));
  const dialog = document.querySelector("dialog")!;
  dialog.showModal = () => { dialog.open = true; };
  fireEvent.click(screen.getByRole("button", { name: "Chat details" }));
  fireEvent.click(await screen.findByRole("button", { name: "Pin chat in this list" }));
  fireEvent.click(await screen.findByRole("button", { name: "Unpin chat from this list" }));
  await screen.findByRole("button", { name: "Pin chat in this list" });
  expect(setChatPinned.mock.calls).toEqual([["-42", 7, true], ["-42", 7, false]]);
});

test("forwards only after the user selects a specific destination and clicks Forward", async () => {
  const forwardOptions = vi.fn(async () => true);
  const forwardMessage = vi.fn(async () => "sent" as const);
  const chats = ["42", "43"].map((id) => ({ id, name: "Same fixture", subtitle: "Direct message",
    initials: "FX", color: "#246dbd", messages: [] }));
  render(<MessageContent chatId="-42" message={{ id: "9", text: "Fixture message", author: "Fixture", time: "" }}
    forwardActions={{ forwardOptions, forwardMessage, searchRecipients: async () => [], recipients: chats }} />);
  fireEvent.click(screen.getByRole("button", { name: "Forward message" }));
  const destination = await screen.findByRole("combobox", { name: "Forward to" });
  fireEvent.change(destination, { target: { value: "43" } });
  expect(forwardMessage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Forward" }));
  await screen.findByText("Message forwarded.");
  expect(forwardOptions).toHaveBeenCalledExactlyOnceWith("-42", "9");
  expect(forwardMessage).toHaveBeenCalledExactlyOnceWith("-42", "9", { id: "43", name: "Same fixture", kind: "Direct message" });
});

test("requires an explicit topic when forwarding to a forum", async () => {
  const loadTopics = vi.fn(async () => [{ id: 17, name: "Topic fixture", closed: false }]);
  const forwardMessage = vi.fn(async () => "sent" as const);
  render(<MessageContent chatId="-42" message={{ id: "9", author: "Fixture", text: "Fixture", time: "" }}
    forwardActions={{
      forwardOptions: async () => true, forwardMessage, loadTopics, searchRecipients: async () => [],
      recipients: [{ id: "-43", name: "Forum fixture", initials: "FF", color: "#246dbd", subtitle: "Group", messages: [] }],
    }} />);
  fireEvent.click(screen.getByRole("button", { name: "Forward message" }));
  fireEvent.change(await screen.findByRole("combobox", { name: "Forward to" }), { target: { value: "-43" } });
  const topic = await screen.findByRole("combobox", { name: "Forward to topic" });
  const send = screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.change(topic, { target: { value: "17" } });
  fireEvent.click(send);
  await screen.findByText("Message forwarded.");
  expect(loadTopics).toHaveBeenCalledExactlyOnceWith("-43", "");
  expect(forwardMessage).toHaveBeenCalledExactlyOnceWith("-42", "9",
    { id: "-43", name: "Forum fixture", kind: "Group", topic: { id: 17, name: "Topic fixture" } });
});

test("requires separate consent for each note in a batch approval", async () => {
  const submit = vi.fn(async () => {});
  const load = vi.fn(async (_request: string, id: string) => "Fixture text " + id);
  render(<AgentReadApproval payload={{
    requestId: "00000000-0000-4000-8000-000000000001", source: "Fixture source", maxMessages: 2,
    notes: [{ id: "1", time: "10:00" }, { id: "2", time: "10:01" }],
  }} submit={submit} cancel={async () => {}} load={load} />);
  const messages = screen.getByRole("combobox", { name: "Message" });
  for (const id of ["1", "2"]) {
    fireEvent.change(messages, { target: { value: id } });
    await screen.findByText(`Fixture text ${id}`);
    const consent = screen.getByRole("checkbox") as HTMLInputElement;
    expect(consent.checked).toBe(false);
    fireEvent.click(consent);
  }
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Approve 2" }));
  await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith({
    entries: [{ id: "1", authorConsent: true }, { id: "2", authorConsent: true }],
  }));
});

test("copies an existing Telegram draft only when the user selects it", async () => {
  const sendText = vi.fn();
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Draft fixture chat", initials: "DF", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {}, loading: false, liveRevision: 0, error: "",
    loadHistory: async () => ({ messages: [], before: null, draft: "Cloud draft fixture" }), findChats: async () => [], sendText,
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Draft fixture chat/ }));
  const use = await screen.findByRole("button", { name: "Use Telegram draft" });
  const composer = screen.getByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement;
  expect(composer.value).toBe("");
  fireEvent.click(use);
  expect(composer.value).toBe("Cloud draft fixture");
  expect(sendText).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Use Telegram draft" })).toBeNull();
});

test("publishes a poll only after the user fills two distinct options and submits", async () => {
  const send = vi.fn(async () => ({
    state: "sent" as const, message: { id: "90", author: "You", time: "", text: "Fixture question" },
  }));
  render(<PollComposer chatId="-42" topic={{ id: 17, name: "Fixture topic" }} send={send} />);
  fireEvent.click(screen.getByRole("button", { name: "Create poll" }));
  for (const [label, value] of [["Question", "Fixture question"], ["Option 1", "First"], ["Option 2", "FIRST"]]) {
    fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });
  }
  const publish = screen.getByRole("button", { name: "Publish poll" }) as HTMLButtonElement;
  expect(publish.disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Option 2" }), { target: { value: "Second" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Allow multiple answers" }));
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(publish);
  await screen.findByText("Poll published.");
  expect(send).toHaveBeenCalledExactlyOnceWith("-42", {
    question: "Fixture question", options: ["First", "Second"], multiple: true,
  }, { id: 17, name: "Fixture topic" });
});

test("ends a Telegram poll only after the user confirms closure", async () => {
  const stopPoll = vi.fn(async () => true);
  render(<MessageContent chatId="-42" stopPoll={stopPoll} message={{
    id: "12", author: "You", time: "", text: "Fixture poll", canStopPoll: true,
    poll: { question: "Fixture poll", closed: false, canVote: true, multiple: false, quiz: false,
      options: [{ index: 0, text: "First", chosen: false }, { index: 1, text: "Second", chosen: false }] },
  }} />);
  fireEvent.click(screen.getByRole("button", { name: "End poll" }));
  expect(stopPoll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(stopPoll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "End poll" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm end poll" }));
  await screen.findByText("Closed poll");
  expect(stopPoll).toHaveBeenCalledExactlyOnceWith("-42", "12");
  expect(screen.queryByRole("button", { name: "End poll" })).toBeNull();
});

test("loads a playable voice message only on demand and revokes its object URL on close", async () => {
  const createObjectURL = vi.fn(() => "blob:fixture");
  const revokeObjectURL = vi.fn();
  const loadMedia = vi.fn(async () => new Blob(["fixture bytes"]));
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
  try {
    const { container } = render(<MessageContent chatId="-42" loadMedia={loadMedia} message={{
      id: "9", author: "Fixture", time: "", text: "Fixture voice", voiceNote: true,
      document: { name: "Fixture voice.ogg", downloadable: true, playbackMime: "audio/ogg" },
    }} />);
    expect(loadMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load audio player" }));
    await waitFor(() => expect(container.querySelector("audio")?.getAttribute("src")).toBe("blob:fixture"));
    expect(loadMedia).toHaveBeenCalledExactlyOnceWith("-42", "9", expect.any(AbortSignal));
    expect(createObjectURL.mock.calls).toHaveLength(1);
    fireEvent.change(screen.getByRole("combobox", { name: "Playback speed" }), { target: { value: "1.5" } });
    expect(container.querySelector("audio")?.playbackRate).toBe(1.5);
    fireEvent.click(screen.getByRole("button", { name: "Close player" }));
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:fixture");
    expect(container.querySelector("audio")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("opens a one-view photo on demand and keeps it visible when expiry arrives", async () => {
  const loadMedia = vi.fn(async () => new Blob(["fixture bytes"], { type: "image/jpeg" }));
  const createObjectURL = vi.fn(() => "blob:fixture");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
  try {
    const message = { id: "15", author: "Fixture", time: "", text: "One-view photo", oneView: "photo" as const };
    const view = render(<MessageContent chatId="42" loadMedia={loadMedia} message={message} />);
    expect(loadMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View and save photo" }));
    await screen.findByRole("img", { name: "Telegram one-view photo" });
    view.rerender(<MessageContent chatId="42" loadMedia={loadMedia} message={{ ...message, retained: "expired" }} />);
    expect(screen.getByRole("img", { name: "Telegram one-view photo" }).getAttribute("src")).toBe("blob:fixture");
    expect(loadMedia).toHaveBeenCalledExactlyOnceWith("42", "15", expect.any(AbortSignal), true);
    fireEvent.click(screen.getByRole("button", { name: "Close player" }));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fixture");
    fireEvent.click(screen.getByRole("button", { name: "Open saved photo" }));
    await screen.findByRole("img", { name: "Telegram one-view photo" });
    expect(loadMedia).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("keeps one send-options and media panel across chat refreshes", async () => {
  const sendText = vi.fn(async () => ({ state: "sent" as const, message: {
    id: "22", text: "Quiet fixture", author: "You", time: "", outgoing: true,
  } }));
  const live = {
    chats: [{ id: "42", name: "Fixture", initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main" as const, selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadHistory: async () => ({ messages: [], before: null }),
    findChats: async () => [], sendText, scheduledMessages: async () => [], cancelScheduledMessage: async () => true,
    mediaComposer: () => ({
      choices: async () => [], sendChoice: async () => "sent", sendAlbum: async () => "sent", sendVoice: async () => "sent",
    }),
  };
  const page = render(<TelegramPage live={live} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Send options" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Quiet fixture" } });
  page.rerender(<TelegramPage live={{ ...live, liveRevision: 1 }} />);
  expect(screen.getAllByRole("button", { name: "Send options" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: /^Voice$/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Send silently" }));
  await screen.findByText("Sent silently.");
  expect(sendText).toHaveBeenCalledExactlyOnceWith("42", "Quiet fixture", undefined, { silent: true });
});

test("loads shared media immediately and switches to files without a search phrase", async () => {
  const { ConversationSearch } = await import("../src/ui/conversation-search.tsx");
  const search = vi.fn(async (_id: string, _query: string, filter?: string) => ({
    messages: [{
      id: filter === "document" ? "22" : "21",
      text: filter === "document" ? "File fixture" : "Media fixture",
      author: "Fixture", time: "",
    }],
    before: null,
  }));
  render(<ConversationSearch chatId="42" initialFilter="photoVideo" search={search} close={() => {}} />);
  await screen.findByText("Media fixture");
  expect(screen.getByRole("list", { name: "Media gallery" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "List" }));
  expect(screen.getByRole("list", { name: "Matching messages" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Grid" }));
  expect(screen.getByRole("list", { name: "Media gallery" })).toBeTruthy();
  expect(search).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("combobox", { name: "Search message type" }), { target: { value: "document" } });
  await screen.findByText("File fixture");
  expect(screen.queryByText("Media fixture")).toBeNull();
  expect(search.mock.calls).toEqual([["42", "", "photoVideo"], ["42", "", "document"]]);
});

test("opens nearby messages using the end of the selected local calendar day", async () => {
  const loadAtDate = vi.fn(async () => "27");
  const loadContext = vi.fn(async () => [{ id: "27", author: "Fixture", text: "Date fixture", time: "" }]);
  render(<TelegramPage live={{
    chats: [{ id: "-42", name: "Fixture room", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "",
    loadHistory: async () => ({ before: null, messages: [
      { id: "29", text: "Fixture", author: "Fixture", time: "", timestamp: new Date(2026, 2, 30, 9).getTime() / 1000 },
    ] }),
    findChats: async () => [], sendText: async () => ({ state: "failed" }),
    loadMessageAtDate: loadAtDate, loadMessageContext: loadContext,
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture room/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^Jump to date from/ }));
  const date = screen.getByLabelText<HTMLInputElement>("Jump to date");
  expect(date.value).toBe("2026-03-30");
  fireEvent.change(date, { target: { value: "2026-03-29" } });
  fireEvent.click(screen.getByRole("button", { name: "Go to date" }));
  const nearby = await screen.findByRole("list", { name: "Nearby messages" });
  expect(within(nearby).getByRole("listitem").getAttribute("aria-current")).toBe("true");
  expect(loadAtDate).toHaveBeenCalledExactlyOnceWith("-42", new Date(2026, 2, 30).getTime() / 1000 - 1);
  expect(loadContext).toHaveBeenCalledExactlyOnceWith("-42", "27");
  fireEvent.click(screen.getByRole("button", { name: "Back to search" }));
  expect(screen.queryByRole("list", { name: "Nearby messages" })).toBeNull();
});

test("loads earlier and newer context on demand and stops at an empty boundary", async () => {
  const { ConversationSearch } = await import("../src/ui/conversation-search.tsx");
  const fixture = (id: string) => ({ id, text: `Context ${id}`, author: "Fixture", time: "" });
  const loadContextPage = vi.fn(async (_chat: string, boundary: string, direction: string) => {
    if (boundary === "20" && direction === "older") return [fixture("19")];
    if (boundary === "21" && direction === "newer") return [fixture("22")];
    return [];
  });
  render(<ConversationSearch chatId="-42" initialMessage="20" topicId={17}
    loadContext={async () => [fixture("20"), fixture("21")]} loadContextPage={loadContextPage} close={() => {}} />);
  const nearby = await screen.findByRole("list", { name: "Nearby messages" });
  expect(loadContextPage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
  await within(nearby).findByText("Context 19");
  fireEvent.click(screen.getByRole("button", { name: "Load newer messages" }));
  await within(nearby).findByText("Context 22");
  fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
  await screen.findByRole("button", { name: "No earlier messages" });
  expect(loadContextPage.mock.calls).toEqual([["-42", "20", "older", 17], ["-42", "21", "newer", 17], ["-42", "19", "older", 17]]);
  expect(nearby.querySelector('[aria-current="true"]')?.getAttribute("data-context-id")).toBe("20");
});

test("opens sender search from a group author and retains the sender when filtering by text", async () => {
  const sender = { kind: "user" as const, id: "7" };
  const item = { id: "21", author: "Fixture Author", text: "Group fixture", time: "", sender };
  const searchMessages = vi.fn(async () => ({ before: null, messages: [item] }));
  render(<TelegramPage live={{
    chats: [{ id: "-42", name: "Sender fixture", initials: "SF", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", searchMessages, findChats: async () => [], sendText: vi.fn(),
    loadHistory: async () => ({ before: null, messages: [item] }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /^Sender fixture/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Search messages by Fixture Author" }));
  const search = within(await screen.findByRole("region", { name: "Conversation search" }));
  await search.findByText("Group fixture");
  expect(searchMessages).toHaveBeenLastCalledWith("-42", "", undefined, undefined, undefined, sender);
  fireEvent.change(search.getByRole("searchbox"), { target: { value: "fixture" } });
  fireEvent.click(search.getByRole("button", { name: "Find" }));
  await vi.waitFor(() => expect(searchMessages).toHaveBeenLastCalledWith("-42", "fixture", undefined, undefined, undefined, sender));
  fireEvent.click(search.getByRole("button", { name: "Clear author" }));
  await vi.waitFor(() => expect(searchMessages).toHaveBeenLastCalledWith("-42", "fixture"));
});

test("opens unread mentions from the chat header and disables text matching in that view", async () => {
  const searchMessages = vi.fn(async () => ({ before: null, messages: [] }));
  render(<TelegramPage live={{
    chats: [{ id: "-42", name: "Mention fixture", initials: "MF", color: "#246dbd", subtitle: "Group", unreadMentions: 2, messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", searchMessages, findChats: async () => [], sendText: vi.fn(),
    loadHistory: async () => ({ before: null, messages: [] }),
  }} />);
  expect(screen.getByLabelText("2 unread mentions or replies")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Mention fixture/ }));
  fireEvent.click(screen.getByRole("button", { name: "Unread mentions and replies" }));
  const search = within(await screen.findByRole("region", { name: "Conversation search" }));
  await search.findByText("No matching messages");
  expect((search.getByRole("searchbox") as HTMLInputElement).disabled).toBe(true);
  expect(searchMessages).toHaveBeenCalledExactlyOnceWith("-42", "", "unreadMentions");
});

test("opens the unread reaction list directly from its chat badge", async () => {
  const searchMessages = vi.fn(async () => ({ before: null, messages: [] }));
  render(<TelegramPage live={{
    chats: [{ id: "-42", name: "Reaction fixture", initials: "RF", color: "#246dbd", subtitle: "Group", unreadReactions: 2, messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", searchMessages, findChats: async () => [], sendText: vi.fn(),
    loadHistory: async () => ({ before: null, messages: [] }),
  }} />);
  expect(screen.getByLabelText("2 messages with unread reactions")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Reaction fixture/ }));
  fireEvent.click(screen.getByRole("button", { name: "Unread reactions" }));
  const search = within(await screen.findByRole("region", { name: "Conversation search" }));
  await search.findByText("No matching messages");
  expect((search.getByRole("searchbox") as HTMLInputElement).disabled).toBe(true);
  expect(searchMessages).toHaveBeenCalledExactlyOnceWith("-42", "", "unreadReactions");
});

test("marks forum reactions only after an explicit click and refreshes the activity list", async () => {
  const { ConversationSearch } = await import("../src/ui/conversation-search.tsx");
  let unread = true;
  const search = vi.fn(async () => ({
    before: null, messages: unread ? [{ id: "27", text: "Reaction fixture", author: "Fixture", time: "" }] : [],
  }));
  const markActivityRead = vi.fn(async () => { unread = false; return true; });
  render(<ConversationSearch chatId="-42" topicId={17} initialFilter="unreadReactions"
    search={search} markActivityRead={markActivityRead} close={() => {}} />);
  await screen.findByText("Reaction fixture");
  expect(markActivityRead).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Mark all reactions read" }));
  await screen.findByText("No matching messages");
  expect(markActivityRead).toHaveBeenCalledExactlyOnceWith("-42", "unreadReactions", 17);
  expect(search.mock.calls).toEqual([["-42", "", "unreadReactions", 17], ["-42", "", "unreadReactions", 17]]);
});

test("shows a Telegram link card as text and a safe link while respecting spoilers", async () => {
  const { MessageContent } = await import("../src/ui/message-content.tsx");
  const message = { id: "7", text: "Fixture message", author: "Fixture", time: "", linkPreview: {
    url: "https://example.com/fixture", site: "Fixture site", title: "Fixture page", description: "Fixture summary", above: false,
  } };
  const view = render(<MessageContent chatId="42" message={message} />);
  expect(screen.getByRole("link", { name: /Fixture page/ }).getAttribute("href")).toBe("https://example.com/fixture");
  expect(view.container.querySelector("img")).toBeNull();
  view.rerender(<MessageContent chatId="42" message={{ ...message, styles: [{ offset: 0, length: 7, style: "spoiler" }] }} />);
  expect(screen.queryByRole("link", { name: /Fixture page/ })).toBeNull();
});

test("formats selected UTF-16 text and sends ranges relative to the trimmed draft", async () => {
  const sendText = vi.fn(async () => ({ state: "sent" as const, message: { id: "12", author: "You", text: "🙂 fixture", time: "" } }));
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Format fixture", initials: "FF", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", findChats: async () => [], sendText,
    loadHistory: async () => ({ before: null, messages: [] }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /^Format fixture/ }));
  const editor = await screen.findByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: " 🙂 fixture  " } });
  fireEvent.click(screen.getByRole("button", { name: "Format message" }));
  editor.setSelectionRange(1, 3);
  fireEvent.select(editor);
  const bold = within(screen.getByRole("group", { name: "Message formatting" })).getByRole("button", { name: "Bold" });
  fireEvent.click(bold);
  expect(bold.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByLabelText("Formatted message preview").querySelector(".mtg-text-bold")?.textContent).toBe("🙂");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await vi.waitFor(() => expect(sendText).toHaveBeenCalledExactlyOnceWith("42", "🙂 fixture", undefined,
    { styles: [{ offset: 0, length: 2, style: "bold" }] }));
});

test("previews the styles retained after editing a formatted message", async () => {
  const { MessageEdit } = await import("../src/ui/message-edit.tsx");
  const view = render(<MessageEdit draft={{ busy: false, text: "New text", message: {
    id: "25", text: "Fixture text", author: "You", time: "", styles: [{ offset: 0, length: 7, style: "bold" }],
  } }} change={() => {}} cancel={() => {}} save={() => {}} />);
  expect(view.getByLabelText("Formatted edit preview").querySelector(".mtg-text-bold")?.textContent).toBe("New");
});

test("edits formatting alone and clears retained formatting explicitly", async () => {
  const { MessageEdit } = await import("../src/ui/message-edit.tsx");
  const save = vi.fn();
  const style = { offset: 0, length: 7, style: "bold" as const };
  render(<MessageEdit draft={{ busy: false, text: "Fixture text", message: {
    id: "25", text: "Fixture text", author: "You", time: "", styles: [style],
  } }} change={() => {}} cancel={() => {}} save={save} />);
  const button = screen.getByRole("button", { name: "Save edit" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Format message" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear formatting" }));
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.anything(), []);
});

test("sends multiline drafts on plain Enter, without submitting on Shift+Enter or IME confirmation", async () => {
  const sendText = vi.fn(async () => ({ state: "failed" as const }));
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Multiline fixture", initials: "MF", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", findChats: async () => [], sendText,
    loadHistory: async () => ({ before: null, messages: [] }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /^Multiline fixture/ }));
  const editor = await screen.findByRole("textbox", { name: "Write a message" }) as HTMLTextAreaElement;
  expect(editor.tagName).toBe("TEXTAREA");
  fireEvent.keyDown(editor, { key: "Enter" });
  expect(sendText).not.toHaveBeenCalled();
  fireEvent.change(editor, { target: { value: "First fixture line\nSecond fixture line" } });
  expect(fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(editor, { key: "Enter", isComposing: true })).toBe(true);
  expect(fireEvent.keyDown(editor, { key: "Enter", keyCode: 229 })).toBe(true);
  fireEvent.keyDown(editor, { key: "Enter", repeat: true });
  expect(sendText).not.toHaveBeenCalled();
  expect(fireEvent.keyDown(editor, { key: "Enter" })).toBe(false);
  await vi.waitFor(() => expect(sendText).toHaveBeenCalledExactlyOnceWith("42", "First fixture line\nSecond fixture line"));
});

test("adds the selected passage to a text reply without changing its original reference", async () => {
  const sendText = vi.fn(async () => ({ state: "failed" as const }));
  const message = { id: "24", author: "Fixture", text: "🙂 Fixture quote", time: "", canQuote: true as const };
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Quote fixture", initials: "QF", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", findChats: async () => [], sendText,
    loadHistory: async () => ({ before: null, messages: [message] }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /^Quote fixture/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Reply to message" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose quote" }));
  const source = screen.getByRole("textbox", { name: "Select the passage to quote" }) as HTMLTextAreaElement;
  source.focus();
  source.setSelectionRange(3, 10);
  fireEvent.select(source);
  fireEvent.click(screen.getByRole("button", { name: "Use selected quote" }));
  expect(screen.getByRole("button", { name: "Remove quote" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Write a message" }), { target: { value: "Reply fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await vi.waitFor(() => expect(sendText).toHaveBeenCalledExactlyOnceWith("42", "Reply fixture", "24",
    { quote: { text: "Fixture", position: 3 } }));
});

test("changes the selected scheduled row without using the current draft", async () => {
  const { ScheduledMessages } = await import("../src/ui/scheduled-messages.tsx");
  const date = new Date(2037, 0, 2, 12, 30);
  const row = { id: "22", text: "Scheduled fixture", at: Math.floor(date.getTime() / 1000) - 3600 };
  let rows = [row];
  const load = vi.fn(async () => rows);
  const change = vi.fn(async (_id: string, expected: Omit<typeof row, "at"> & { at?: number }, at: number | null) => {
    rows = at === null ? [] : [{ ...expected, at }];
    return "updated" as const;
  });
  const send = vi.fn();
  render(<ScheduledMessages chatId="42" liveRevision={0} draft="" canSend={false} load={load} change={change}
    send={send} cancel={vi.fn()} accepted={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Send options" }));
  const list = await screen.findByRole("list", { name: "Scheduled messages" });
  fireEvent.click(within(list).getByRole("button", { name: "Reschedule" }));
  fireEvent.input(within(list).getByLabelText("New send time"), { target: { value: "2037-01-02T12:30" } });
  fireEvent.click(within(list).getByRole("button", { name: "Save new send time" }));
  await screen.findByText("Schedule updated.");
  const next = Math.floor(date.getTime() / 1000);
  fireEvent.click(within(list).getByRole("button", { name: "Send now" }));
  await screen.findByText("No scheduled messages.");
  expect(change.mock.calls).toEqual([["42", row, next], ["42", { ...row, at: next }, null]]);
  expect(send).not.toHaveBeenCalled();
});

test("shows online scheduling only after eligibility is confirmed and schedules the current draft", async () => {
  const { ScheduledMessages } = await import("../src/ui/scheduled-messages.tsx");
  const checkOnline = vi.fn(async () => true);
  const send = vi.fn(async () => ({ state: "sent" as const, message: { id: "22", text: "Fixture", author: "You", time: "" } }));
  const accepted = vi.fn();
  render(<ScheduledMessages chatId="42" liveRevision={0} draft="Fixture" canSend
    load={async () => []} checkOnline={checkOnline} send={send} cancel={vi.fn()} accepted={accepted} />);
  expect(checkOnline).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send options" }));
  fireEvent.click(await screen.findByRole("button", { name: "Send when online" }));
  await screen.findByText("Scheduled.");
  expect(send).toHaveBeenCalledExactlyOnceWith({ silent: false, whenOnline: true });
  expect(accepted).toHaveBeenCalledExactlyOnceWith("Fixture", expect.objectContaining({ state: "sent" }), true);
});

test("offers a repeat interval after Premium eligibility and forwards the selected interval", async () => {
  const { ScheduledMessages } = await import("../src/ui/scheduled-messages.tsx");
  const send = vi.fn(async () => ({ state: "sent" as const, message: { id: "22", text: "Fixture", author: "You", time: "" } }));
  render(<ScheduledMessages chatId="42" liveRevision={0} draft="Fixture" canSend
    load={async () => []} checkRepeat={async () => true} send={send} cancel={vi.fn()} accepted={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Send options" }));
  fireEvent.change(await screen.findByLabelText("Repeat"), { target: { value: "604800" } });
  fireEvent.input(screen.getByLabelText("Send at"), { target: { value: "2037-01-02T12:30" } });
  fireEvent.click(screen.getByRole("button", { name: "Schedule message" }));
  await screen.findByText("Scheduled.");
  expect(send).toHaveBeenCalledExactlyOnceWith({
    silent: false, at: new Date("2037-01-02T12:30").getTime() / 1000, repeatEvery: 604800,
  });
});

test("renders service notices as timeline rows with their message IDs", async () => {
  const loadMessageContext = vi.fn(async () => [{ id: "15", text: "Pinned fixture target", author: "Fixture", time: "" }]);
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Fixture room", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "",
    loadHistory: async () => ({ before: null, messages: [
      { id: "10", text: "Message auto-delete set to 7 days", author: "Fixture", time: "", service: true },
      { id: "11", text: "Message pinned", author: "Fixture", time: "", service: true, pinnedTargetId: "15" },
      { id: "12", text: "Message pinned", author: "Fixture", time: "", service: true },
      { id: "20", text: "Ordinary fixture message", author: "Fixture", time: "" },
    ] }),
    loadMessageContext,
    findChats: async () => [], sendText: async () => ({ state: "failed" }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture room/ }));
  const history = within(screen.getByRole("list", { name: "Messages" }));
  const notice = await history.findByText("Message auto-delete set to 7 days");
  expect(notice.matches("li.mtg-service-message[data-message-id='10']")).toBe(true);
  const ordinary = history.getByText("Ordinary fixture message");
  expect(ordinary.closest(".mtg-bubble")).toBeTruthy();
  const open = history.getByRole("button", { name: "Open pinned message" });
  expect(open.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe("11");
  fireEvent.click(open);
  await screen.findByText("Pinned fixture target");
  expect(loadMessageContext).toHaveBeenCalledExactlyOnceWith("42", "15");
});

test("removes a link card from the chat editor without changing the message text", async () => {
  const url = "https://example.org/";
  const text = `Fixture ${url}`;
  const original = { id: "10", text, author: "You", time: "", editable: true, outgoing: true };
  const editText = vi.fn(async () => ({ state: "sent" as const, message: original }));
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Fixture room", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "",
    loadHistory: async () => ({ before: null, messages: [{ ...original, linkPreview: {
      url, site: "Fixture", title: "Fixture link card", description: "", above: false,
    } }] }),
    findChats: async () => [], sendText: async () => ({ state: "failed" }), editText,
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture room/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit message" }));
  const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save edit" });
  expect(save.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Remove link preview" }));
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(screen.queryByText("Fixture link card")).toBeNull());
  expect(editText).toHaveBeenCalledExactlyOnceWith("42", "10", text, text, undefined, undefined, url);
});

test("keeps one viewer control and its open panel across repeated history updates", async () => {
  const message = { id: "10", text: "Fixture sent message", author: "You", time: "", outgoing: true };
  const live = {
    chats: [{ id: "-42", name: "Fixture group", initials: "F", color: "#246dbd", subtitle: "Group", messages: [] }],
    folders: [], list: "main" as const, selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "",
    loadHistory: vi.fn(async () => ({ before: null, messages: [message] })),
    findChats: async () => [], sendText: async () => ({ state: "failed" as const }),
    messageViewers: vi.fn(async () => []),
  };
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const view = render(<TelegramPage live={live} />);
    fireEvent.click(screen.getByRole("button", { name: /Fixture group/ }));
    const history = within(screen.getByRole("list", { name: "Messages" }));
    await history.findByRole("button", { name: "Who viewed this message" });
    const viewers = await history.findByRole("button", { name: "Who viewed this message" });
    fireEvent.click(viewers);
    const panel = await history.findByText("No recorded viewers yet.");
    expect(viewers.parentElement).toContain(panel);
    for (let revision = 1; revision <= 3; revision++) {
      const text = `Fixture update ${revision}`;
      live.loadHistory.mockResolvedValueOnce({ before: null, messages: [{ ...message, text }] });
      view.rerender(<TelegramPage live={{ ...live, liveRevision: revision }} />);
      await history.findByText(text);
      expect(history.getAllByRole("button", { name: "Who viewed this message" })).toEqual([viewers]);
      expect(history.getAllByText("No recorded viewers yet.")).toEqual([panel]);
    }
    expect(live.messageViewers).toHaveBeenCalledExactlyOnceWith("-42", "10");
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/same key|unique.*key/);
  } finally {
    log.mockRestore();
  }
});

test("shows only colored folder tags for chats that belong to those folders", () => {
  const live = {
    chats: [{ id: "42", name: "Fixture room", initials: "F", color: "#246dbd", subtitle: "Group",
      folderIds: [3, 1, 2], messages: [] }],
    folders: [{ id: 1, title: "No color" }, { id: 3, title: "Blue folder", color: 4 },
      { id: 2, title: "Green folder", color: 2 }, { id: 4, title: "Unrelated", color: 3 }],
    list: "main" as const, selectList: () => {}, refresh: () => {}, loading: false, liveRevision: 0, error: "",
    loadHistory: async () => ({ before: null, messages: [] }), findChats: async () => [],
    sendText: async () => ({ state: "failed" as const }),
  };
  const page = render(<TelegramPage live={live} />);
  const row = within(screen.getByRole("list", { name: "Telegram chats" })).getByRole("button", { name: /Fixture room/ });
  expect(Array.from(row.querySelectorAll(".mtg-row-folder-tags > span"), (tag) => tag.textContent))
    .toEqual(["Blue folder", "Green folder"]);
  page.rerender(<TelegramPage live={{ ...live, folders: live.folders.map(({ id, title }) => ({ id, title })) }} />);
  expect(row.querySelectorAll(".mtg-row-folder-tags")).toHaveLength(0);
});

test("reviews a shared folder invitation and imports only the final selection", async () => {
  const url = "https://t.me/addlist/fixture";
  const token = "a".repeat(64);
  const previewFolderInvite = vi.fn(async () => ({ title: "Fixture folder", token, alreadyAdded: 1,
    chats: [{ id: "-42", title: "Fixture group" }, { id: "-43", title: "Fixture channel" }] }));
  const importFolderInvite = vi.fn(async () => "added" as const);
  const findChats = vi.fn(async () => []);
  render(<TelegramPage live={{
    chats: [], folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", loadHistory: async () => ({ before: null, messages: [] }),
    findChats, sendText: async () => ({ state: "failed" }), previewFolderInvite, importFolderInvite,
  }} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Telegram chats" }), { target: { value: url } });
  await screen.findByRole("heading", { name: "Fixture folder" });
  expect(screen.getByText("1 chat already in this folder.")).toBeTruthy();
  expect(previewFolderInvite).toHaveBeenCalledExactlyOnceWith(url);
  expect(findChats).not.toHaveBeenCalled();
  const add = screen.getByRole<HTMLButtonElement>("button", { name: "Add selected chats and folder" });
  expect(add.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Select all chats" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Fixture group" }));
  expect(importFolderInvite).not.toHaveBeenCalled();
  fireEvent.click(add);
  await screen.findByText("Folder added.");
  expect(importFolderInvite).toHaveBeenCalledExactlyOnceWith(url, token, ["-43"]);
});

test("hides shared-folder suggestions only after explicit confirmation", async () => {
  const { FolderUpdates } = await import("../src/ui/folder-updates.tsx");
  const token = "a".repeat(64);
  const actions = {
    load: vi.fn(async () => ({ title: "Fixture folder", token, alreadyAdded: 0, chats: [{ id: "-42", title: "Fixture chat" }] })),
    add: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
  };
  const { container } = render(<FolderUpdates id={7} actions={actions} disabled={false} />);
  container.querySelector("details")!.open = true;
  fireEvent.click(screen.getByRole("button", { name: "Check for new chats" }));
  fireEvent.click(await screen.findByRole("button", { name: "Hide suggestions" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep suggestions" }));
  expect(actions.dismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Hide suggestions" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm hide" }));
  await screen.findByText("Folder update hidden.");
  expect(actions.dismiss).toHaveBeenCalledExactlyOnceWith(7, token);
  expect(actions.add).not.toHaveBeenCalled();
});

test("shows the server mute deadline after saving and reopening chat notifications", async () => {
  const { ChatNotifications } = await import("../src/ui/chat-notifications.tsx");
  const muteUntil = 1810000000;
  const load = vi.fn().mockResolvedValueOnce({ mode: "default" }).mockResolvedValue({ mode: "muted", muteUntil });
  const save = vi.fn(async () => "updated" as const);
  render(<ChatNotifications id="42" chatNotificationState={load} setChatNotificationMode={save} />);
  const settings = screen.getByRole("button", { name: "Chat notification settings" });
  fireEvent.click(settings);
  fireEvent.change(await screen.findByRole("combobox", { name: "Mute duration" }), { target: { value: "28800" } });
  fireEvent.click(screen.getByRole("button", { name: "Mute for selected duration" }));
  const status = await screen.findByText(/Notifications muted until/);
  expect(status.querySelector("time")?.dateTime).toBe(new Date(muteUntil * 1000).toISOString());
  expect(save).toHaveBeenCalledExactlyOnceWith("42", "muted", 28800);
  fireEvent.click(settings);
  fireEvent.click(settings);
  expect((await screen.findByText(/Notifications muted until/)).querySelector("time")?.dateTime)
    .toBe(new Date(muteUntil * 1000).toISOString());
});

test("opens the known chat from an incoming notification without exposing a hidden preview", async () => {
  const dismiss = vi.fn();
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Fixture contact", initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", findChats: async () => [],
    sendText: async () => ({ state: "failed" }),
    loadHistory: async () => ({ messages: [], before: null }),
    messageNotification: { key: "5:16", chatId: "42", messageId: "100" },
    dismissMessageNotification: dismiss,
  }} />);
  const notice = within(screen.getByRole("complementary", { name: "Telegram notification" }));
  expect(notice.getByRole("status").textContent).toBe("Fixture contactNew message");
  fireEvent.click(notice.getByRole("button", { name: "Open message" }));
  expect(dismiss).toHaveBeenCalledOnce();
  expect(screen.queryByRole("complementary", { name: "Telegram notification" })).toBeNull();
  await screen.findByText("No messages");
});

test("opens the exact forum message when its chat is outside the loaded list", async () => {
  const loadNotificationChat = vi.fn(async () => ({
    id: "-42", name: "Fixture forum", initials: "F", color: "#246dbd", subtitle: "Group", messages: [],
  }));
  const loadCollection = vi.fn(async () => true);
  const loadMessageContext = vi.fn(async () => [
    { id: "100", text: "Fixture notification message", author: "Fixture", time: "", forumTopicId: 17, collectionKind: "sticker" as const },
  ]);
  render(<TelegramPage live={{
    chats: [], folders: [], list: "archive", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", findChats: async () => [],
    sendText: async () => ({ state: "failed" }),
    loadHistory: async () => ({ messages: [], before: null }),
    messageNotification: { key: "5:16", chatId: "-42", messageId: "100", topicId: 17 },
    loadNotificationChat, loadMessageContext, mediaCollection: { load: loadCollection, save: vi.fn(async () => "saved" as const) },
    dismissMessageNotification: vi.fn(),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: "Open message" }));
  await screen.findByText("Fixture notification message");
  expect(loadNotificationChat).toHaveBeenCalledExactlyOnceWith("-42");
  expect(loadMessageContext).toHaveBeenCalledExactlyOnceWith("-42", "100", 17);
  fireEvent.click(screen.getByRole("button", { name: "Sticker favorites" }));
  await screen.findByRole("button", { name: "Remove from favorite stickers" });
  expect(loadCollection).toHaveBeenCalledExactlyOnceWith("-42", "100", "sticker");
});

test("checks a GIF collection before saving it from its message", async () => {
  const load = vi.fn(async () => false);
  const save = vi.fn(async () => "saved" as const);
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Fixture GIF chat", initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {},
    loading: false, liveRevision: 0, error: "", findChats: async () => [],
    sendText: async () => ({ state: "failed" }),
    loadHistory: async () => ({ before: null, messages: [
      { id: "100", author: "Fixture", text: "Fixture GIF", time: "", collectionKind: "gif" },
    ] }),
    mediaCollection: { load, save },
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Fixture GIF chat/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Saved GIFs collection" }));
  expect(load).toHaveBeenCalledExactlyOnceWith("42", "100", "gif");
  fireEvent.click(await screen.findByRole("button", { name: "Save GIF" }));
  expect(save).toHaveBeenCalledExactlyOnceWith("42", "100", "gif", true, false);
  await screen.findByRole("button", { name: "Remove from saved GIFs" });
});

test("loads a scheduled media preview only after it is opened", async () => {
  const { ScheduledMessages } = await import("../src/ui/scheduled-messages.tsx");
  const loadMedia = vi.fn(async () => new Blob(["fixture"], { type: "audio/ogg" }));
  render(<ScheduledMessages chatId="42" liveRevision={0} draft="" canSend={false}
    load={async () => [{ id: "22", text: "Voice message", media: {
      id: "22", text: "Voice message", author: "You", time: "", voiceNote: true,
      document: { name: "Fixture voice", downloadable: true, playbackMime: "audio/ogg" },
    } }]}
    mediaLoaders={{ loadMedia }} send={vi.fn()} cancel={vi.fn()} accepted={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Send options" }));
  const list = within(await screen.findByRole("list", { name: "Scheduled messages" }));
  expect(list.queryByRole("button", { name: "Load audio player" })).toBeNull();
  fireEvent.click(list.getByRole("button", { name: "Preview scheduled media" }));
  expect(loadMedia).not.toHaveBeenCalled();
  fireEvent.click(list.getByRole("button", { name: "Load audio player" }));
  await waitFor(() => expect(loadMedia).toHaveBeenCalledExactlyOnceWith("42", "22", expect.any(AbortSignal)));
  fireEvent.click(list.getByRole("button", { name: "Hide media preview" }));
  expect(list.queryByRole("button", { name: "Load audio player" })).toBeNull();
});

test("renders a circular video note with keyboard-operable seek and speed controls", async () => {
  const loadMedia = vi.fn(async () => new Blob(["fixture bytes"]));
  const loadVideoStream = vi.fn();
  const transcribeVoice = vi.fn(async () => "Fixture transcript");
  vi.stubGlobal("URL", Object.assign(class extends URL {}, {
    createObjectURL: vi.fn(() => "blob:fixture"), revokeObjectURL: vi.fn(),
  }));
  try {
    render(<MessageContent chatId="42" loadMedia={loadMedia} loadVideoStream={loadVideoStream} transcribeVoice={transcribeVoice} message={{
      id: "9", author: "Fixture", time: "", text: "Fixture video note", videoNote: true,
      document: { name: "Fixture video note.mp4", downloadable: true, playbackMime: "video/mp4" },
    }} />);
    expect(loadMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open video note" }));
    const video = (await screen.findByLabelText("Telegram video note")) as HTMLVideoElement;
    expect(video.classList.contains("mtg-video-note-preview")).toBe(true);
    expect(loadVideoStream).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play video note" })).toBeTruthy();
    Object.defineProperty(video, "duration", { value: 30 });
    fireEvent.durationChange(video);
    fireEvent.input(screen.getByRole("slider", { name: "Video note position" }), { target: { value: "12" } });
    expect(video.currentTime).toBe(12);
    fireEvent.change(screen.getByRole("combobox", { name: "Playback speed" }), { target: { value: "2" } });
    expect(video.playbackRate).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Transcribe locally" }));
    await screen.findByText("Fixture transcript");
    expect(transcribeVoice).toHaveBeenCalledExactlyOnceWith("42", "9");
  } finally { vi.unstubAllGlobals(); }
});

test("clears a media caption through the caption editor", async () => {
  const message = { id: "9", author: "You", time: "", text: "Fixture caption", outgoing: true,
    editableCaption: true, document: { name: "Fixture document", downloadable: false, caption: "Fixture caption" } };
  const editCaption = vi.fn(async () => ({ state: "sent" as const,
    message: { ...message, text: "Document", document: { name: "Fixture document", downloadable: false } } }));
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Caption editor fixture", initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {}, loading: false, liveRevision: 0, error: "",
    findChats: async () => [], sendText: async () => ({ state: "failed" }),
    loadHistory: async () => ({ messages: [message], before: null }), editCaption,
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Caption editor fixture/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit caption" }));
  const input = screen.getByRole("textbox", { name: "Edit caption" }) as HTMLTextAreaElement;
  expect(input.value).toBe("Fixture caption");
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
  await waitFor(() => expect(screen.queryByText("Fixture caption")).toBeNull());
  expect(editCaption).toHaveBeenCalledExactlyOnceWith("42", "9", "", "Fixture caption", undefined, undefined);
});

test("moves a media caption without changing its text", async () => {
  const message = { id: "9", author: "You", time: "", text: "Fixture caption", outgoing: true,
    editableCaption: true, canMoveCaption: true as const, captionAboveMedia: true, document: { name: "Fixture document", downloadable: false, caption: "Fixture caption" } };
  const editCaption = vi.fn(async () => ({ state: "sent" as const,
    message: { ...message, captionAboveMedia: false } }));
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Caption editor fixture", initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {}, loading: false, liveRevision: 0, error: "",
    findChats: async () => [], sendText: async () => ({ state: "failed" }),
    loadHistory: async () => ({ messages: [message], before: null }), editCaption,
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Caption editor fixture/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit caption" }));
  const input = screen.getByRole("textbox", { name: "Edit caption" }) as HTMLTextAreaElement;
  expect(input.value).toBe("Fixture caption");
  const placement = screen.getByRole<HTMLInputElement>("checkbox", { name: "Show caption above media" });
  const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save edit" });
  expect(placement.checked).toBe(true);
  expect(save.disabled).toBe(true);
  fireEvent.click(placement);
  fireEvent.click(save);
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit caption" })).toBeNull());
  expect(editCaption).toHaveBeenCalledExactlyOnceWith("42", "9", "Fixture caption", "Fixture caption",
    undefined, undefined, { above: false, expected: true });
});

test.each([false, true])("places a single formatted caption outside the album grid (above: %s)", async (captionAboveMedia) => {
  const caption = "Album caption fixture";
  const photo = { author: "Fixture", time: "", albumId: "400", hasPhoto: true };
  const messages = [
    { ...photo, id: "11", text: caption, photoCaption: caption, captionAboveMedia,
      styles: [{ offset: 0, length: 5, style: "bold" as const }] },
    { ...photo, id: "12", text: "Photo" },
  ];
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Album layout fixture", initials: "F", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: () => {}, refresh: () => {}, loading: false, liveRevision: 0, error: "",
    findChats: async () => [], sendText: async () => ({ state: "failed" }),
    loadHistory: async () => ({ messages, before: null }),
    loadPhoto: async () => ({ mime: "image/jpeg", base64: "/9j/" }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Album layout fixture/ }));
  const album = await screen.findByRole("list", { name: "Media album" });
  const body = album.parentElement!;
  const sharedCaption = body.querySelector(".mtg-album-caption")!;
  expect(sharedCaption.textContent).toBe(caption);
  expect(sharedCaption.querySelector(".mtg-text-bold")?.textContent).toBe("Album");
  expect(within(album).getAllByRole("listitem")).toHaveLength(2);
  expect(album.textContent).not.toContain(caption);
  expect(Array.from(body.children)).toEqual(captionAboveMedia ? [sharedCaption, album] : [album, sharedCaption]);
});

test("preserves album options while adding, removing and reordering photos", async () => {
  const { MediaComposer } = await import("../src/ui/media-composer.tsx");
  const photos = await import("../src/ui/prepare-photo.ts");
  const prepare = vi.spyOn(photos, "preparePhoto").mockImplementation(async (file) => file.name);
  try {
    const sendAlbum = vi.fn(async () => "sent");
    render(<MediaComposer voice={false} otherMedia={false} photos actions={{
      choices: async () => [], sendChoice: async () => "sent", sendVoice: async () => "sent", sendAlbum,
    }} />);
    fireEvent.click(screen.getByRole("button", { name: "Photo album" }));
    const files = ["one.jpg", "two.jpg"].map((name) => new File(["fixture"], name, { type: "image/jpeg" }));
    fireEvent.change(screen.getByLabelText("Choose album photos"), { target: { files } });
    const order = within(screen.getByRole("list", { name: "Album photo order" }));
    fireEvent.click(order.getByRole("button", { name: "Move photo 2 up" }));
    fireEvent.change(screen.getByLabelText("Album caption"), { target: { value: "Album fixture" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide photos under a spoiler" }));
    fireEvent.change(screen.getByLabelText("Add album photos"), {
      target: { files: [new File(["bad"], "bad.txt", { type: "text/plain" })] },
    });
    expect(order.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(order.getByRole("button", { name: "Remove photo 2" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send album" }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Add album photos"), {
      target: { files: [new File(["fixture"], "three.jpg", { type: "image/jpeg" })] },
    });
    expect(order.getAllByRole("listitem").map((row) => row.querySelector("bdi")?.textContent))
      .toEqual(["two.jpg", "three.jpg"]);
    fireEvent.click(screen.getByRole("button", { name: "Send album" }));
    await waitFor(() => expect(sendAlbum).toHaveBeenCalledExactlyOnceWith(
      "Album fixture", ["two.jpg", "three.jpg"], undefined, { spoiler: true },
    ));
    expect(prepare.mock.calls.map(([file]) => file.name)).toEqual(["two.jpg", "three.jpg"]);
  } finally {
    prepare.mockRestore();
  }
});

test("adjusts streaming video speed and keeps the selector in sync with native controls", async () => {
  const loadMedia = vi.fn(async () => new Blob());
  const loadVideoStream = vi.fn(async () => "/media/fixture");
  const { container } = render(<MessageContent chatId="42" loadMedia={loadMedia} loadVideoStream={loadVideoStream} message={{
    id: "9", author: "Fixture", time: "", text: "Fixture video",
    document: { name: "Fixture.mp4", downloadable: true, playbackMime: "video/mp4" },
  }} />);
  fireEvent.click(screen.getByRole("button", { name: "Load video player" }));
  const speed = await screen.findByRole<HTMLSelectElement>("combobox", { name: "Playback speed" });
  const video = container.querySelector("video")!;
  expect(speed.value).toBe("1");
  fireEvent.change(speed, { target: { value: "1.75" } });
  expect(video.playbackRate).toBe(1.75);
  video.playbackRate = 0.75;
  fireEvent(video, new Event("ratechange"));
  expect(speed.value).toBe("0.75");
  expect(loadVideoStream).toHaveBeenCalledExactlyOnceWith("42", "9");
  expect(loadMedia).not.toHaveBeenCalled();
});

test("resumes a reopened player at its previous position and resets finished media", async () => {
  const loadMedia = vi.fn(async () => new Blob());
  const loadVideoStream = vi.fn(async () => "/media/fixture");
  const { container } = render(<MessageContent chatId="42" loadMedia={loadMedia} loadVideoStream={loadVideoStream} message={{
    id: "9", author: "Fixture", time: "", text: "Fixture video",
    document: { name: "Fixture.mp4", downloadable: true, playbackMime: "video/mp4" },
  }} />);
  async function open() {
    fireEvent.click(screen.getByRole("button", { name: "Load video player" }));
    await screen.findByRole("combobox", { name: "Playback speed" });
    const media = container.querySelector("video")!;
    Object.defineProperty(media, "duration", { value: 90 });
    fireEvent.loadedMetadata(media);
    return media;
  }
  const close = () => fireEvent.click(screen.getByRole("button", { name: "Close player" }));
  const first = await open();
  first.currentTime = 37;
  close();
  const resumed = await open();
  expect(resumed.currentTime).toBe(37);
  resumed.currentTime = 90;
  Object.defineProperty(resumed, "ended", { value: true });
  close();
  expect((await open()).currentTime).toBe(0);
});

test("restores playback after leaving a chat without mixing the same message ID in another chat", async () => {
  const { MediaPlayer, PlaybackHistoryProvider } = await import("../src/ui/media-player.tsx");
  const load = vi.fn(async () => new Blob());
  const stream = vi.fn(async () => "/media/fixture");
  const page = (chatId: string) => <PlaybackHistoryProvider>
    <MediaPlayer key={chatId} chatId={chatId} messageId="9" mime="video/mp4" load={load} stream={stream} />
  </PlaybackHistoryProvider>;
  const { container, rerender } = render(page("42"));
  async function open() {
    fireEvent.click(screen.getByRole("button", { name: "Load video player" }));
    await screen.findByRole("combobox", { name: "Playback speed" });
    const media = container.querySelector("video")!;
    Object.defineProperty(media, "duration", { value: 90 });
    fireEvent.loadedMetadata(media);
    return media;
  }
  (await open()).currentTime = 37;
  rerender(page("43"));
  expect((await open()).currentTime).toBe(0);
  rerender(page("42"));
  expect((await open()).currentTime).toBe(37);
});
