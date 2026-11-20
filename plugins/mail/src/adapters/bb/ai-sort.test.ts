import { beforeEach, describe, expect, it } from "vitest";
import type { LogEntryInput } from "../../core/agent-log.ts";
import type { SortItem } from "../../core/ai-sort.ts";
import { FixedClock, composeHarness, makeFetchedMessage } from "../../core/testing/fakes.ts";
import type { AiFinished, AiJobs } from "./ai-jobs.ts";
import { AUTO_ARCHIVES_PER_HOUR, createAiSort, type AiSort } from "./ai-sort.ts";

const NOW = "2026-11-20T10:00:00.000Z";
const toOwner = [{ name: null, address: "owner@example.org" }];
const folder = (path: string, specialUse: "inbox" | "sent" | "drafts" | "archive") => ({ path, name: path, delimiter: "/", specialUse, selectable: true, subscribed: true });

let store: ReturnType<typeof composeHarness>["store"];
let clock: FixedClock;
let enabled: boolean;
let warned: Set<string>;
let sent: { input: string; labels: string[] }[];
/** What the model answers for each call, in order. */
let answers: SortItem[][];
let logRows: LogEntryInput[];
let lines: string[];
let woken: string[];
let changed: string[];
let sort: AiSort;

const idOf = (messageId: string) =>
  (store as unknown as { state: { rows: { id: string; folder: string; message: { messageId: string | null } }[] } }).state.rows.find(
    (row) => row.folder === "INBOX" && row.message.messageId === messageId,
  )!.id;
const inbox = (uid: number, overrides: Parameters<typeof makeFetchedMessage>[1] = {}) => {
  store.upsertMessages("acc_1", "INBOX", [
    makeFetchedMessage(uid, { messageId: `in-${uid}@example.com`, from: { name: `Vendor ${uid}`, address: `sales${uid}@example.net` }, to: toOwner, subject: `Invented ${uid}`, bodyText: `Invented body ${uid}.`, date: "2026-11-20T09:00:00.000Z", ...overrides }),
  ]);
  return idOf(`in-${uid}@example.com`);
};
const pendingOf = (id: string) => store.notifyRows([id], NOW)[0]?.movePending ?? null;

beforeEach(() => {
  const harness = composeHarness({ now: NOW });
  store = harness.store;
  store.saveFolders("acc_1", [folder("INBOX", "inbox"), folder("Drafts", "drafts"), folder("Sent", "sent"), folder("Archive", "archive")]);
  clock = new FixedClock(new Date(NOW));
  enabled = true;
  warned = new Set();
  sent = [];
  answers = [];
  logRows = [];
  lines = [];
  woken = [];
  changed = [];
  let calls = 0;
  const finished = new Map<string, AiFinished>();
  const jobs = {
    start: (_kind: string, built: { input: string; parts: AiFinished["parts"] }, ctx: { labels?: { name: string }[] }) => {
      const jobId = `job-${++calls}`;
      sent.push({ input: built.input, labels: (ctx.labels ?? []).map((label) => label.name) });
      finished.set(jobId, {
        output: { kind: "sort", value: { items: answers.shift() ?? [] } },
        parts: built.parts,
        notes: { hidden: 0, leftOut: 0, truncated: 0, unreadItems: 0 },
        provider: "provider-x",
        model: "model-y",
        createdAt: NOW,
      });
      return { jobId };
    },
    settled: async () => {},
    poll: () => null,
    finished: (jobId: string) => finished.get(jobId) ?? null,
    cancel: () => false,
  } as unknown as Pick<AiJobs, "start" | "settled" | "poll" | "finished" | "cancel">;
  let ids = 0;
  sort = createAiSort({
    store,
    clock,
    enabled: () => enabled,
    aiContext: () => ({ provider: "", model: "" }),
    jobs,
    withNonce: (build) => build("0123456789abcdef"),
    suspicious: (messageId) => warned.has(messageId),
    agentLog: (entry) => logRows.push(entry),
    onChanged: (accountId) => changed.push(accountId),
    wake: (accountId) => woken.push(accountId),
    newId: () => `id${++ids}`,
    schedule: () => () => {},
    log: (line) => lines.push(line),
  });
});

describe("createAiSort", () => {
  it("sorts new Inbox mail inside AI access: no address is sent, the line and labels are kept and shown by name", async () => {
    const pitch = sort.labels.save({ name: "Pitch", description: "Cold sales offers.", autoArchive: false }).label;
    const first = inbox(1);
    const own = inbox(2, { from: { name: null, address: "owner@example.org" } });
    const empty = inbox(3, { bodyText: null, bodyHtml: null });
    answers.push([{ n: 1, summary: "A vendor offers widgets.", labelIds: [pitch.id] }]);
    sort.offer([first, own, empty, "no-such-message"]);
    await sort.queue.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.labels).toEqual(["Pitch"]);
    expect(sent[0]!.input).toContain("Invented body 1.");
    expect(sent[0]!.input).toContain("Vendor 1 (example.net)");
    expect(sent[0]!.input).not.toContain("sales1@example.net");
    expect(sent[0]!.input).not.toContain("Invented body 2.");
    expect(store.messageAi([first]).get(first)).toEqual({ summary: "A vendor offers widgets.", labelIds: [pitch.id] });
    const header = store.getMessage(first)!;
    expect(sort.withMessages([header])[0]).toMatchObject({ aiSummary: "A vendor offers widgets.", aiLabels: ["Pitch"] });
    const thread = store.listThreads("acc_1", "INBOX", null, 50).threads.find((t) => t.id === header.threadId)!;
    expect(sort.withThreads([thread])[0]).toMatchObject({ aiSummary: "A vendor offers widgets.", aiLabels: ["Pitch"] });
    // Not archived: the label is not marked.
    expect(pendingOf(first)).toBeNull();
    expect(logRows).toEqual([{ actor: "owner_ai", tool: "ai_sort", outcome: "ok", messageIds: [first], count: 1, hiddenCount: 0, provider: "", model: "" }]);
    expect(changed).toEqual(["acc_1"]);
    expect(lines.join("\n")).not.toContain("Invented");
  });

  it("does nothing while the setting is off", async () => {
    enabled = false;
    sort.offer([inbox(1)]);
    await sort.queue.idle();
    expect(sent).toEqual([]);
  });

  it("archives what a marked label asks for, except mail from someone the owner wrote to, flagged mail and mail Mail warns about", async () => {
    const pitch = sort.labels.save({ name: "Pitch", description: "Cold sales offers.", autoArchive: true }).label;
    store.upsertMessages("acc_1", "Sent", [
      makeFetchedMessage(90, { messageId: "sent-90@example.org", from: { name: null, address: "owner@example.org" }, to: [{ name: null, address: "ann@example.com" }], bodyText: "Invented earlier note." }),
    ]);
    const cold = inbox(1);
    const known = inbox(2, { from: { name: "Ann", address: "ann@example.com" } });
    const flagged = inbox(3, { flagged: true });
    const suspect = inbox(4);
    const unlabelled = inbox(5);
    warned.add(suspect);
    answers.push([1, 2, 3, 4].map((n) => ({ n, summary: `Line ${n}.`, labelIds: [pitch.id] })).concat([{ n: 5, summary: "Line 5.", labelIds: [] }]));
    sort.offer([cold, known, flagged, suspect, unlabelled]);
    await sort.queue.idle();
    expect(pendingOf(cold)).toBe("Archive");
    for (const id of [known, flagged, suspect, unlabelled]) expect(pendingOf(id), id).toBeNull();
    expect(logRows.map((row) => [row.tool, row.messageIds])).toEqual([
      ["ai_sort", [cold, known, flagged, suspect, unlabelled]],
      ["ai_archive", [cold]],
    ]);
    expect(woken).toEqual(["acc_1"]);
    // The label stays on what was left in the Inbox.
    expect(store.messageAi([known]).get(known)?.labelIds).toEqual([pitch.id]);
  });

  it("archives at most fifty an hour; the rest keep the label and stay", async () => {
    const pitch = sort.labels.save({ name: "Pitch", description: "Cold sales offers.", autoArchive: true }).label;
    const ids = Array.from({ length: 60 }, (_, i) => inbox(i + 1));
    for (let call = 0; call < 6; call++) answers.push(Array.from({ length: 10 }, (_, i) => ({ n: i + 1, summary: null, labelIds: [pitch.id] })));
    sort.offer(ids);
    await sort.queue.idle();
    expect(sent).toHaveLength(6);
    expect(AUTO_ARCHIVES_PER_HOUR).toBe(50);
    expect(ids.filter((id) => pendingOf(id) === "Archive")).toHaveLength(50);
    expect(store.messageAi(ids).size).toBe(60);
  });

  it("keeps the owner's labels: a clean name and description, no repeats, an unknown id refused", () => {
    const saved = sort.labels.save({ name: "  Needs   reply ", description: " Someone asks me\nsomething. ", autoArchive: false }).label;
    expect(saved).toEqual({ id: "ail_id1", name: "Needs reply", description: "Someone asks me something.", autoArchive: false });
    expect(() => sort.labels.save({ name: "needs reply", description: "x", autoArchive: false })).toThrow("Another AI label has this name");
    expect(() => sort.labels.save({ name: "a:b", description: "x", autoArchive: false })).toThrow("cannot hold a comma, a quote or a colon");
    expect(() => sort.labels.save({ name: "Ok", description: "  ", autoArchive: false })).toThrow("Say what belongs under the label");
    expect(() => sort.labels.save({ name: "Ok", description: "x".repeat(301), autoArchive: false })).toThrow("at most 300 characters");
    expect(() => sort.labels.save({ id: "gone", name: "Ok", description: "x", autoArchive: false })).toThrow("Unknown label");
    sort.labels.save({ id: saved.id, name: "Reply", description: "Changed.", autoArchive: true });
    const second = sort.labels.save({ name: "Invoice", description: "Bills.", autoArchive: false }).label;
    expect(sort.labels.move(second.id, -1).labels.map((label) => label.name)).toEqual(["Invoice", "Reply"]);
    expect(sort.labels.remove(second.id)).toEqual({ ok: true });
    expect(() => sort.labels.remove(second.id)).toThrow("Unknown label");
    expect(sort.labels.list()).toEqual({ labels: [{ id: saved.id, name: "Reply", description: "Changed.", autoArchive: true }] });
  });
});
