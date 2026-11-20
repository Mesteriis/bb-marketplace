// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { SendResult } from "../src/core/contract.ts";
import { ChannelDiscussion } from "../src/ui/channel-discussion.tsx";
import { ForumTopics } from "../src/ui/forum-topics.tsx";
import { TelegramPage } from "../src/ui/telegram-page.tsx";

const chat = { id: "-42", name: "Motion fixture group", initials: "MF", color: "#246dbd", subtitle: "Group", messages: [] };
const topic = { id: 17, name: "Motion fixture topic", closed: false };
const sent = { id: "51", author: "You", time: "", text: "Motion fixture text", outgoing: true };

test.each([
  { surface: "chat", input: "Write a message", motion: true },
  { surface: "topic", input: "Write a topic message", motion: true },
  { surface: "comments", input: "Write a comment", motion: true },
  { surface: "chat", input: "Write a message", motion: false },
])("uses the confirmed bubble in $surface with motion enabled = $motion", async ({ surface, input, motion }) => {
  let resolve!: (result: SendResult) => void;
  const send = vi.fn(() => new Promise<SendResult>((done) => { resolve = done; }));
  const animated: HTMLElement[] = [];
  const cancel = vi.fn();
  const animate = vi.fn(function (this: HTMLElement, _frames: Keyframe[], _options: KeyframeAnimationOptions) {
    animated.push(this);
    return { cancel };
  });
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  vi.stubGlobal("matchMedia", () => ({ matches: !motion }));
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this instanceof HTMLTextAreaElement) return new DOMRect(40, 460, 270, 44);
    if (this.matches(".mtg-bubble, li[data-message-id]")) return new DOMRect(120, 350, 180, 56);
    return new DOMRect(0, 0, 400, 500);
  });
  try {
    if (surface === "topic") {
      render(<ForumTopics chatId={chat.id} chat={chat} topics={[topic]} initialTopic={topic} loadForumTopics={async () => [topic]}
        loadTopicHistory={async () => ({ messages: [], before: null })} sendTopicText={send}
        loadPhoto={undefined} saveDocument={undefined} close={() => {}} />);
    } else if (surface === "comments") {
      render(<ChannelDiscussion chatId="-1003" postId="45" load={async () => ({ chat, root: "49", messages: [], before: null })}
        send={send} close={() => {}} />);
    } else {
      render(<TelegramPage live={{
        chats: [chat], folders: [], list: "main", selectList: () => {}, refresh: () => {}, loading: false,
        liveRevision: 0, error: "", findChats: async () => [], loadHistory: async () => ({ messages: [], before: null }), sendText: send,
      }} />);
      fireEvent.click(screen.getByRole("button", { name: /Motion fixture group/ }));
    }
    const field = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: input });
    fireEvent.change(field, { target: { value: sent.text } });
    fireEvent.submit(field.closest("form")!);
    expect(send).toHaveBeenCalledOnce();
    expect(animate).not.toHaveBeenCalled();
    await act(async () => resolve({ state: "sent", message: sent }));
    const list = screen.getByRole("list", { name: surface === "topic" ? "Topic messages" : surface === "comments" ? "Comments" : "Messages" });
    const row = (await within(list).findByText(sent.text)).closest("[data-message-id]");
    expect(row?.getAttribute("data-message-id")).toBe(sent.id);
    if (motion) {
      await waitFor(() => expect(animate).toHaveBeenCalledOnce());
      expect(animated[0]?.closest("[data-message-id]")).toBe(row);
      expect(animate.mock.calls[0]?.[0][0]?.transform).toBe("translate(-80px, 94px)");
    } else {
      await act(async () => new Promise<void>((done) => requestAnimationFrame(() => done())));
      expect(animate).not.toHaveBeenCalled();
    }
    cleanup();
    expect(cancel).toHaveBeenCalledTimes(motion ? 1 : 0);
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    bounds.mockRestore();
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "animate", descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});
