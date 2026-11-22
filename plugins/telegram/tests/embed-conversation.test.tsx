// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { EmbedConversation, type BoundCall } from "../src/adapters/bb/embed-conversation.tsx";

afterEach(cleanup);
it.each(["22", "21"])("keeps text, selection and a chosen file in their own Telegram views with peer %s", async other => {
  const first = { id: "21", name: "Synthetic A", initials: "SA", color: "#246dbd", subtitle: "Group", messages: [] };
  const second = { ...first, id: other, name: "Synthetic B" };
  const history = vi.fn(async (method: string) => {
    if (method === "history") return { messages: [], before: null };
    if (method === "chatDraft") return { draft: null, writable: true };
    throw new Error("Unexpected action " + method);
  });
  const call = history as BoundCall;
  const a = render(<EmbedConversation target={{ list: "main", chat: first }} revision={0} call={call} />);
  const b = render(<EmbedConversation target={{ list: "main", chat: second }} revision={0} call={call} />);
  const one = await within(a.container).findByRole<HTMLTextAreaElement>("textbox", {name:"Write a message"});
  const two = await within(b.container).findByRole<HTMLTextAreaElement>("textbox", {name:"Write a message"});
  fireEvent.change(one,{target:{value:"first draft"}});
  one.setSelectionRange(1,4);
  fireEvent.change(two,{target:{value:"other draft"}});
  const file = new File(["test"], "synthetic.txt", {type:"text/plain"});
  const input = b.container.querySelector<HTMLInputElement>('input[type="file"][multiple]') ?? b.container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).toBeTruthy();
  fireEvent.change(input!, {target:{files:[file]}});
  await within(b.container).findByText("synthetic.txt");
  expect(a.container.textContent).not.toContain("synthetic.txt");
  expect([one.value,two.value,one.selectionStart,one.selectionEnd]).toEqual(["first draft","other draft",1,4]);
  expect(history.mock.calls.map(([method])=>method)).not.toContain("prepareDocumentUpload");
});
