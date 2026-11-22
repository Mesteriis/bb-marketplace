// Wire contracts of BB Chat Dock: the page ↔ server RPC and the server ↔
// host RPC. Neither carries page content: the status says only whether the
// window is open.
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { insideViewport, MAX_OWNER_LENGTH, type Attachment } from "./src/core/attachment.ts";
import type { WindowStatusView } from "./src/core/window-status.ts";

export const windowStatusSchema = z
  .object({
    window: z.enum(["closed", "building", "open", "unavailable"]),
    /** Why the window cannot open; null otherwise. */
    reason: z.string().max(300).nullable(),
  })
  .strict();

export type WindowStatusWire = z.infer<typeof windowStatusSchema>;

const finite = z.number().finite().min(-100_000).max(100_000);

export const attachmentSchema = z
  .object({
    owner: z.string().max(MAX_OWNER_LENGTH),
    visible: z.boolean(),
    x: finite,
    y: finite,
    width: finite.min(0),
    height: finite.min(0),
    innerWidth: finite.positive(),
    innerHeight: finite.positive(),
    outerWidth: finite.positive(),
    outerHeight: finite.positive(),
    screenX: finite,
    screenY: finite,
    pixelRatio: z.number().finite().positive().max(16),
  })
  .strict()
  // The window may cover only the page's own viewport.
  .refine((a) => !a.visible || insideViewport(a), { message: "area outside the page's viewport" });

const attachOutput = z.object({ ok: z.literal(true) }).strict();

const methods = {
  open: { input: z.null(), output: windowStatusSchema },
  attach: { input: attachmentSchema, output: attachOutput },
  status: { input: z.null(), output: windowStatusSchema, experimental_retryable: true },
};

export const hostContract = defineRpcContract(methods);

export const hostSignals = {
  changed: { payload: windowStatusSchema },
} satisfies ExperimentalHostSignals;

export const rpcContract = defineRpcContract({
  open: { input: z.null(), output: windowStatusSchema },
  attach: { input: attachmentSchema, output: attachOutput },
  status: { input: z.null(), output: windowStatusSchema },
});

export const STATUS_CHANNEL = "window-status";

// The page reads these through the plain types in src/core/window-status.ts.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const statusMatches: Same<WindowStatusWire, WindowStatusView> = true;
const attachmentMatches: Same<z.infer<typeof attachmentSchema>, Attachment> = true;
void attachmentMatches;
void statusMatches;
