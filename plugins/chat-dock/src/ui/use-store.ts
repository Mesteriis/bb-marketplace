import { useCallback, useSyncExternalStore } from "react";
import type { Consent } from "../core/consent.ts";
import type { StagedContext, Staging } from "../core/staging.ts";
import type { TransferSession, TransferState } from "../core/transfer.ts";

export function useStaged(staging: Staging): StagedContext | null {
  return useSyncExternalStore(staging.subscribe, staging.get, staging.get);
}

export function useConsent(consent: Consent): boolean {
  return useSyncExternalStore(consent.subscribe, consent.granted, consent.granted);
}

const NO_SESSION: TransferState = { kind: "unbound", refusal: null };

export function useTransferState(session: TransferSession | null): TransferState {
  const subscribe = useCallback(
    (listener: () => void) => (session === null ? () => {} : session.subscribe(listener)),
    [session],
  );
  const get = useCallback(() => (session === null ? NO_SESSION : session.getState()), [session]);
  return useSyncExternalStore(subscribe, get, get);
}
