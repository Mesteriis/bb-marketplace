// A managed install runs `npm install --omit=dev` and then builds the app
// bundle. The bundle imports the RPC contract's value, and the contract
// imports `defineRpcContract` from the SDK root, so the SDK has to be a
// runtime dependency: as a dev dependency the install fails on
// `Could not resolve "@get-bb/plugin-sdk"`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("package manifest", () => {
  it("the app bundle still needs the SDK root at build time", () => {
    expect(source("src/adapters/bb/app.tsx")).toContain('import { rpcContract } from "./contract.ts";');
    expect(source("src/adapters/bb/contract.ts")).toContain('import { defineRpcContract } from "@get-bb/plugin-sdk";');
  });
  it("lists the SDK as a runtime dependency, pinned exactly", () => {
    expect(manifest.dependencies?.["@get-bb/plugin-sdk"]).toBe("0.6.132");
    expect(manifest.devDependencies?.["@get-bb/plugin-sdk"]).toBeUndefined();
  });
});
