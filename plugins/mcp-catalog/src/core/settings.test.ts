import { describe, expect, it } from "vitest";
import { missingSettings, settingMissingError } from "./settings";

describe("missingSettings", () => {
  it("lists empty and blank settings in a stable order", () => {
    expect(missingSettings({ marketplaceRepoPath: "", marketplaceProjectId: " " })).toEqual(["marketplaceRepoPath", "marketplaceProjectId"]);
    expect(missingSettings({ marketplaceRepoPath: "/repo", marketplaceProjectId: undefined })).toEqual(["marketplaceProjectId"]);
    expect(missingSettings({ marketplaceRepoPath: "/repo", marketplaceProjectId: "proj_1" })).toEqual([]);
  });
  it("names the bb plugin config command in the error", () => {
    expect(settingMissingError("mcp-catalog", "marketplaceRepoPath").message).toBe(
      "не задана настройка marketplaceRepoPath: bb plugin config mcp-catalog set marketplaceRepoPath <значение>",
    );
  });
});
