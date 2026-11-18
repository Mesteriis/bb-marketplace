// Helper wire messages for SSH askpass (stage 3b-2). A prompt the helper must not answer itself
// (a host key confirmation, an informational message) reaches the user as `ssh.prompt`; the
// user's answer goes back once as `ssh.prompt_answer` and is never stored. The credential events
// tell the user what happened to a SAVED credential without any of it being the secret.
import { z } from "zod";

const idSchema = z.number().int().min(0);
const sessionIdSchema = z.number().int().min(0).max(0xffff_ffff);

export const sshPromptAnswerRequestSchema = z.object({
  type: z.literal("ssh.prompt_answer"),
  id: idSchema,
  sessionId: sessionIdSchema,
  promptId: z.number().int().min(0),
  /** null = the user cancelled. */
  answer: z.string().max(4096).nullable(),
});

export const sshPromptSchema = z.object({
  type: z.literal("ssh.prompt"),
  sessionId: sessionIdSchema,
  promptId: z.number().int().min(0),
  text: z.string().max(1024),
  /** "confirm" (yes/no, e.g. a host key) or "none" (informational). */
  kind: z.string().min(1).max(16),
});
export const sshCredentialRejectedSchema = z.object({ type: z.literal("ssh.credential_rejected"), sessionId: sessionIdSchema });
export const sshCredentialFailedSchema = z.object({
  type: z.literal("ssh.credential_failed"),
  sessionId: sessionIdSchema,
  code: z.string().min(1).max(64),
});
export const sshPromptAckSchema = z.object({ type: z.literal("ssh.prompt_ack"), id: idSchema });

export const sshAskpassRequestSchemas = [sshPromptAnswerRequestSchema] as const;
export const sshAskpassResponseSchemas = [sshPromptSchema, sshCredentialRejectedSchema, sshCredentialFailedSchema, sshPromptAckSchema] as const;

/** What the page is told about a session's askpass activity. */
export type SshAskpassEvent =
  | { type: "prompt"; promptId: number; text: string; kind: string }
  | { type: "credential_rejected" }
  | { type: "credential_failed"; code: string };
