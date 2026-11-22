import { expect, it } from "vitest";
import { VncChannel } from "./vnc-channel.ts";

it("a late noVNC viewer handles the already-open channel before receiving its queued greeting", async () => {
  const events: string[] = [];
  const channel = new VncChannel(
    () => {},
    () => {},
    { maxQueuedBytes: 1024, onOverflow: () => {}, onConsumed: () => {} },
  );
  channel.deliverOpen();
  channel.deliver(new Uint8Array([82, 70, 66]));
  // WebSock.attach installs the handlers; RFB._connect then checks the socket's readyState itself.
  channel.onmessage = (event) => events.push(new TextDecoder().decode(event.data));
  channel.onopen = () => events.push("unexpected second open");
  if (channel.readyState === "open") events.push("open");
  expect(events).toEqual(["open"]);
  await Promise.resolve();
  expect(events).toEqual(["open", "RFB"]);
});
