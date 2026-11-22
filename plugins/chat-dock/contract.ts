// Wire contracts of BB Chat Dock: the page ↔ server RPC and the server ↔
// host RPC. Neither carries page content: the status says only whether a
// proposal waits and how the last one ended.
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ProposeOutcome, WindowStatusView } from "./src/core/window-status.ts";

export const MAX_PROPOSAL_LENGTH = 100_000;

export const windowStatusSchema = z
  .object({
    window: z.enum(["closed", "building", "open", "unavailable"]),
    /** Why the window cannot open; null otherwise. */
    reason: z.string().max(300).nullable(),
    proposal: z.enum(["none", "waiting", "writing"]),
    last: z
      .object({
        proposalId: z.string().max(100),
        outcome: z.enum(["handed-off", "unknown", "refused", "copied", "cancelled"]),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type WindowStatusWire = z.infer<typeof windowStatusSchema>;

export const proposeInputSchema = z
  .object({
    text: z.string().min(1).max(MAX_PROPOSAL_LENGTH),
    source: z.enum(["message-selection", "manual"]),
  })
  .strict();

export const proposeOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), proposalId: z.string() }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(["busy", "empty-text", "text-too-long", "window-unavailable"]) }).strict(),
]);

const methods = {
  open: { input: z.null(), output: windowStatusSchema },
  propose: { input: proposeInputSchema, output: proposeOutputSchema },
  status: { input: z.null(), output: windowStatusSchema, experimental_retryable: true },
};

export const hostContract = defineRpcContract(methods);

export const hostSignals = {
  changed: { payload: windowStatusSchema },
} satisfies ExperimentalHostSignals;

export const rpcContract = defineRpcContract({
  open: { input: z.null(), output: windowStatusSchema },
  propose: { input: proposeInputSchema, output: proposeOutputSchema },
  status: { input: z.null(), output: windowStatusSchema },
});

export const STATUS_CHANNEL = "window-status";

// The page reads these through the plain types in src/core/window-status.ts.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const statusMatches: Same<WindowStatusWire, WindowStatusView> = true;
const proposeMatches: Same<z.infer<typeof proposeOutputSchema>, ProposeOutcome> = true;
void statusMatches;
void proposeMatches;
