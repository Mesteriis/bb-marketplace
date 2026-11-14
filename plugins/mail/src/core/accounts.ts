import { z } from "zod";

/** A mail account the user connected. */
export const mailAccountSchema = z.object({
  id: z.string().min(1),
  address: z.string().min(3),
  displayName: z.string().min(1).optional(),
});
export type MailAccount = z.infer<typeof mailAccountSchema>;

/**
 * Port: where connected accounts are kept. Each host supplies an adapter
 * (BB: src/adapters/bb/kv-account-repository.ts).
 */
export interface AccountRepository {
  list(): Promise<MailAccount[]>;
}
