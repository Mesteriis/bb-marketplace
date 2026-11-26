import { describe, expect, it } from "vitest";
import { settingMissingError } from "../../core/settings";
import { unconfiguredCollection, unconfiguredThreads, unconfiguredWrite } from "./unconfigured";

describe("unconfigured adapters", () => {
  const error = () => settingMissingError("mcp-catalog", "marketplaceRepoPath");
  it("fail every call with the error that names the setting", async () => {
    const collection = unconfiguredCollection(error);
    await expect(collection.readIndex()).rejects.toThrow("не задана настройка marketplaceRepoPath");
    await expect(collection.isAccepted("a".repeat(40))).rejects.toThrow("bb plugin config mcp-catalog set marketplaceRepoPath");
    await expect(unconfiguredWrite(error).branchHasEntry("/wt", "s")).rejects.toThrow("не задана настройка");
    await expect(unconfiguredThreads(() => settingMissingError("mcp-catalog", "marketplaceProjectId")).spawnReview("p", "t")).rejects.toThrow(
      "marketplaceProjectId",
    );
  });
});
