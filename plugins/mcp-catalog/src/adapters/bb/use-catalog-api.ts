import { useEffect, useMemo, useRef } from "react";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../../server";
import type { CatalogApi } from "../../ui/api";

export type CatalogRpc = ReturnType<typeof useRpc<typeof rpcContract>>;

/** Binds the page's API to BB RPC. Depends on a stable identity: a replaced RPC wrapper must not reload the tabs. */
export function useCatalogApi(rpc: CatalogRpc): CatalogApi {
  const rpcRef = useRef(rpc);
  useEffect(() => {
    rpcRef.current = rpc;
  }, [rpc]);
  return useMemo<CatalogApi>(
    () => ({
      inventory: () => rpcRef.current.call("inventory", null),
      setEnabled: (input) => rpcRef.current.call("setEnabled", input).then(() => undefined),
      approve: (input) => rpcRef.current.call("approve", input).then(() => undefined),
      auth: (input) => rpcRef.current.call("auth", input),
      setSecrets: (input) => rpcRef.current.call("setSecrets", input).then(() => undefined),
      remove: (input) => rpcRef.current.call("remove", input).then(() => undefined),
      update: (input) => rpcRef.current.call("update", input).then(() => undefined),
      collection: () => rpcRef.current.call("collection", null),
      search: (query, cursor) => rpcRef.current.call("search", cursor === undefined ? { query } : { query, cursor }),
      startReview: (input) => rpcRef.current.call("startReview", input),
      reviews: () => rpcRef.current.call("reviews", null),
      accept: (input) => rpcRef.current.call("accept", input).then(() => undefined),
      reject: (input) => rpcRef.current.call("reject", input).then(() => undefined),
      install: (input) => rpcRef.current.call("install", input),
      secretsState: (input) => rpcRef.current.call("secretsState", input),
      config: () => rpcRef.current.call("config", null),
    }),
    [],
  );
}
