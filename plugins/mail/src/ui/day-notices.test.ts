import { describe, expect, it } from "vitest";
import { dayNoticePlan } from "./day-notices.ts";

describe("dayNoticePlan", () => {
  it("a digest opens Today and counts the replies", () => {
    expect(dayNoticePlan({ kind: "digest", replyCount: 4 })).toEqual({
      title: "Today: 4 conversations need a reply",
      description: "Your Today view is ready.",
      open: { page: "today" },
    });
    expect(dayNoticePlan({ kind: "digest", replyCount: 1 }).title).toBe("Today: 1 conversation needs a reply");
    expect(dayNoticePlan({ kind: "digest", replyCount: 0 }).title).toBe("Today: nothing needs a reply");
  });

  it("a reminder names the recipient with the address and opens the conversation", () => {
    const plan = dayNoticePlan({ kind: "reminder", name: "Ada Example", address: "ada@example.org", accountId: "acc-1", threadId: "th-1" });
    expect(plan.title).toBe("No reply from Ada Example");
    expect(plan.description).toContain("ada@example.org");
    expect(plan.open).toEqual({ accountId: "acc-1", threadId: "th-1" });
    const bare = dayNoticePlan({ kind: "reminder", name: "", address: "bo@example.org", accountId: "acc-1", threadId: null });
    expect(bare.title).toBe("No reply from bo@example.org");
    expect(bare.open).toEqual({ page: "today" });
  });
});
