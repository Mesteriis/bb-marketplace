import { useEffect, useState } from "react";
import type { PeerProfile } from "../core/contract.ts";

export function formatBirthdate({ day, month, year }: NonNullable<PeerProfile["birthdate"]>) {
  const date = new Date(0);
  date.setUTCFullYear(year || 2000, month - 1, day);
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric",
    ...(year ? { year: "numeric" } : {}), timeZone: "UTC" }).format(date);
}

export function useBirthdayCalendar() {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function refresh() {
      clearTimeout(timer);
      const now = new Date();
      setToday(now);
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      timer = setTimeout(refresh, midnight.getTime() - now.getTime());
    }
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return today;
}

export function isBirthdate(birthdate: NonNullable<PeerProfile["birthdate"]>, date: Date) {
  return date.getDate() === birthdate.day && date.getMonth() + 1 === birthdate.month;
}
