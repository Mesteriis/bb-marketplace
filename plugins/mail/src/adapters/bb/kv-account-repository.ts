import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  mailAccountSchema,
  type AccountRepository,
  type MailAccount,
} from "../../core/index.ts";

const ACCOUNTS_KEY = "accounts";
const storedAccountsSchema = z.array(mailAccountSchema);

/** AccountRepository on BB's plugin key-value storage. */
export function createKvAccountRepository(
  kv: BbPluginApi["storage"]["kv"],
): AccountRepository {
  return {
    async list(): Promise<MailAccount[]> {
      const stored = await kv.get<unknown>(ACCOUNTS_KEY);
      if (stored === null || stored === undefined) return [];
      // Persisted values are untrusted: a bad value fails here, not in the UI.
      return storedAccountsSchema.parse(stored);
    },
  };
}
