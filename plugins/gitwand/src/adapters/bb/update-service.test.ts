import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UpdateService } from "./update-service.ts";

const fx = (name: string) => readFileSync(new URL(`../../../tests/fixtures/minisign/${name}`, import.meta.url));
const KEY = fx("test-key.pub").toString("utf8");

function channel(files: Record<string, Buffer | string>): typeof fetch {
  return (async (url: string | URL) => {
    const name = String(url).split("/").at(-1)!;
    return name in files ? new Response(new Uint8Array(Buffer.from(files[name]))) : new Response("missing", { status: 404 });
  }) as typeof fetch;
}

const base = (over: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) =>
  new UpdateService({
    channelUrl: "https://updates.example.invalid/gitwand/channel.json",
    publicKey: KEY,
    platform: "darwin-arm64",
    pluginVersion: "0.1.0",
    installed: async () => "3.14.0+bb1",
    fetch: channel({ "channel.json": fx("channel.json"), "channel.json.minisig": fx("channel.json.minisig") }),
    ...over,
  });

describe("UpdateService.check", () => {
  it("offers the signed newer build and remembers it as pending", async () => {
    const service = base();
    expect(await service.check()).toMatchObject({ kind: "available", version: "3.14.0+bb2", size: 7063799 });
    expect(service.pending()).toMatchObject({ version: "3.14.0+bb2", currentVersion: "3.14.0+bb1" });
  });

  it("is off without a channel URL or a public key", async () => {
    expect(await base({ channelUrl: "" }).check()).toEqual({ kind: "disabled" });
    expect(await base({ publicKey: "" }).check()).toEqual({ kind: "disabled" });
  });

  it("refuses a manifest whose signature does not match, and offers nothing", async () => {
    const tampered = Buffer.from(fx("channel.json").toString("utf8").replace("7063799", "7063800"));
    const service = base({ fetch: channel({ "channel.json": tampered, "channel.json.minisig": fx("channel.json.minisig") }) });
    expect(await service.check()).toEqual({ kind: "error", error: "channel.json: signature does not match the file" });
    expect(service.pending()).toBeNull();
  });

  it("reports a missing signature", async () => {
    const service = base({ fetch: channel({ "channel.json": fx("channel.json") }) });
    expect(await service.check()).toEqual({ kind: "error", error: "channel.json.minisig: HTTP 404" });
  });

  it("offers nothing when the installed build is as new", async () => {
    const service = base({ installed: async () => "3.14.0+bb2" });
    expect(await service.check()).toEqual({ kind: "none" });
    expect(service.pending()).toBeNull();
  });
});
