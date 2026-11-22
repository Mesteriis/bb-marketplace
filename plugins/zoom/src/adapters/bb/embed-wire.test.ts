// @vitest-environment jsdom
import { expect, it } from "vitest";
import { readHost } from "./embed-wire";

it("routes only a closed v1 Zoom message to its marked live host", () => {
  document.body.innerHTML =
    '<section data-chertog-embed-layer="v1"><div data-live-host="view-1"><div data-chertog-embed-target="v1" data-provider="zoom-call" data-instance-id="view-1" data-generation="1"></div></div><div data-live-host="view-2"></div></section>';
  const target = document.querySelector("[data-chertog-embed-target]")!;
  const base = { version: "chertog.embed.v1", provider: "zoom-call", instanceId: "view-1", generation: 1 };
  function read(detail: unknown) {
    const e = new CustomEvent("chertog.embed.v1.host", { bubbles: true, detail });
    target.dispatchEvent(e);
    return readHost(e)?.message;
  }
  const ref = "12345678-1234-4123-8123-123456789abc";
  for (const fields of [
    { kind: "announce", mode: "choose" },
    { kind: "announce", resourceRef: ref },
    { kind: "visibility", visible: true },
    { kind: "visibility", visible: false },
    { kind: "close" },
    { kind: "release" },
  ]) {
    expect(read({ ...base, ...fields })).toEqual({ ...base, ...fields });
  }
  for (const fields of [
    { generation: 0 },
    { url: "private" },
    { version: "chertog.embed.v2" },
    { resourceRef: ref },
    { provider: "telegram-chat" },
  ]) {
    expect(read({ ...base, kind: "announce", mode: "choose", ...fields })).toBeUndefined();
  }
  document.querySelector('[data-live-host="view-2"]')!.append(target);
  expect(read({ ...base, kind: "close" })).toBeUndefined();
});
