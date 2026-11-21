import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.ts";
import { callPageUrlFor, redirectUriFor } from "./redirect.ts";

describe("redirectUriFor", () => {
  it("uses the loopback address BB is open on", () => {
    expect(redirectUriFor("http://127.0.0.1:38886")).toBe(
      "http://127.0.0.1:38886/api/v1/plugins/makosh-zoom/http/oauth/callback",
    );
  });

  it("uses an https origin and ignores any path", () => {
    expect(redirectUriFor("https://bb.example.net/some/page?x=1")).toBe(
      "https://bb.example.net/api/v1/plugins/makosh-zoom/http/oauth/callback",
    );
  });

  it.each([
    "http://localhost:38886",
    "http://192.168.1.5:38886",
    "http://bb.example.net",
    "https://user:pass@bb.example.net",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("refuses %j", (origin) => {
    const run = () => redirectUriFor(origin);
    expect(run).toThrow(DomainError);
    try {
      run();
    } catch (error) {
      expect((error as DomainError).code).toBe("invalid_input");
    }
  });
});

describe("callPageUrlFor", () => {
  it("serves the call page from the other loopback name, so it gets an origin of its own", () => {
    expect(callPageUrlFor("http://127.0.0.1:38886")).toBe("http://localhost:38886/api/v1/plugins/makosh-zoom/http/call");
    expect(callPageUrlFor("http://localhost:38886")).toBe("http://127.0.0.1:38886/api/v1/plugins/makosh-zoom/http/call");
  });

  it.each(["https://bb.example.net", "http://192.168.1.5:38886", "not a url", ""])(
    "has no separate origin to offer for %j",
    (origin) => {
      expect(callPageUrlFor(origin)).toBeNull();
    },
  );
});
