// AI sorts the inbox on the server: which of a round's new Inbox messages
// are sorted, the request for a batch, what is kept (one line and the
// owner's labels per message), the automatic archive of a label the owner
// marked, the owner's label methods, and the fields the lists show. The
// model call goes through the unattended queue and the AI job runner.
import type { LogEntryInput } from "../../core/agent-log.ts";
import { resolveActionDestination } from "../../core/actions.ts";
import type { AiBuild } from "../../core/ai-input.ts";
import {
  AiLabelRefusal,
  LABEL_DESCRIPTION_CHARS,
  MESSAGE_AI_DAYS,
  SORT_BATCH,
  labelNameRefusal,
  sortInput,
  type AiLabel,
  type MessageAi,
} from "../../core/ai-sort.ts";
import { DraftBudget } from "../../core/auto-drafts.ts";
import { ownAddresses } from "../../core/compose.ts";
import type { Clock, MailStore, MessageHeader, ThreadSummary } from "../../core/index.ts";
import { sourceMessageOf } from "../../core/write-source.ts";
import type { AiJobs } from "./ai-jobs.ts";
import { UnattendedAiQueue } from "./unattended-ai-queue.ts";

/** Model calls a day (each sorts up to SORT_BATCH messages). */
export const SORT_CALLS_PER_DAY = 100;
/** Most messages waiting to be sorted. */
export const SORT_QUEUE = 200;
/** Most automatic archives an hour; past it the label is kept and the message stays. */
export const AUTO_ARCHIVES_PER_HOUR = 50;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const lower = (address: string) => address.trim().toLowerCase();

export type AiSortDeps = {
  store: MailStore;
  clock: Clock;
  /** The aiSort setting. */
  enabled: () => boolean;
  /** The owner's AI provider and model settings. */
  aiContext: () => { provider: string; model: string };
  jobs: Pick<AiJobs, "start" | "settled" | "poll" | "finished" | "cancel">;
  /** A builder over a fresh nonce, re-drawn while the input holds it. */
  withNonce: <T extends AiBuild>(build: (nonce: string) => T) => T;
  /** The stored sender check failed, or Mail warns about the sender. */
  suspicious: (messageId: string) => boolean;
  agentLog: (entry: LogEntryInput) => unknown;
  /** Stored mail of this account changed (a line, a label, a queued archive): the page reloads. */
  onChanged: (accountId: string) => void;
  /** A move was queued for this account: its next round carries it out. */
  wake: (accountId: string) => void;
  newId: () => string;
  schedule: (run: () => void, ms: number) => () => void;
  log: (line: string) => void;
};

/** A refusal of a label method with fixed text. */
export class AiSortRefusal extends Error {
  constructor(
    readonly code: "invalid" | "conflict" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "AiSortRefusal";
  }
}

export function createAiSort(deps: AiSortDeps) {
  const { store, clock } = deps;
  const nowIso = () => clock.now().toISOString();
  const own = () => new Set(ownAddresses(store).map(lower));
  const archived: number[] = [];

  /** New in the Inbox, still there, inside AI access, with a body, not the owner's own. */
  const qualifies = (messageId: string): MessageHeader | null => {
    const header = store.getMessage(messageId);
    const notify = store.notifyRows([messageId], nowIso())[0];
    if (header === null || notify === undefined || notify.movePending !== null || notify.folderRole !== "inbox") return null;
    if (!header.inAiScope || own().has(lower(header.from.address))) return null;
    const body = store.getBody(messageId);
    if (body === null || ((body.text ?? "").trim() === "" && (body.html ?? "").trim() === "")) return null;
    return header;
  };

  /**
   * Archives the messages a marked label asks for. Left in the Inbox: mail
   * from someone the owner has written to, flagged mail, mail Mail warns
   * about, mail no longer in the Inbox, an account without an Archive
   * folder, and everything past the hourly bound.
   */
  const autoArchive = (ids: readonly string[]): void => {
    const now = clock.now().getTime();
    while (archived.length > 0 && archived[0]! <= now - HOUR_MS) archived.shift();
    const moved = new Map<string, string[]>();
    for (const id of ids) {
      if (archived.length >= AUTO_ARCHIVES_PER_HOUR) break;
      const header = qualifies(id);
      if (header === null || header.isFlagged || deps.suspicious(id)) continue;
      if (store.addressesSentTo([header.from.address]).has(lower(header.from.address))) continue;
      const account = store.getAccount(header.accountId);
      if (account === null) continue;
      const resolved = resolveActionDestination("archive", header.folder, store.listFolders(header.accountId), account.preset);
      if ("refusal" in resolved) continue;
      if (store.queueMove([id], resolved.destination.path) === null) continue;
      archived.push(now);
      moved.set(header.accountId, [...(moved.get(header.accountId) ?? []), id]);
    }
    for (const [accountId, list] of moved) {
      deps.agentLog({ actor: "owner_ai", tool: "ai_archive", outcome: "ok", messageIds: list, count: list.length });
      deps.log(`sort ${accountId}: archived ${list.length}`);
      deps.wake(accountId);
    }
  };

  const queue = new UnattendedAiQueue<{ ids: string[]; labels: AiLabel[] }>({
    kind: "sort",
    label: "sort",
    batch: SORT_BATCH,
    limit: SORT_QUEUE,
    enabled: deps.enabled,
    build: (ids) => {
      const headers = ids.map(qualifies).filter((header): header is MessageHeader => header !== null);
      if (headers.length === 0) return null;
      const labels = store.listAiLabels();
      const built = deps.withNonce((nonce) => sortInput(headers.map((header) => sourceMessageOf(store, header)), labels, { nonce }));
      // The frame numbers 1..n follow `parts`: a message cut by the cap is not among them.
      return { built, context: { labels }, ids: [...ids], made: { ids: built.parts.map((part) => part.messageId), labels } };
    },
    jobs: deps.jobs,
    context: deps.aiContext,
    done: (made, finished) => {
      const output = finished.output;
      if (output.kind !== "sort") return;
      const rows = output.value.items.flatMap((item) => {
        const messageId = made.ids[item.n - 1];
        return messageId === undefined ? [] : [{ messageId, summary: item.summary, labelIds: item.labelIds }];
      });
      if (rows.length === 0) return;
      const now = clock.now();
      store.saveMessageAi(rows, now.toISOString(), new Date(now.getTime() - MESSAGE_AI_DAYS * DAY_MS).toISOString());
      const auto = new Set(made.labels.filter((label) => label.autoArchive).map((label) => label.id));
      autoArchive(rows.filter((row) => row.labelIds.some((id) => auto.has(id))).map((row) => row.messageId));
      const accounts = new Set(rows.map((row) => store.getMessage(row.messageId)?.accountId).filter((id): id is string => id !== undefined));
      for (const accountId of accounts) deps.onChanged(accountId);
    },
    logCall: (built) => {
      const { provider, model } = deps.aiContext();
      deps.agentLog({
        actor: "owner_ai",
        tool: "ai_sort",
        outcome: "ok",
        messageIds: built.parts.map((part) => part.messageId),
        count: built.parts.length,
        hiddenCount: built.notes.hidden,
        provider,
        model,
      });
    },
    budget: new DraftBudget(clock, SORT_CALLS_PER_DAY),
    schedule: deps.schedule,
    log: deps.log,
  });

  const names = () => new Map(store.listAiLabels().map((label) => [label.id, label.name]));
  const shown = (ai: MessageAi | undefined, byId: ReadonlyMap<string, string>) =>
    ai === undefined ? {} : { aiSummary: ai.summary, aiLabels: ai.labelIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])) };

  return {
    /** A round's new Inbox messages that block rules and filters left. */
    offer(ids: readonly string[]): void {
      if (ids.length === 0 || !deps.enabled()) return;
      queue.offer(ids.filter((id) => qualifies(id) !== null));
    },

    /** The conversations with the line and labels of their newest sorted message. */
    withThreads<T extends ThreadSummary>(threads: T[]): T[] {
      if (threads.length === 0) return threads;
      const found = store.threadAi(threads.map((thread) => thread.id));
      if (found.size === 0) return threads;
      const byId = names();
      return threads.map((thread) => ({ ...thread, ...shown(found.get(thread.id), byId) }));
    },

    /** The messages with their own line and labels. */
    withMessages<T extends MessageHeader>(messages: T[]): T[] {
      if (messages.length === 0) return messages;
      const found = store.messageAi(messages.map((message) => message.id));
      if (found.size === 0) return messages;
      const byId = names();
      return messages.map((message) => ({ ...message, ...shown(found.get(message.id), byId) }));
    },

    labels: {
      list(): { labels: AiLabel[] } {
        return { labels: store.listAiLabels() };
      },
      /** Insert (no id) or update. Refusals: a bad name or description, a name taken, twelve already, an unknown id. */
      save(input: { id?: string | undefined; name: string; description: string; autoArchive: boolean }): { label: AiLabel } {
        const name = input.name.replace(/\s+/g, " ").trim();
        const description = input.description.replace(/\s+/g, " ").trim();
        const refusal = labelNameRefusal(name);
        if (refusal !== null) throw new AiSortRefusal("invalid", refusal);
        if (description === "") throw new AiSortRefusal("invalid", "Say what belongs under the label");
        if (description.length > LABEL_DESCRIPTION_CHARS) throw new AiSortRefusal("invalid", "A label's description has at most 300 characters");
        if (input.id !== undefined && !store.listAiLabels().some((label) => label.id === input.id)) throw new AiSortRefusal("not_found", "Unknown label");
        const label: AiLabel = { id: input.id ?? `ail_${deps.newId()}`, name, description, autoArchive: input.autoArchive };
        try {
          store.saveAiLabel(label, nowIso());
        } catch (error) {
          if (error instanceof AiLabelRefusal) throw new AiSortRefusal("conflict", error.message);
          throw error;
        }
        return { label };
      },
      remove(id: string): { ok: true } {
        if (!store.deleteAiLabel(id)) throw new AiSortRefusal("not_found", "Unknown label");
        return { ok: true };
      },
      move(id: string, direction: -1 | 1): { labels: AiLabel[] } {
        store.moveAiLabel(id, direction);
        return { labels: store.listAiLabels() };
      },
    },

    queue,
  };
}

export type AiSort = ReturnType<typeof createAiSort>;
