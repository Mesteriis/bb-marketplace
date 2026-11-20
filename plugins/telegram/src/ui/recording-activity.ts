import type { RecordingActivity } from "../core/contract.ts";

export type DispatchRecordingActivity = (activity: RecordingActivity) => Promise<boolean>;

export function announceRecording(send: DispatchRecordingActivity, kind: "voice" | "video"): () => void {
  let pending: Promise<void> | undefined;
  let announced = false;
  let stopped = false;

  function renew() {
    if (pending || stopped) return;
    pending = Promise.resolve().then(() => stopped ? false : send(kind))
      .then((accepted) => { announced ||= accepted; }, () => {})
      .finally(() => { pending = undefined; });
  }

  renew();
  const interval = setInterval(renew, 4000);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    void (pending ?? Promise.resolve()).then(() => {
      if (announced) return send("cancel");
    }).catch(() => {});
  };
}
