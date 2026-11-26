import { describe, expect, it } from "vitest";
import { frameUrlFor } from "./frame-url.ts";

describe("frameUrlFor", () => {
  it("loads the UI from the other loopback name and carries the repository path", () => {
    expect(frameUrlFor("http://127.0.0.1:38886", "/tmp/repo a")).toBe(
      "http://localhost:38886/api/v1/plugins/makosh-gitwand/http/ui/index.html?repo=%2Ftmp%2Frepo%20a",
    );
  });

  it("switches localhost to 127.0.0.1", () => {
    expect(frameUrlFor("http://localhost:5173", "/r")).toBe(
      "http://127.0.0.1:5173/api/v1/plugins/makosh-gitwand/http/ui/index.html?repo=%2Fr",
    );
  });

  it("omits repo when no repository is chosen", () => {
    expect(frameUrlFor("http://127.0.0.1:38886", null)).toBe(
      "http://localhost:38886/api/v1/plugins/makosh-gitwand/http/ui/index.html",
    );
  });

  it("encodes characters that would end the query value", () => {
    expect(frameUrlFor("http://127.0.0.1:1", "/a&b=c#d+e")).toBe(
      "http://localhost:1/api/v1/plugins/makosh-gitwand/http/ui/index.html?repo=%2Fa%26b%3Dc%23d%2Be",
    );
  });

  it.each([
    ["a non-loopback host", "https://bb.example.ts.net"],
    ["a LAN address", "http://192.168.1.10:38886"],
    ["credentials in the origin", "http://user:pw@127.0.0.1:38886"],
    ["not a URL", "nonsense"],
  ])("returns null for %s, where no sibling origin exists", (_name, origin) => {
    expect(frameUrlFor(origin, "/r")).toBeNull();
  });
});
