// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplyDraftStrip, type ReplyDraftPorts, type ReplyDraftShown } from "./reply-draft-strip.tsx";
import { HOSTILE } from "./testing/ai-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const DRAFT: ReplyDraftShown = {
  paragraphs: ["Hello Ada,", "Tuesday works."],
  preview: "Hello Ada, Tuesday works.",
  linksRemoved: 0,
  provider: "provider-x",
  model: "model-y",
};

function mount(draft: ReplyDraftShown | null, use: ReplyDraftPorts["use"] = vi.fn()) {
  const ports = { get: vi.fn(async () => draft), use, dismiss: vi.fn(async () => {}) };
  render(<ReplyDraftStrip messageId="m-1" ports={ports} />);
  return ports;
}

describe("ReplyDraftStrip", () => {
  it("shows nothing without a draft", async () => {
    const ports = mount(null);
    await waitFor(() => expect(ports.get).toHaveBeenCalledWith("m-1"));
    expect(screen.queryByLabelText("Reply drafted")).toBeNull();
  });

  it("shows the first lines and the model; Use hands over the paragraphs, forgets the draft and hides", async () => {
    const ports = mount(DRAFT);
    const strip = await screen.findByLabelText("Reply drafted");
    expect(strip.textContent).toContain("Hello Ada, Tuesday works.");
    expect(strip.textContent).toContain("AI · provider-x · model-y");
    expect(strip.textContent).not.toContain("removed");
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => expect(ports.dismiss).toHaveBeenCalledWith("m-1"));
    expect(ports.use).toHaveBeenCalledWith("m-1", ["Hello Ada,", "Tuesday works."]);
    expect(screen.queryByLabelText("Reply drafted")).toBeNull();
  });

  it("keeps the draft when the reply could not be opened", async () => {
    const ports = mount(DRAFT, vi.fn(async () => {
      throw new Error("no reply");
    }));
    await screen.findByLabelText("Reply drafted");
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => expect(ports.use).toHaveBeenCalledTimes(1));
    expect(ports.dismiss).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Reply drafted")).toBeTruthy();
  });

  it("reads once per message, whatever the ports' identity", async () => {
    const get = vi.fn(async () => DRAFT);
    const make = () => ({ get, use: vi.fn(), dismiss: vi.fn(async () => {}) });
    const view = render(<ReplyDraftStrip messageId="m-1" ports={make()} />);
    await screen.findByLabelText("Reply drafted");
    view.rerender(<ReplyDraftStrip messageId="m-1" ports={make()} />);
    expect(screen.getByLabelText("Reply drafted")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(1);
    view.rerender(<ReplyDraftStrip messageId="m-2" ports={make()} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(get).toHaveBeenLastCalledWith("m-2");
  });

  it("Dismiss forgets the draft; removed links are said; model text stays text", async () => {
    const ports = mount({ ...DRAFT, preview: HOSTILE, linksRemoved: 2 });
    const strip = await screen.findByLabelText("Reply drafted");
    expect(strip.textContent).toContain("2 links you did not write were removed.");
    expect(strip.querySelector("a, b, img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(ports.dismiss).toHaveBeenCalledWith("m-1");
    expect(ports.use).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Reply drafted")).toBeNull();
  });
});
