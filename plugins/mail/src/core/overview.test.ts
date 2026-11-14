import { describe, expect, it } from "vitest";
import { getMailOverview, type AccountRepository } from "./index.ts";

function repositoryOf(
  accounts: Awaited<ReturnType<AccountRepository["list"]>>,
): AccountRepository {
  return { list: async () => accounts };
}

describe("getMailOverview", () => {
  it("reports no accounts when none are connected", async () => {
    const overview = await getMailOverview({ accounts: repositoryOf([]) });

    expect(overview).toEqual({ accounts: [] });
  });

  it("lists accounts ordered by address, whatever order the store returns", async () => {
    const overview = await getMailOverview({
      accounts: repositoryOf([
        { id: "2", address: "zoe@example.org" },
        { id: "1", address: "anna@example.org", displayName: "Anna" },
      ]),
    });

    expect(overview.accounts.map((account) => account.address)).toEqual([
      "anna@example.org",
      "zoe@example.org",
    ]);
  });

  it("does not reorder the list the repository returned", async () => {
    const stored = [
      { id: "2", address: "zoe@example.org" },
      { id: "1", address: "anna@example.org" },
    ];

    await getMailOverview({ accounts: repositoryOf(stored) });

    expect(stored.map((account) => account.id)).toEqual(["2", "1"]);
  });
});
