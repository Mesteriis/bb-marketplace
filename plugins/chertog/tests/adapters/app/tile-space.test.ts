import { describe, expect, it } from "vitest";
import { readHomeRedirectEffective, readTileSpace } from "../../../src/adapters/bb/app/settings.ts";

describe("readTileSpace", () => {
  it("is null until BB has delivered the values", () => {
    expect(readTileSpace(undefined)).toBeNull();
  });
  it("reads a missing key as on, so an existing installation keeps its workspace", () => {
    expect(readTileSpace({})).toBe(true);
  });
  it("reads the delivered value", () => {
    expect(readTileSpace({ tileSpace: true })).toBe(true);
    expect(readTileSpace({ tileSpace: false })).toBe(false);
  });
});

describe("readHomeRedirectEffective", () => {
  it("waits while the values are not delivered", () => {
    expect(readHomeRedirectEffective(undefined)).toBeNull();
  });
  it("follows the redirect switch while the tile space is on or has no key", () => {
    expect(readHomeRedirectEffective({ homeRedirect: true })).toBe(true);
    expect(readHomeRedirectEffective({ homeRedirect: true, tileSpace: true })).toBe(true);
    expect(readHomeRedirectEffective({ homeRedirect: false, tileSpace: true })).toBe(false);
  });
  it("never redirects with the tile space off, even if the redirect is on", () => {
    expect(readHomeRedirectEffective({ homeRedirect: true, tileSpace: false })).toBe(false);
  });
});
