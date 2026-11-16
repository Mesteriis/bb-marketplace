// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockDialog, moveExistingText, writtenToText, type BlockCheck } from "./block-dialog.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const CHECK: BlockCheck = {
  address: "promo@shop.example.com",
  domain: "shop.example.com",
  sentToCount: 4,
  storedCount: { address: 3, domain: 7 },
};

async function mount(check: BlockCheck | Error = CHECK) {
  const onBlock = vi.fn();
  const onCancel = vi.fn();
  const load = vi.fn(async () => {
    if (check instanceof Error) throw check;
    return check;
  });
  render(<BlockDialog messageId="m-1" load={load} onBlock={onBlock} onCancel={onCancel} />);
  await act(async () => {
    await Promise.resolve();
  });
  return { onBlock, onCancel, load };
}

describe("BlockDialog texts", () => {
  it("says how often the owner wrote and how many stored messages move", () => {
    expect(writtenToText(0)).toBeNull();
    expect(writtenToText(1)).toBe("You have written to this sender once.");
    expect(writtenToText(4)).toBe("You have written to this sender 4 times.");
    expect(moveExistingText("address", 1)).toBe("Also move the 1 stored message from them to Spam");
    expect(moveExistingText("domain", 7)).toBe("Also move the 7 stored messages from that domain to Spam");
  });
});

describe("BlockDialog", () => {
  it("checks the sender, warns of written-to, ticks the move for an address; Cancel has the focus", async () => {
    const { onBlock, load } = await mount();
    expect(load).toHaveBeenCalledWith("m-1");
    expect(screen.getByLabelText("Block promo@shop.example.com")).toHaveProperty("checked", true);
    expect(screen.getByText("You have written to this sender 4 times.")).toBeTruthy();
    const move = screen.getByRole("checkbox", { name: moveExistingText("address", 3) });
    expect(move.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    expect(onBlock).toHaveBeenCalledWith("m-1", { kind: "address", moveExisting: true });
  });

  it("a domain starts with the move unticked and its own count", async () => {
    const { onBlock } = await mount();
    fireEvent.click(screen.getByLabelText("Block everyone at shop.example.com"));
    const move = screen.getByRole("checkbox", { name: moveExistingText("domain", 7) });
    expect(move.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    expect(onBlock).toHaveBeenCalledWith("m-1", { kind: "domain", moveExisting: false });
    fireEvent.click(move);
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    expect(onBlock).toHaveBeenLastCalledWith("m-1", { kind: "domain", moveExisting: true });
  });

  it("hides the domain of a public provider, and the move box when nothing is stored", async () => {
    await mount({ address: "someone@gmail.com", domain: null, sentToCount: 0, storedCount: { address: 0, domain: null } });
    expect(screen.queryByText(/Block everyone at/)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/You have written/)).toBeNull();
  });

  it("a refusal from the check shows its text and Block stays off", async () => {
    await mount(new Error("This message has no sender address"));
    expect(screen.getByRole("alert").textContent).toBe("This message has no sender address");
    expect((screen.getByRole("button", { name: "Block" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
