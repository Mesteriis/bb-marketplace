import { useEffect, useMemo, useRef } from "react";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../../server.ts";
import type { ZoomPageApi } from "../../ui/api.ts";

export type ZoomRpc = ReturnType<typeof useRpc<typeof rpcContract>>;

// Host renders may replace the RPC wrapper. The page depends on this API's
// identity for loading; a new transport alone must not reload its data.
export function useZoomApi(rpc: ZoomRpc): ZoomPageApi {
  const rpcRef = useRef(rpc);
  useEffect(() => {
    rpcRef.current = rpc;
  }, [rpc]);
  return useMemo<ZoomPageApi>(
    () => ({
      status: () => rpcRef.current.call("status", null),
      redirectUri: (origin) => rpcRef.current.call("redirect_uri", { origin }).then((result) => result.redirectUri),
      beginLogin: (origin) => rpcRef.current.call("login_begin", { origin }),
      disconnect: () => rpcRef.current.call("disconnect", null).then(() => undefined),
      listMeetings: () => rpcRef.current.call("meetings_list", null).then((result) => result.meetings),
      createMeeting: (input) => rpcRef.current.call("meeting_create", input).then((result) => result.meeting),
      prepareCall: (input) => rpcRef.current.call("call_prepare", input),
      openCallInBrowser: (input) => rpcRef.current.call("call_open_external", input),
    }),
    [],
  );
}
