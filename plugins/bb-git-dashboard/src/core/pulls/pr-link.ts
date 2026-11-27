import { prFromUrl } from "./diff.ts";

type AccountRef = {readonly kind: string; readonly id: string; readonly origin: string};
const githubCom = (account: AccountRef) => account.kind === "github" && ["https://github.com", "https://api.github.com"].includes(account.origin.replace(/\/+$/, ""));

/** Where a clicked link to a github.com pull request opens in Makosh Git: the first github.com account; null to leave the link alone. */
export function linkTarget(href: string, accounts: readonly AccountRef[]): {accountId: string; repo: string; number: number} | null {
  const pr = prFromUrl(href);
  const account = pr ? accounts.find(githubCom) : undefined;
  return pr && account ? {accountId: account.id, ...pr} : null;
}
