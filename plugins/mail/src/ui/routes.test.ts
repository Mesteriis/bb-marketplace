import { describe, expect, it } from "vitest";
import { parseThreadSubPath, threadSubPath } from "./routes.ts";

/** What the host does to a subPath before the panel receives it. */
const hostEncode = (subPath: string) => subPath.split("/").map(encodeURIComponent).join("/");

describe("thread subPath", () => {
  it("formats plain ids as they are", () => {
    expect(threadSubPath("acc-1", "t_42")).toBe("t/acc-1/t_42");
    expect(parseThreadSubPath("t/acc-1/t_42")).toEqual({ accountId: "acc-1", threadId: "t_42" });
  });

  it.each([
    ["a/b", "t/1"],
    ["100%", "50% off"],
    ["my account", "thread with spaces"],
    ["%2F", "ü?#&="],
  ])("round-trips %j / %j through the host's encoding", (accountId, threadId) => {
    const subPath = threadSubPath(accountId, threadId);
    expect(subPath.split("/")).toHaveLength(3);
    expect(parseThreadSubPath(hostEncode(subPath))).toEqual({ accountId, threadId });
  });

  it.each([
    "",
    "t",
    "t/acc-1",
    "t/acc-1/",
    "t//t_42",
    "x/acc-1/t_42",
    "t/acc-1/t_42/extra",
    "t/%E0%A4%A/t_42",
    "t/acc-1/%",
  ])("rejects %j", (subPath) => {
    expect(parseThreadSubPath(subPath)).toBeNull();
  });
});
