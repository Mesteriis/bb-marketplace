// BB host entry: provisions an issue worktree on a project's checkout.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { createIssueWorktree } from "./src/adapters/bb/git-worktree.ts";
import { hostContract } from "./src/adapters/bb/host-contract.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: { createWorktree: async (input) => createIssueWorktree(input) },
});
