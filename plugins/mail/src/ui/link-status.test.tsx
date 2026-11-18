// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanLink } from "../core/index.ts";
import { LinkDialog, LinkStatusLine, linkDialogText, linkStatusText } from "./link-status.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const hover = (href: string, text: string | null = null, removed = 0) => ({ href, text, removed, unwrapped: false });

describe("linkStatusText", () => {
  it("shows the address and how many parameters went", () => {
    expect(linkStatusText(hover("https://shop.example.com/sale", "sale", 3), true)).toBe(
      "\u2192 https://shop.example.com/sale (3 tracking parameters removed)",
    );
    expect(linkStatusText(hover("https://shop.example.com/a?utm_source=x"), true)).toBe(
      "\u2192 https://shop.example.com/a (1 tracking parameter removed)",
    );
    expect(linkStatusText(hover("https://shop.example.com/a?utm_source=x"), false)).toBe("\u2192 https://shop.example.com/a?utm_source=x");
  });

  it("names a listed tracking redirect instead of a target", () => {
    expect(linkStatusText(hover("https://u1.ct.sendgrid.net/ls/click?x=1", "Read more"), true)).toBe(
      "\u2192 via tracking redirect at u1.ct.sendgrid.net; Mail cannot see where it ends",
    );
  });

  it("shows a punycode host in its ASCII form, and nothing for a refused link", () => {
    expect(linkStatusText(hover("https://xn--80ak6aa92e.com/"), true)).toBe("\u2192 https://xn--80ak6aa92e.com/");
    expect(linkStatusText(hover("javascript:alert(1)"), true)).toBeNull();
  });

  it("the line renders as a status and nothing without a link", () => {
    const { rerender } = render(<LinkStatusLine hover={hover("https://example.org/x")} cleanLinks />);
    expect(screen.getByRole("status", { name: "Link address" }).textContent).toBe("\u2192 https://example.org/x");
    rerender(<LinkStatusLine hover={null} cleanLinks />);
    expect(screen.queryByRole("status", { name: "Link address" })).toBeNull();
  });
});

describe("LinkDialog", () => {
  it("names what it found, and Open and Cancel answer", () => {
    const link = cleanLink("https://example.net.evil.example.org/x", "www.example.com", { clean: true })!;
    expect(linkDialogText(link)).toEqual({ reason: "This link says www.example.com but opens example.org.", host: "example.org" });
    const onOpen = vi.fn();
    const onCancel = vi.fn();
    render(<LinkDialog link={link} onOpen={onOpen} onCancel={onCancel} />);
    expect(screen.getByRole("dialog", { name: "Open example.org?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith(link);
  });
});
