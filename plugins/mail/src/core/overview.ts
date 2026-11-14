import { z } from "zod";
import { mailAccountSchema, type AccountRepository } from "./accounts.ts";

/** What the Mail page shows first: the connected accounts. */
export const mailOverviewSchema = z.object({
  accounts: z.array(mailAccountSchema),
});
export type MailOverview = z.infer<typeof mailOverviewSchema>;

export async function getMailOverview(deps: {
  accounts: AccountRepository;
}): Promise<MailOverview> {
  const accounts = await deps.accounts.list();
  return {
    accounts: [...accounts].sort((left, right) =>
      left.address.localeCompare(right.address),
    ),
  };
}
