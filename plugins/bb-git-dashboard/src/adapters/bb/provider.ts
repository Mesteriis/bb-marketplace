import type { Account, Provider } from "../../core/providers.ts";
import { client } from "./provider-http.ts";
import { forgeProvider } from "./forge-provider.ts";
import { azureProvider } from "./azure-provider.ts";
import { gitlabProvider } from "./forges/gitlab-provider.ts";

export function provider(account: Account, token: string, transport: typeof fetch = fetch): Provider {
  const http = client(account, token, transport);
  if (account.kind === "gitlab") return gitlabProvider(account, http);
  return account.kind === "azure" ? azureProvider(account, http) : forgeProvider(account, http);
}
