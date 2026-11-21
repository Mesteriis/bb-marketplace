import { describe, expect, it } from "vitest";
import { CALL_PAGE_CSP, callPageHtml, resultPageHtml } from "./call-page.ts";

describe("call page", () => {
  const html = callPageHtml();

  it("declares UTF-8 before anything else in the head", () => {
    expect(html.startsWith('<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="UTF-8" />')).toBe(true);
  });

  it("loads the pinned Meeting SDK scripts in Zoom's documented order", () => {
    const sources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
    // The media report must be installed before Zoom's code can keep a reference to getUserMedia.
    expect(html.indexOf("zoom-call:media-error")).toBeLessThan(html.indexOf("source.zoom.us"));
    expect(sources).toEqual([
      "https://source.zoom.us/6.10.0/lib/vendor/react.min.js",
      "https://source.zoom.us/6.10.0/lib/vendor/react-dom.min.js",
      "https://source.zoom.us/6.10.0/lib/vendor/redux.min.js",
      "https://source.zoom.us/6.10.0/lib/vendor/redux-thunk.min.js",
      "https://source.zoom.us/6.10.0/lib/vendor/react-redux.min.js",
      "https://source.zoom.us/6.10.0/lib/vendor/lodash.min.js",
      "https://source.zoom.us/zoom-meeting-embedded-6.10.0.min.js",
    ]);
  });

  it("allows scripts and connections to Zoom only and embedding by BB only", () => {
    expect(CALL_PAGE_CSP).toContain("default-src 'none'");
    expect(CALL_PAGE_CSP).toContain("frame-ancestors http://127.0.0.1:* http://localhost:*");
    expect(CALL_PAGE_CSP).toContain("form-action 'none'");
    expect(CALL_PAGE_CSP).toContain(
      "script-src 'unsafe-inline' 'unsafe-eval' https://zoom.us https://*.zoom.us https://dmogdx0jrul3u.cloudfront.net blob:",
    );
    expect(CALL_PAGE_CSP).toContain(
      "connect-src https://zoom.us https://*.zoom.us wss://*.zoom.us https://zoom.com https://*.zoom.com wss://*.zoom.com",
    );
  });
});

describe("result page", () => {
  it("escapes the message", () => {
    const html = resultPageHtml(false, '<script>alert("x")</script> & more');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more");
    expect(html).not.toContain("<script>alert");
  });

  it("says the account is connected on success", () => {
    expect(resultPageHtml(true, "Аккаунт Zoom подключён")).toContain("<h1>Аккаунт Zoom подключён</h1>");
  });
});

describe("call page served with a call (ticket link)", () => {
  const served = { signature: "sig", meetingNumber: "1111111111", passcode: null, userName: 'Иван </script><script>alert(1)', zak: "zak" };

  it("embeds the call before the page script, so it joins on its own", () => {
    const html = callPageHtml(served);
    expect(html).toContain('window.__ZOOM_CALL__ = {"signature":"sig","meetingNumber":"1111111111","passcode":null,');
    expect(html.indexOf("window.__ZOOM_CALL__ =")).toBeLessThan(html.indexOf("var served = standalone"));
  });

  it("cannot be broken out of by a name containing a closing script tag", () => {
    const html = callPageHtml(served);
    expect(html).toContain("\\u003c/script>\\u003cscript>alert(1)");
    expect(html).not.toContain("</script><script>alert(1)");
  });

  it("centres Zoom's view in the frame", () => {
    expect(callPageHtml()).toContain("#meetingSDKElement { min-height: 100%; justify-content: center; }");
  });

  it("carries no call when embedded in BB", () => {
    expect(callPageHtml()).not.toContain("window.__ZOOM_CALL__ =");
  });
});
