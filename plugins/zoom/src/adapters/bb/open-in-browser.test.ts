import { describe, expect, it, vi } from "vitest";
import { openInSystemBrowser } from "./open-in-browser.ts";

describe("openInSystemBrowser", () => {
  it("opens a loopback address with the macOS opener", async () => {
    const run = vi.fn(async () => undefined);
    expect(await openInSystemBrowser("http://127.0.0.1:38886/api/v1/plugins/makosh-zoom/http/call?ticket=t", "darwin", run)).toBe(true);
    expect(run).toHaveBeenCalledWith("open", ["http://127.0.0.1:38886/api/v1/plugins/makosh-zoom/http/call?ticket=t"]);
  });

  it("uses xdg-open on Linux", async () => {
    const run = vi.fn(async () => undefined);
    expect(await openInSystemBrowser("http://localhost:1/x", "linux", run)).toBe(true);
    expect(run).toHaveBeenCalledWith("xdg-open", ["http://localhost:1/x"]);
  });

  it.each(["https://zoom.us/j/1", "http://example.com/", "file:///etc/passwd", "http://127.0.0.1.evil.com/", "-a Calculator", ""])(
    "refuses %j without running anything",
    async (url) => {
      const run = vi.fn(async () => undefined);
      expect(await openInSystemBrowser(url, "darwin", run)).toBe(false);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("reports false on a platform with no opener and when the opener fails", async () => {
    const run = vi.fn(async () => {
      throw new Error("no such file");
    });
    expect(await openInSystemBrowser("http://127.0.0.1:1/x", "win32", run)).toBe(false);
    expect(await openInSystemBrowser("http://127.0.0.1:1/x", "darwin", run)).toBe(false);
  });
});
