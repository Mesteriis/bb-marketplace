import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.ts";
import { joinUrl, parseMeetingLink } from "./meeting-link.ts";

describe("parseMeetingLink", () => {
  it("reads the number and passcode from a join link", () => {
    expect(parseMeetingLink("https://zoom.us/j/1234567890?pwd=abcDEF123")).toEqual({
      meetingNumber: "1234567890",
      passcode: "abcDEF123",
    });
  });

  it("accepts a regional subdomain and a link without a passcode", () => {
    expect(parseMeetingLink("  https://us02web.zoom.us/j/98765432101  ")).toEqual({
      meetingNumber: "98765432101",
      passcode: null,
    });
  });

  it("accepts start and web-client links", () => {
    expect(parseMeetingLink("https://zoom.us/s/123456789").meetingNumber).toBe("123456789");
    expect(parseMeetingLink("https://app.zoom.us/wc/1234567890/join?pwd=x1").passcode).toBe("x1");
  });

  it.each(["123 456 7890", "123-456-7890", "1234567890"])("accepts the bare number %s", (input) => {
    expect(parseMeetingLink(input)).toEqual({ meetingNumber: "1234567890", passcode: null });
  });

  it.each([
    "https://example.com/j/1234567890",
    "https://evilzoom.us/j/1234567890",
    "https://zoom.us.evil.com/j/1234567890",
    "http://zoom.us/j/1234567890",
    "https://zoom.us/my/someone",
    "https://zoom.us/j/12345",
    "12345678",
    "123456789012",
    "",
    "not a link",
  ])("rejects %j", (input) => {
    expect(() => parseMeetingLink(input)).toThrow(DomainError);
  });

  it("reports the invalid_link code", () => {
    try {
      parseMeetingLink("nope");
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe("invalid_link");
    }
  });
});

describe("joinUrl", () => {
  it("builds the public join link", () => {
    expect(joinUrl("1234567890", null)).toBe("https://zoom.us/j/1234567890");
    expect(joinUrl("1234567890", "a b&c")).toBe("https://zoom.us/j/1234567890?pwd=a+b%26c");
  });
});
