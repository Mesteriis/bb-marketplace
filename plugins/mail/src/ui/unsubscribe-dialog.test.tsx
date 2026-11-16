// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UnsubscribeInfoView } from "../core/model.ts";
import {
  FOREIGN_MAILTO_NOTE,
  preferredMethod,
  UNSUBSCRIBE_PRIVACY,
  UnsubscribeDialog,
  unsubscribeFailureText,
} from "./unsubscribe-dialog.tsx";

installTestPluginRuntime();
afterEach(cleanup);

function info(overrides: Partial<UnsubscribeInfoView> = {}): UnsubscribeInfoView {
  return {
    methods: {
      oneClick: { host: "news.example.com" },
      mailto: { address: "leave@example.com", subject: "unsubscribe", body: "", hiddenChars: 0, foreignDomain: false },
    },
    trust: "covered",
    listName: "Invented Weekly",
    already: null,
    hidden: false,
    ...overrides,
  };
}

describe("preferredMethod", () => {
  it("takes one click when offered, else the email, and nothing in Spam or Trash", () => {
    expect(preferredMethod(info())).toBe("one_click");
    expect(preferredMethod(info({ methods: { oneClick: null, mailto: info().methods.mailto } }))).toBe("mailto");
    expect(preferredMethod(info({ methods: { oneClick: null, mailto: null } }))).toBeNull();
    expect(preferredMethod(info({ hidden: true }))).toBeNull();
    expect(preferredMethod(null)).toBeNull();
  });

  it("names every fixed failure reason", () => {
    expect(unsubscribeFailureText("timeout")).toBe("the list did not answer");
    expect(unsubscribeFailureText("address")).toBe("the list's address is not allowed");
    expect(unsubscribeFailureText(null)).toBe("the request failed");
  });
});

describe("UnsubscribeDialog", () => {
  it("one click names the host and the privacy cost; Cancel has the focus", () => {
    const onConfirm = vi.fn();
    render(
      <UnsubscribeDialog
        request={{ info: info(), method: "one_click" }}
        fromAddress="owner@example.org"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Unsubscribe from Invented Weekly?" })).toBeTruthy();
    expect(screen.getByText(UNSUBSCRIBE_PRIVACY)).toBeTruthy();
    expect(screen.getByText("One click to news.example.com")).toBeTruthy();
    expect(screen.queryByText(/An email from/)).toBeNull();
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));
    expect(onConfirm).toHaveBeenCalledWith("one_click");
  });

  it("the email names both addresses and warns of a foreign domain", () => {
    const onCancel = vi.fn();
    const foreign = info({ methods: { oneClick: null, mailto: { address: "x@other.example.net", subject: "s", body: "", hiddenChars: 0, foreignDomain: true } } });
    render(
      <UnsubscribeDialog request={{ info: foreign, method: "mailto" }} fromAddress="owner@example.org" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    expect(screen.getByText("An email from owner@example.org goes to x@other.example.net.")).toBeTruthy();
    expect(screen.getByText(FOREIGN_MAILTO_NOTE)).toBeTruthy();
    expect(screen.getByText(UNSUBSCRIBE_PRIVACY)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows the exact subject and body the email sends, as plain text, and how many hidden characters went (review item 5)", () => {
    const mailto = { address: "leave@example.com", subject: "Remove <b>me</b>", body: "Line one\nhttps://evil.example/x", hiddenChars: 2, foreignDomain: false };
    render(
      <UnsubscribeDialog
        request={{ info: info({ methods: { oneClick: null, mailto } }), method: "mailto" }}
        fromAddress="owner@example.org"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const preview = screen.getByRole("group", { name: "The email that will be sent" });
    expect(within(preview).getByText("Remove <b>me</b>")).toBeTruthy();
    expect(within(preview).getByText(/Line one/).textContent).toBe("Line one\nhttps://evil.example/x");
    expect(preview.querySelector("a, b")).toBeNull();
    expect(screen.getByText(/2 hidden characters removed/)).toBeTruthy();
  });

  it("an empty body says so", () => {
    render(
      <UnsubscribeDialog request={{ info: info({ methods: { oneClick: null, mailto: info().methods.mailto } }), method: "mailto" }} fromAddress="owner@example.org" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(within(screen.getByRole("group", { name: "The email that will be sent" })).getByText("(no text)")).toBeTruthy();
  });

  it("a list without a name, and hidden characters taken out of what the list wrote", () => {
    render(
      <UnsubscribeDialog
        request={{ info: info({ listName: null, methods: { oneClick: { host: "ne​ws.example.com" }, mailto: null } }), method: "one_click" }}
        fromAddress="owner@example.org"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Unsubscribe from this list?" })).toBeTruthy();
    expect(screen.getByText("One click to news.example.com")).toBeTruthy();
  });
});
