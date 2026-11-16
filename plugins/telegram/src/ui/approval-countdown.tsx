import { useEffect, useState } from "react";

export function ApprovalCountdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (seconds === 0) return <p role="status">This Telegram approval has expired.</p>;
  const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <p role="timer">Time to confirm in BB: {remaining}</p>;
}
