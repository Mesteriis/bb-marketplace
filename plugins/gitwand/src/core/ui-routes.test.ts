import { describe, expect, it } from "vitest";
import { contentTypeFor, uiRouteFor } from "./ui-routes.ts";

describe("uiRouteFor", () => {
  it.each([
    ["index.html", "/ui/index.html"],
    ["assets/index-CV7Bf8TY.js", "/ui/assets/index-CV7Bf8TY.js"],
    ["grammars/tree-sitter-rust.wasm", "/ui/grammars/tree-sitter-rust.wasm"],
    ["assets/a b.svg", "/ui/assets/a b.svg"],
  ])("maps the built file %s to the route %s", (file, route) => {
    expect(uiRouteFor(file)).toBe(route);
  });

  it.each([
    ["a parent step", "../secret.txt"],
    ["a parent step inside", "assets/../../x.js"],
    ["a lone dot step", "assets/./x.js"],
    ["an absolute path", "/etc/passwd"],
    ["a protocol-relative host", "//evil.example/x.js"],
    ["an absolute URL", "http://evil.example/x.js"],
    ["a backslash", "assets\\x.js"],
    ["a NUL byte", "x\u0000.js"],
    ["an empty name", ""],
    ["an empty segment", "assets//x.js"],
    ["a query", "x.js?y=1"],
    ["a fragment", "x.js#y"],
  ])("refuses %s", (_name, file) => {
    expect(uiRouteFor(file)).toBeNull();
  });
});

describe("contentTypeFor", () => {
  it.each([
    ["index.html", "text/html; charset=utf-8"],
    ["assets/x.js", "text/javascript; charset=utf-8"],
    ["assets/x.mjs", "text/javascript; charset=utf-8"],
    ["assets/x.css", "text/css; charset=utf-8"],
    ["x.svg", "image/svg+xml"],
    ["grammars/a.wasm", "application/wasm"],
    ["x.json", "application/json"],
    ["assets/X.PNG", "image/png"],
    ["grammars/highlights.scm", "application/octet-stream"],
    ["LICENSE", "application/octet-stream"],
  ])("serves %s as %s", (file, type) => {
    expect(contentTypeFor(file)).toBe(type);
  });
});
