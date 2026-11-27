import type { PrAction } from "./actions.ts";
import type { PrDetail } from "./detail.ts";
import type { PrFile } from "./diff.ts";

/** One pull request's detail, files and writes on one forge. Every write is a single confirmed request. */
export interface PullReview {
  detail(number: number): Promise<PrDetail>;
  files(number: number): Promise<PrFile[]>;
  /** `current` is the detail re-read at confirmation; its head has already been checked against the preview. */
  act(number: number, action: PrAction, current: PrDetail): Promise<{outcome: "completed" | "accepted"}>;
}
