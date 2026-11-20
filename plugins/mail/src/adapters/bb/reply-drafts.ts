// Auto drafts (AI writes mail) on the server: which of a round's new Inbox
// messages get a reply drafted, the request for each, the kept draft and
// the two owner methods that read and dismiss it. The model call goes
// through the queue and the AI job runner; nothing here sends mail or
// writes to the mail server.
import type { AiBuild } from "../../core/ai-input.ts";
import { writeInput, type WriteBuild } from "../../core/ai-write.ts";
import { AUTO_DRAFT_QUEUE, REPLY_DRAFT_PREVIEW, REPLY_DRAFTS_MAX, DraftBudget, eligible, replyDraftStale, type AutoDraftRow } from "../../core/auto-drafts.ts";
import { ownAddresses } from "../../core/compose.ts";
import { truncateText } from "../../core/html-entities.ts";
import type { LogEntryInput } from "../../core/agent-log.ts";
import type { Clock, MailStore } from "../../core/index.ts";
import { conversationUpTo, voiceFor, type WriteSettings } from "../../core/write-source.ts";
import type { AiJobs } from "./ai-jobs.ts";
import { UnattendedAiQueue, type UnattendedGate } from "./unattended-ai-queue.ts";

export type ReplyDraftsDeps = {
  store: MailStore;
  clock: Clock;
  /** The aiAutoDrafts setting. */
  enabled: () => boolean;
  writeSettings: () => WriteSettings;
  /** The owner's AI provider and model settings. */
  aiContext: () => { provider: string; model: string };
  jobs: Pick<AiJobs, "start" | "settled" | "poll" | "finished" | "cancel">;
  /** A builder over a fresh nonce, re-drawn while the input holds it. */
  withNonce: <T extends AiBuild>(build: (nonce: string) => T) => T;
  restoreTag: (parts: string[]) => string;
  agentLog: (entry: LogEntryInput) => unknown;
  /** The stored sender check failed, or Mail warns about the sender (a stored header does not carry these). */
  suspicious: (messageId: string) => boolean;
  /** A draft was kept for a message of this account: the page reloads. */
  onKept: (accountId: string) => void;
  schedule: (run: () => void, ms: number) => () => void;
  log: (line: string) => void;
  /** Shared with the other unattended queues: one call at a time. */
  gate?: UnattendedGate;
};

/** The kept draft as the page shows it. */
export type ReplyDraftView = {
  paragraphs: string[];
  /** The first lines, for the strip. */
  preview: string;
  linksRemoved: number;
  provider: string;
  model: string;
  createdAt: string;
};

const lower = (address: string) => address.trim().toLowerCase();

export function createReplyDrafts(deps: ReplyDraftsDeps) {
  const { store, clock } = deps;
  const nowIso = () => clock.now().toISOString();
  const own = () => new Set(ownAddresses(store).map(lower));

  /** When the owner last wrote in the message's conversation; null: never. */
  const ownerRepliedAt = (threadId: string | null, folder: string): string | null => {
    const thread = threadId === null ? null : store.getThread(threadId, folder);
    if (thread === null) return null;
    const mine = own();
    let latest: string | null = null;
    for (const message of thread.messages) {
      if (message.date !== null && mine.has(lower(message.from.address)) && (latest === null || message.date > latest)) latest = message.date;
    }
    return latest;
  };
  const answeredSince = (threadId: string | null, folder: string, date: string | null): boolean => {
    const replied = ownerRepliedAt(threadId, folder);
    return replied !== null && date !== null && replied > date;
  };

  /** The stored facts of one message the rule reads; null when it is gone. */
  const rowOf = (messageId: string): (AutoDraftRow & { accountId: string }) | null => {
    const header = store.getMessage(messageId);
    const notify = store.notifyRows([messageId], nowIso())[0];
    if (header === null || notify === undefined || notify.movePending !== null) return null;
    const body = store.getBody(messageId);
    const source = store.replySource(messageId);
    return {
      accountId: header.accountId,
      folderRole: notify.folderRole,
      bulk: notify.bulk,
      listed: (store.getUnsubscribeInfo(messageId)?.listKey ?? null) !== null,
      fromAddress: header.from.address,
      to: header.to.map((address) => address.address),
      hasBody: body !== null && ((body.text ?? "").trim() !== "" || (body.html ?? "").trim() !== ""),
      inAiScope: header.inAiScope,
      suspicious: deps.suspicious(messageId),
      // A row synced before Reply-To was stored says nothing about it: treated as an unknown address.
      replyTo: source === null ? [] : source.replyToKnown ? source.replyTo.map((address) => address.address) : ["unknown"],
      answered: answeredSince(header.threadId, header.folder, header.date),
    };
  };

  const qualifies = (messageId: string): string | null => {
    const row = rowOf(messageId);
    if (row === null) return null;
    return eligible(row, { own: own(), sentTo: store.addressesSentTo([row.fromAddress, ...row.replyTo]) }) ? row.accountId : null;
  };

  /** The request for one message, checked again when its turn comes. */
  const build = (messageId: string): { built: WriteBuild; tag: string; accountId: string } | null => {
    const accountId = qualifies(messageId);
    const header = accountId === null ? null : store.getMessage(messageId);
    if (accountId === null || header === null) return null;
    const conversation = conversationUpTo(store, header);
    if (conversation === "out_of_scope" || conversation.messages.length === 0) return null;
    const settings = deps.writeSettings();
    const tag = deps.restoreTag([settings.personal, settings.facts]);
    const built = deps.withNonce((nonce) =>
      writeInput(
        {
          mode: "autodraft",
          own: [],
          personal: settings.personal,
          facts: settings.facts,
          voice: voiceFor(store, settings, header.from.address),
          conversation: conversation.messages,
        },
        { nonce, tag, leftOut: conversation.leftOut },
      ),
    );
    return { built, tag, accountId };
  };

  const queue = new UnattendedAiQueue<{ messageId: string; accountId: string }>({
    kind: "autodraft",
    label: "auto draft",
    batch: 1,
    limit: AUTO_DRAFT_QUEUE,
    enabled: deps.enabled,
    build: (ids) => {
      const messageId = ids[0];
      const made = messageId === undefined ? null : build(messageId);
      if (made === null || messageId === undefined) return null;
      return { built: made.built, context: { tag: made.tag, allowedLinks: made.built.allowedLinks }, ids: [messageId], made: { messageId, accountId: made.accountId } };
    },
    jobs: deps.jobs,
    context: deps.aiContext,
    done: (made, finished) => {
      const output = finished.output;
      if (output.kind !== "write" || !output.value.reply || output.value.paragraphs.length === 0) return;
      store.saveReplyDraft(
        {
          messageId: made.messageId,
          accountId: made.accountId,
          paragraphs: output.value.paragraphs,
          linksRemoved: output.value.linksRemoved,
          provider: finished.provider,
          model: finished.model,
          createdAt: nowIso(),
        },
        REPLY_DRAFTS_MAX,
      );
      deps.onKept(made.accountId);
    },
    logCall: (built) => {
      const { provider, model } = deps.aiContext();
      deps.agentLog({
        actor: "owner_ai",
        tool: "ai_autodraft",
        outcome: "ok",
        messageIds: built.parts.map((part) => part.messageId),
        count: built.parts.length,
        hiddenCount: built.notes.hidden,
        provider,
        model,
      });
    },
    budget: new DraftBudget(clock),
    schedule: deps.schedule,
    log: deps.log,
    ...(deps.gate === undefined ? {} : { gate: deps.gate }),
  });

  return {
    /** A round's new Inbox messages that block rules and filters left: those that qualify wait for a draft. */
    offer(ids: readonly string[]): void {
      if (ids.length === 0 || !deps.enabled()) return;
      queue.offer(ids.filter((id) => qualifies(id) !== null));
    },

    /** The kept draft of a message; one that is no longer wanted is deleted and answers null. */
    get(messageId: string): { draft: ReplyDraftView | null } {
      const draft = store.getReplyDraft(messageId);
      if (draft === null) return { draft: null };
      const header = store.getMessage(messageId);
      const notify = header === null ? undefined : store.notifyRows([messageId], nowIso())[0];
      const message =
        header === null || notify === undefined
          ? null
          : { folderRole: notify.folderRole, ownerRepliedAt: ownerRepliedAt(header.threadId, header.folder), inAiScope: header.inAiScope };
      // Turned off: what was drafted before is not offered any more.
      if (!deps.enabled() || replyDraftStale(draft, message, clock.now())) {
        store.deleteReplyDraft(messageId);
        return { draft: null };
      }
      return {
        draft: {
          paragraphs: draft.paragraphs,
          preview: truncateText(draft.paragraphs.join(" ").replace(/\s+/g, " ").trim(), REPLY_DRAFT_PREVIEW),
          linksRemoved: draft.linksRemoved,
          provider: draft.provider,
          model: draft.model,
          createdAt: draft.createdAt,
        },
      };
    },

    /** Use and Dismiss both end here: the draft is the owner's text now, or not wanted. */
    dismiss(messageId: string): { ok: true } {
      store.deleteReplyDraft(messageId);
      return { ok: true };
    },

    queue,
  };
}

export type ReplyDrafts = ReturnType<typeof createReplyDrafts>;
