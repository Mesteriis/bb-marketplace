import type { GithubFacts } from "../../core/forge/account-pick.ts";
import type { Account } from "../../core/providers.ts";
import { provider } from "./provider.ts";
import { array, client, object, text } from "./provider-http.ts";

type Context = (accountId: string) => Promise<{account: Account; token: string}>;

/** GitHub facts used to choose an account: organization membership and repository visibility. */
export function accountFacts(context: Context, send: typeof fetch = fetch): GithubFacts {
  return {
    async orgs(accountId) {
      const {account, token} = await context(accountId);
      const http = client(account, token, send);
      const logins: string[] = [];
      for (let page = 1; page <= 10; page++) {
        const rows = array((await http("/user/orgs?per_page=100&page=" + page)).payload);
        logins.push(...rows.map(row => text(object(row).login)).filter(Boolean));
        if (rows.length < 100) break;
      }
      return logins;
    },
    async canSee(accountId, path) {
      const {account, token} = await context(accountId);
      try {
        await provider(account, token, send).repository(path);
        return true;
      } catch (error) {
        if (error instanceof Error && error.message === "PROVIDER_DENIED") return false;
        throw error;
      }
    },
  };
}
