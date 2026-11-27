import { useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import type { rpc } from "../adapters/bb/rpc.ts";

/** The Notifications settings section: how My PRs alerts reach you, and a test alert to see it. */
export function NotificationSettings() {
  const client = useRpc<typeof rpc>();
  const [state, setState] = useState<{sending: boolean; result: string}>({sending: false, result: ""});
  return <div className="git-ws"><div className="git-stack">
    <p className="git-muted">My PRs alerts show in Makosh Git as toasts and an unread count. Through BB's Push notifications plugin they also go to its
      channels: desktop and web while a BB window is open, and registered phones. The watcher runs on the BB server and pauses while BB is not running.</p>
    <div className="git-row">
      <button type="button" disabled={state.sending} onClick={() => {
        setState({sending: true, result: ""});
        client.call("inboxTest", {}).then(answer => setState({sending: false, result: answer.ok ? answer.push.message + " The alert is in My PRs." : answer.code + " · " + answer.next}),
          (failure: unknown) => setState({sending: false, result: failure instanceof Error ? failure.message : "The test alert was not sent."}));
      }}>Send test notification</button>
      {state.result && <span role="status">{state.result}</span>}
    </div>
  </div></div>;
}
