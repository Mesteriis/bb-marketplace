import { describe, expect, it } from "vitest";
import { googleClient, parseGoogleClient } from "./google-oauth-client.ts";

const good = {
  installed: {
    client_id: "invented-client-id",
    client_secret: "invented-client-secret",
    redirect_uris: ["http://localhost"],
  },
};

describe("parseGoogleClient", () => {
  it("reads a desktop client with loopback redirects", () => {
    expect(parseGoogleClient(good)).toEqual({ id: "invented-client-id", secret: "invented-client-secret" });
    const numbered = { installed: { ...good.installed, redirect_uris: ["http://127.0.0.1:8123/", "http://localhost:9"] } };
    expect(parseGoogleClient(numbered)).toEqual({ id: "invented-client-id", secret: "invented-client-secret" });
  });

  it("refuses anything else", () => {
    expect(parseGoogleClient({ web: good.installed })).toBeNull();
    expect(parseGoogleClient({ installed: { ...good.installed, client_secret: "" } })).toBeNull();
    expect(parseGoogleClient({ installed: { ...good.installed, client_id: 7 } })).toBeNull();
    expect(parseGoogleClient({ installed: { ...good.installed, redirect_uris: ["https://example.org/cb"] } })).toBeNull();
    expect(parseGoogleClient({ installed: { ...good.installed, redirect_uris: ["http://localhost.example.org"] } })).toBeNull();
    expect(parseGoogleClient({ installed: { ...good.installed, redirect_uris: [] } })).toBeNull();
    expect(parseGoogleClient({ installed: { ...good.installed, redirect_uris: "http://localhost" } })).toBeNull();
    expect(parseGoogleClient(null)).toBeNull();
    expect(parseGoogleClient("text")).toBeNull();
  });
});

describe("googleClient", () => {
  it("reads the client shipped with the plugin", () => {
    expect(googleClient()).not.toBeNull();
  });
});
