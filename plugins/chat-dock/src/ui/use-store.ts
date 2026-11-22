import { useSyncExternalStore } from "react";
import type { StagedContext, Staging } from "../core/staging.ts";

export function useStaged(staging: Staging): StagedContext | null {
  return useSyncExternalStore(staging.subscribe, staging.get, staging.get);
}
