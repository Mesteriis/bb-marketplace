import { z } from "zod";
import { DIFF_PROVIDER, diffParamsSchema, FILE_PREVIEW_PROVIDER, filePreviewParamsSchema } from "../diff/refs.ts";
import { entryCards } from "./entry-card.ts";
import type { PanelProvider } from "./provider.ts";
import { panelRefSchema, type PanelRef } from "./ref.ts";

export const CHOOSE_PROVIDER = "chertog-choose";
export const chooseParamsSchema = z.strictObject({
  kind: z.enum(["bb-thread", FILE_PREVIEW_PROVIDER, DIFF_PROVIDER, "bb-terminal", "any"]),
});
export type ChooseKind = z.infer<typeof chooseParamsSchema>["kind"];

const targets: Record<Exclude<ChooseKind, "any">, z.ZodType> = {
  "bb-thread": z.strictObject({ threadId: z.string().min(1).max(128) }),
  [FILE_PREVIEW_PROVIDER]: filePreviewParamsSchema,
  [DIFF_PROVIDER]: diffParamsSchema,
  "bb-terminal": entryCards["bb-terminal"].paramsSchema,
};

export function acceptsChoice(chooser: PanelRef, selected: PanelRef): boolean {
  const params = chooseParamsSchema.safeParse(chooser.params);
  if (chooser.provider !== CHOOSE_PROVIDER || !params.success) return false;
  // The picker opened beside a tile takes any content; the provider checks its own parameters when it opens.
  if (params.data.kind === "any") return selected.provider !== CHOOSE_PROVIDER && panelRefSchema.safeParse(selected).success;
  return selected.provider === params.data.kind && targets[params.data.kind].safeParse(selected.params).success;
}

export const chooseProvider: PanelProvider = {
  type: CHOOSE_PROVIDER,
  paramsSchema: chooseParamsSchema,
  multipleViews: true,
  capabilities: {
    showNativeRoute: "no", embedInstance: "no", keepLiveInDocument: "no",
    rebindToSession: "no", transferBetweenWindows: "no", restoreAfterRestart: "yes",
  },
  async open({ ref }) {
    return ref.provider === CHOOSE_PROVIDER && panelRefSchema.safeParse(ref).success && chooseParamsSchema.safeParse(ref.params).success
      ? { status: "entry" } : { status: "access-denied" };
  },
  // An entry owns no external resource or session.
  release() {},
  endsSessionOnLastClose: () => false,
  endSession: async () => "unknown",
};
