// The day notices (slice 3f): what the toast says for a Today digest or a
// reply reminder that turned due. Names and addresses only, never a subject
// or any mail text; the address always shows beside a name. Host-free:
// app.tsx shows it from the badge hook.
import type { DayNotice } from "../core/contract.ts";

/** How long a day notice toast stays. */
export const DAY_NOTICE_TOAST_MS = 12_000;

export interface DayNoticePlan {
  title: string;
  description: string;
  /** Where Open goes: the Today page, or the conversation of the sent message. */
  open: { page: "today" } | { accountId: string; threadId: string };
}

export function dayNoticePlan(notice: DayNotice): DayNoticePlan {
  if (notice.kind === "digest") {
    const count = notice.replyCount;
    return {
      title:
        count === 0
          ? "Today: nothing needs a reply"
          : count === 1
            ? "Today: 1 conversation needs a reply"
            : `Today: ${count} conversations need a reply`,
      description: "Your Today view is ready.",
      open: { page: "today" },
    };
  }
  if (notice.kind === "rule") {
    const count = notice.count;
    return {
      title: `Rule ${notice.ruleName}: ${count === 1 ? "a thread is ready" : `${count} threads are ready`}`,
      description: "Review it in the Inbox.",
      open: { page: "today" },
    };
  }
  const name = notice.name.trim();
  const address = notice.address.trim();
  const who = name !== "" ? name : address !== "" ? address : "the recipient";
  return {
    title: `No reply from ${who}`,
    description: name !== "" && address !== "" ? `${address} \u00b7 waiting for a reply` : "Waiting for a reply",
    open: notice.threadId !== null ? { accountId: notice.accountId, threadId: notice.threadId } : { page: "today" },
  };
}
