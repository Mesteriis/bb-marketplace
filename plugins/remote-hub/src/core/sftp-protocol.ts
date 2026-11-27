// Helper wire messages for SFTP channels: `ssh -s sftp` with NO pty. The helper only starts ssh and relays bytes as stream
// frames under the channel's id; the SFTP protocol is spoken here (core/sftp-client.ts). Mirrors helper/src/protocol.rs
// (sftp.*).
import { z } from "zod";

const idSchema = z.number().int().min(0);
const sftpIdSchema = z.number().int().min(0).max(0xffff_ffff);

export const sftpOpenRequestSchema = z.object({
  type: z.literal("sftp.open"),
  id: idSchema,
  program: z.string().min(1),
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  /** A saved credential; without one ssh asks nothing at all (an agent, or a key without a passphrase). */
  askpass: z.object({ credentialRef: z.string().min(1).max(96) }).optional(),
});
export const sftpCloseRequestSchema = z.object({ type: z.literal("sftp.close"), id: idSchema, sftpId: sftpIdSchema });

export const sftpOpenedSchema = z.object({ type: z.literal("sftp.opened"), id: idSchema, sftpId: sftpIdSchema });
export const sftpClosingSchema = z.object({ type: z.literal("sftp.closing"), id: idSchema });
export const sftpClosedSchema = z.object({
  type: z.literal("sftp.closed"),
  sftpId: sftpIdSchema,
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  /** exited, closed, input_overflow. */
  reason: z.string(),
  /** A question ssh asked that was refused (host_key, login_prompt), or credential_rejected / credential_unavailable. */
  refused: z.string().nullable(),
  /** The head of ssh's stderr. For this plugin's backend only: it may name a key file, so it is never passed on. */
  stderr: z.string(),
});

export const sftpRequestSchemas = [sftpOpenRequestSchema, sftpCloseRequestSchema] as const;
export const sftpResponseSchemas = [sftpOpenedSchema, sftpClosingSchema, sftpClosedSchema] as const;

export type SftpClosedMessage = z.infer<typeof sftpClosedSchema>;

/** How a channel ended, as the rest of the plugin sees it. `helper_exit`: the helper itself went away. */
export interface SftpChannelEnd {
  reason: string;
  exitCode: number | null;
  refused: string | null;
  stderr: string;
}
