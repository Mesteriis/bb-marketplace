import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";

export function useApprovalSeconds(expiresAt?: number | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (expiresAt == null) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) { setNow(Date.now()); return; }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const deadline = setTimeout(() => {
      clearInterval(timer);
      setNow(Date.now());
    }, remaining);
    return () => { clearInterval(timer); clearTimeout(deadline); };
  }, [expiresAt]);

  return expiresAt == null ? undefined : Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function ApprovalCountdown({ expiresAt }: { expiresAt: number }) {
  const seconds = useApprovalSeconds(expiresAt);
  return <ApprovalTime seconds={seconds} />;
}

export function ApprovalTime({ seconds }: { seconds?: number }) {
  const { t: tr } = useTelegramLocale();
  if (seconds === undefined) return null;
  if (seconds === 0) return <p role="status">{tr("This Telegram approval has expired.")}</p>;
  const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <p role="timer">{tr("Time to confirm in BB: ")}{remaining}</p>;
}
