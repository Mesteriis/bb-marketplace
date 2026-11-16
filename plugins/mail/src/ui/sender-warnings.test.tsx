// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { CryptoChip, cryptoPlaceholder, ENCRYPTED_BODY_TEXT, hasSenderWarning, imagesHeldReason, OPAQUE_SIGNED_BODY_TEXT, SenderWarnings } from "./sender-warnings.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const from = { name: "Billing", address: "billing@example.com" };

describe("SenderWarnings", () => {
  it("shows the strip for a failed check, with the domain as data", () => {
    render(<SenderWarnings message={{ from, senderCheck: { state: "failed", summary: "DMARC failed" }, warnings: [] }} />);
    const strip = screen.getByRole("note", { name: "Sender not verified" });
    expect(strip.textContent).toBe(
      "Sender not verified. Your mail provider could not confirm this came from example.com (DMARC failed). Don't trust links or requests in it.",
    );
    expect(strip.querySelector("a")).toBeNull();
  });

  it("shows one line per warning and nothing for a clean sender", () => {
    render(
      <SenderWarnings
        message={{
          from,
          senderCheck: { state: "ok", summary: null },
          warnings: [
            { kind: "reply_to_elsewhere", addresses: ["help@example.net"] },
            { kind: "lookalike", domain: "examp1e.com", like: "example.com" },
            { kind: "mixed_script", domain: "xn--exmple-cua.com" },
            { kind: "name_shows_address", shown: "ceo@example.com", actual: "x@example.org" },
          ],
        }}
      />,
    );
    const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toEqual([
      "Replies go to help@example.net, not to example.com.",
      "examp1e.com looks like example.com, which you write to.",
      "This domain mixes alphabets: xn--exmple-cua.com (shown as it really is).",
      "The name shows ceo@example.com but the address is x@example.org.",
    ]);
    cleanup();
    const { container } = render(<SenderWarnings message={{ from, senderCheck: { state: "ok", summary: null }, warnings: [] }} />);
    expect(container.innerHTML).toBe("");
  });

  it("says why images wait, and marks warned messages", () => {
    expect(imagesHeldReason({ senderCheck: { state: "ok", summary: null }, warnings: [] })).toBeNull();
    expect(imagesHeldReason({ senderCheck: { state: "unchecked", summary: null }, warnings: [] })).toBeNull();
    expect(imagesHeldReason({ senderCheck: { state: "failed", summary: null }, warnings: [] })).toBe("the sender check failed");
    expect(imagesHeldReason({ senderCheck: { state: "ok", summary: null }, warnings: [{ kind: "lookalike", domain: "a", like: "b" }] })).toBe(
      "the domain looks like another",
    );
    expect(imagesHeldReason({ senderCheck: { state: "ok", summary: null }, warnings: [{ kind: "name_shows_address", shown: "a", actual: "b" }] })).toBe(
      "the name shows another address",
    );
    expect(imagesHeldReason({})).toBe("the sender check has not run yet");
    expect(hasSenderWarning({})).toBe(false);
    expect(hasSenderWarning({ warnings: [{ kind: "mixed_script", domain: "x" }] })).toBe(true);
  });

  it("chips and placeholders for signed and encrypted mail", () => {
    render(<CryptoChip crypto={{ kind: "pgp_signed", opaque: false }} />);
    expect(screen.getByText("Signed (PGP)").getAttribute("title")).toBe("Mail does not check signatures");
    expect(cryptoPlaceholder({ kind: "pgp_encrypted", opaque: false })).toBe(ENCRYPTED_BODY_TEXT);
    expect(cryptoPlaceholder({ kind: "smime_signed", opaque: true })).toBe(OPAQUE_SIGNED_BODY_TEXT);
    expect(cryptoPlaceholder({ kind: "smime_signed", opaque: false })).toBeNull();
    expect(cryptoPlaceholder(null)).toBeNull();
  });
});
